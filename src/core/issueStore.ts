/**
 * Накопитель найденных проблем: проблемы хранятся по процессам.
 *
 * Проблемы считаются по данным текущего процесса, а при смене процесса данные монитора
 * очищаются. Чтобы найденные интервалы не пропадали в этот момент, они остаются здесь:
 * панель графиков показывает проблемы того процесса, чьи данные на графиках,
 * а дерево «Проблемы» — все процессы с их интервалами.
 *
 * Вместе с проблемой сохраняются и точки её интервала: живые графики уходят вперёд,
 * и без этого выделенный интервал было бы нечем показать.
 *
 * Логика не зависит от API VS Code, поэтому её проверяют тесты.
 */

import { toChartGcEvent, toChartPoint, type ChartGcEvent, type ChartIssue, type ChartPoint } from './chartData.ts';
import type { ProcessSeriesPoint } from './monitorState.ts';
import type { BridgeGcEventValue } from './protocol.ts';

/** Сколько проблем хранится одновременно: список не должен расти без предела. */
export const ISSUE_HISTORY_LIMIT = 50;

/** Запас точек по краям интервала: видно, что было до проблемы и что после. */
export const ISSUE_SLICE_PADDING_MS = 5000;

/** Предел точек в сохранённом интервале: защита памяти при очень мелком периоде сбора. */
export const ISSUE_SLICE_MAX_POINTS = 1500;

/** Процесс, в котором найдены проблемы. */
export interface IssueProcess {
  /** Ключ процесса: по нему проблемы разных процессов не путаются. */
  key: string;
  /** Подпись для дерева: имя процесса с PID. */
  label: string;
  /** Проблемы процесса, от свежих к старым. */
  issues: ChartIssue[];
  /** Мониторится ли процесс сейчас: только его интервалы есть на графиках. */
  isCurrent: boolean;
}

/** Процесс, данные которого сейчас собирает монитор. */
export interface MonitoredProcess {
  key: string;
  label: string;
}

/** Сохранённый интервал проблемы: данные, чтобы показать его после ухода живого ряда. */
export interface IssueSlice {
  /** Проблема, к которой относится интервал. */
  issue: ChartIssue;
  /** Точки интервала и небольшого запаса по краям. */
  points: ChartPoint[];
  /** События GC внутри того же интервала. */
  gcEvents: ChartGcEvent[];
}

/** Проблемы одного процесса: ключ — идентификатор, поэтому повторный поиск их уточняет. */
interface ProcessEntry {
  label: string;
  issues: Map<string, ChartIssue>;
}

/** Данные монитора, по которым собираются сохранённые интервалы. */
export interface IssueStoreSource {
  points: readonly ProcessSeriesPoint[];
  gcEvents: readonly BridgeGcEventValue[];
}

export class IssueStore {
  private readonly byProcess = new Map<string, ProcessEntry>();
  /** Сохранённые данные интервалов: процесс → проблема → точки и события. */
  private readonly slices = new Map<string, Map<string, IssueSlice>>();
  private readonly collectLive: () => ChartIssue[];
  private readonly isEnabled: () => boolean;
  private readonly monitoredProcess: () => MonitoredProcess | undefined;
  private readonly readSource: () => IssueStoreSource;

  constructor(
    /** Проблемы текущих данных монитора (пустой список, если поиск выключен). */
    collectLive: () => ChartIssue[],
    /** Включён ли поиск проблем в настройках. */
    isEnabled: () => boolean,
    /** Процесс, чьи данные сейчас на графиках, или undefined, пока он неизвестен. */
    monitoredProcess: () => MonitoredProcess | undefined,
    /** Данные монитора: по ним сохраняются точки найденных интервалов. */
    readSource: () => IssueStoreSource,
  ) {
    this.collectLive = collectLive;
    this.isEnabled = isEnabled;
    this.monitoredProcess = monitoredProcess;
    this.readSource = readSource;
  }

  /**
   * Проблемы процесса, данные которого сейчас на графиках.
   * Пустой список, если поиск выключен или проблем у процесса ещё нет.
   */
  current(): ChartIssue[] {
    const entry = this.collectCurrent();
    return entry === undefined ? [] : sorted(entry.issues);
  }

  /**
   * Все процессы с найденными проблемами: текущий первым, затем по свежести проблем.
   * Список нужен дереву, которое группирует проблемы по процессам.
   */
  groups(): IssueProcess[] {
    this.collectCurrent();
    if (!this.isEnabled()) {
      return [];
    }

    const currentKey = this.monitoredProcess()?.key;
    return [...this.byProcess.entries()]
      .map(([key, entry]) => ({
        key,
        label: entry.label,
        issues: sorted(entry.issues),
        isCurrent: key === currentKey,
      }))
      .filter(group => group.issues.length > 0)
      .sort((left, right) =>
        left.isCurrent === right.isCurrent
          ? newest(right.issues) - newest(left.issues)
          : Number(right.isCurrent) - Number(left.isCurrent),
      );
  }

  /** Относится ли проблема к процессу, данные которого сейчас на графиках. */
  isCurrentProcess(processKey: string): boolean {
    return this.monitoredProcess()?.key === processKey;
  }

  /** Подпись процесса с проблемами: нужна для сообщений о сохранённом интервале. */
  label(processKey: string): string | undefined {
    return this.byProcess.get(processKey)?.label;
  }

  /**
   * Сохранённые данные интервала проблемы.
   * Пусто, если проблема неизвестна: значит, данные для неё не сохранялись.
   */
  slice(processKey: string, issueId: string): IssueSlice | undefined {
    return this.slices.get(processKey)?.get(issueId);
  }

  /** Забывает найденные проблемы: вызывается, когда начинается новый прогон отладки. */
  clear(): void {
    this.byProcess.clear();
    this.slices.clear();
  }

  /**
   * Проблемы текущих данных: обновляют уже найденные проблемы того же процесса,
   * потому что при поступлении новых точек интервалы уточняются.
   */
  private collectCurrent(): ProcessEntry | undefined {
    if (!this.isEnabled()) {
      return undefined;
    }

    const process = this.monitoredProcess();
    if (process === undefined) {
      return undefined;
    }

    let entry = this.byProcess.get(process.key);
    if (entry === undefined) {
      entry = { label: process.label, issues: new Map<string, ChartIssue>() };
      this.byProcess.set(process.key, entry);
    }

    for (const issue of this.collectLive()) {
      const previous = entry.issues.get(issue.id);
      entry.issues.set(issue.id, issue);
      // Интервал уточняется по мере поступления точек: сохраняем данные, пока они у монитора.
      if (previous === undefined || previous.toMs !== issue.toMs) {
        this.captureSlice(process.key, issue);
      }
    }

    this.trim();
    return entry;
  }

  /**
   * Сохраняет точки интервала проблемы.
   * Данные объединяются с уже сохранёнными: интервал растёт, а старые точки к этому
   * моменту могут быть вытеснены из ряда монитора.
   */
  private captureSlice(processKey: string, issue: ChartIssue): void {
    const source = this.readSource();
    const fromMs = issue.fromMs - ISSUE_SLICE_PADDING_MS;
    const toMs = issue.toMs + ISSUE_SLICE_PADDING_MS;
    const kept = this.slices.get(processKey)?.get(issue.id);

    const points = new Map<number, ChartPoint>();
    for (const point of kept?.points ?? []) {
      points.set(point.t, point);
    }

    for (const point of source.points) {
      if (point.timestampMs >= fromMs && point.timestampMs <= toMs) {
        const converted = toChartPoint(point);
        points.set(converted.t, converted);
      }
    }

    const gcEvents = new Map<string, ChartGcEvent>();
    for (const event of kept?.gcEvents ?? []) {
      gcEvents.set(gcEventKey(event), event);
    }

    for (const event of source.gcEvents) {
      const converted = toChartGcEvent(event);
      if (converted !== undefined && converted.t >= fromMs && converted.t <= toMs) {
        gcEvents.set(gcEventKey(converted), converted);
      }
    }

    const slice: IssueSlice = {
      issue,
      points: [...points.values()].sort((left, right) => left.t - right.t).slice(-ISSUE_SLICE_MAX_POINTS),
      gcEvents: [...gcEvents.values()].sort((left, right) => left.t - right.t).slice(-ISSUE_SLICE_MAX_POINTS),
    };

    let byProcess = this.slices.get(processKey);
    if (byProcess === undefined) {
      byProcess = new Map<string, IssueSlice>();
      this.slices.set(processKey, byProcess);
    }

    byProcess.set(issue.id, slice);
  }

  /** Вытесняет самые старые проблемы, если список перерос предел. */
  private trim(): void {
    let excess = this.totalIssues() - ISSUE_HISTORY_LIMIT;
    if (excess <= 0) {
      return;
    }

    const oldestFirst = [...this.byProcess.entries()]
      .flatMap(([key, entry]) => [...entry.issues.values()].map(issue => ({ key, issue })))
      .sort((left, right) => left.issue.toMs - right.issue.toMs);

    for (const oldest of oldestFirst) {
      if (excess <= 0) {
        break;
      }

      const entry = this.byProcess.get(oldest.key);
      if (entry === undefined || !entry.issues.delete(oldest.issue.id)) {
        continue;
      }

      this.slices.get(oldest.key)?.delete(oldest.issue.id);
      excess--;
      if (entry.issues.size === 0) {
        this.byProcess.delete(oldest.key);
        this.slices.delete(oldest.key);
      }
    }
  }

  private totalIssues(): number {
    let total = 0;
    for (const entry of this.byProcess.values()) {
      total += entry.issues.size;
    }

    return total;
  }
}

/** Проблемы процесса от свежих к старым. */
function sorted(issues: Map<string, ChartIssue>): ChartIssue[] {
  return [...issues.values()].sort((left, right) => right.toMs - left.toMs);
}

/** Ключ события GC в сохранённом интервале: время и поколение. */
function gcEventKey(event: ChartGcEvent): string {
  return `${event.t}:${event.gen}`;
}

/** Время самой свежей проблемы: по нему процессы упорядочены между собой. */
function newest(issues: readonly ChartIssue[]): number {
  return issues.length === 0 ? 0 : issues[0].toMs;
}
