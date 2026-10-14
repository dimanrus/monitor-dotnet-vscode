/**
 * Панель Performance: графики CPU, сборки мусора и памяти.
 *
 * Панель — это webview-вид VS Code. Данные и тексты расширение отправляет сообщениями:
 * полный снимок при первом показе и при смене процесса, далее — только новые точки.
 * Тексты передаются потому, что внутри webview нет API локализации VS Code.
 */

import * as vscode from 'vscode';
import {
  buildChartMeta,
  CHART_HISTORY_LIMIT,
  toChartGcEvent,
  toChartPoint,
  type ChartGcEvent,
  type ChartIssue,
  type ChartMeta,
  type ChartPoint,
} from '../core/chartData.ts';
import type { TargetGroups } from '../core/targetChoices.ts';
import { clampToData, paddedRange } from '../core/chartView.ts';
import type { IssueSlice } from '../core/issueStore.ts';
import type { MonitorState } from '../core/monitorState.ts';
import { buildWebviewStrings, type WebviewStrings } from '../core/webviewStrings.ts';
import { translate } from '../core/locale.ts';
import type { Logger } from '../logger.ts';

/** Как часто панель перечитывает список целей, пока она видна. */
const TARGETS_POLL_INTERVAL_MS = 10_000;

/**
 * Всё, что панели нужно от расширения: цели мониторинга и переход к проблеме.
 * Список целей собирает расширение: у панели нет доступа к процессам и сессиям отладки.
 */
export interface PerformancePanelOptions {
  /** Возвращает сессии отладки и процессы .NET. */
  listTargets: () => Promise<TargetGroups>;
  /** Переключает мониторинг на выбранную цель (значение вида `session:<id>` или `pid:<pid>`). */
  selectTarget: (value: string) => void | Promise<void>;
  /** Показывает интервал проблемы, выбранной в списке панели. */
  revealIssue: (issue: IssueIntervalRequest) => void | Promise<void>;
}

/** Интервал проблемы, выбранной в списке панели. */
export interface IssueIntervalRequest {
  issueId: string;
  fromMs: number;
  toMs: number;
}

/** Значения по умолчанию: панель без связи с расширением (например, в тестах). */
const defaultOptions: PerformancePanelOptions = {
  listTargets: async () => ({ sessions: [], processes: [] }),
  selectTarget: () => undefined,
  revealIssue: () => undefined,
};

/** Сообщение из webview. */
interface WebviewMessage {
  type?: string;
  message?: string;
  points?: number;
  canvases?: string;
  painted?: boolean;
  issues?: number;
  /** Выбранная в панели цель мониторинга. */
  target?: string;
  /** Проблема, выбранная в списке панели. */
  issueId?: string;
  fromMs?: number;
  toMs?: number;
}

export class PerformanceChartPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  /** Идентификатор вида из package.json. */
  public static readonly viewType = 'monitor-dotnet.performance';

  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;

  /** Сколько точек уже отправлено в webview и время последней из них. */
  private sentCount = 0;
  private sentLastTime = 0;
  /** Номер поколения данных: меняется при очистке и смене процесса. */
  private sentGeneration = -1;
  /** Тексты для панели: собираются один раз, чтобы не переводить строки на каждом снимке. */
  private strings: WebviewStrings = buildWebviewStrings(translate);

  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** Таймер обновления списка целей: процессы появляются и исчезают без событий сессий. */
  private targetsTimer: ReturnType<typeof setInterval> | undefined;
  /** Очередь обновлений списка целей: обновления не должны обгонять друг друга. */
  private targetsQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: MonitorState,
    private readonly getWindowSeconds: () => number,
    private readonly getRefreshIntervalSeconds: () => number,
    /** Проблемы для показа: найденные сейчас и сохранённые при смене процесса. */
    private readonly listIssues: () => ChartIssue[],
    private readonly logger: Logger,
    private readonly options: PerformancePanelOptions = defaultOptions,
  ) {
    this.disposables.push({ dispose: this.state.onDidChange(() => this.scheduleFlush()) });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.strings = buildWebviewStrings(translate);
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage(message => this.handleMessage(message as WebviewMessage));

    this.disposables.push(
      view.onDidChangeVisibility(() => {
        // Свёрнутая панель не опрашивает процессы: список целей обновляем при показе.
        this.updateTargetPolling();
        if (view.visible) {
          // Возвращаем панель в актуальное состояние после сворачивания.
          void this.refreshTargets();
          this.sendSnapshot();
        }
      }),
      view.onDidDispose(() => {
        this.view = undefined;
        this.updateTargetPolling();
      }),
    );

    this.updateTargetPolling();
  }

  /**
   * Обновляет список целей в панели.
   * Список живой: приложения запускаются и завершаются, поэтому его перечитывают по таймеру.
   *
   * Обновления идут строго по очереди: сбор списка асинхронный, и при нескольких
   * одновременных вызовах сообщения приходили бы не по порядку — панель показывала бы
   * устаревший состав целей.
   */
  refreshTargets(): Promise<void> {
    this.targetsQueue = this.targetsQueue.then(() => this.postTargets());
    return this.targetsQueue;
  }

  /** Отправляет панели текущий список целей. */
  private async postTargets(): Promise<void> {
    const view = this.view;
    if (view === undefined) {
      return;
    }

    const groups = await this.options.listTargets();
    if (this.view === view && view.visible) {
      await view.webview.postMessage({ type: 'targets', groups, strings: this.strings });
    }
  }

  /** Передаёт в панель текущую цель, чтобы список не расходился с состоянием монитора. */
  private updateTargetPolling(): void {
    const shouldPoll = this.view?.visible === true;
    if (shouldPoll && this.targetsTimer === undefined) {
      this.targetsTimer = setInterval(() => void this.refreshTargets(), TARGETS_POLL_INTERVAL_MS);
      this.targetsTimer.unref?.();
    } else if (!shouldPoll && this.targetsTimer !== undefined) {
      clearInterval(this.targetsTimer);
      this.targetsTimer = undefined;
    }
  }

  /**
   * Просит панель выделить интервал — так дерево проблем показывает найденное место на графиках.
   * Панель при этом раскрывается: иначе выделение осталось бы невидимым.
   */
  async selectInterval(fromMs: number, toMs: number): Promise<void> {
    await vscode.commands.executeCommand(`${PerformanceChartPanel.viewType}.focus`);
    const view = this.view;
    if (view === undefined) {
      return;
    }

    await view.webview.postMessage({ type: 'selectRange', fromMs, toMs });
  }

  /**
   * Показывает сохранённый интервал проблемы.
   * Живой ряд к этому моменту ушёл вперёд, поэтому графики рисуются по сохранённым
   * точкам: иначе выделенный диапазон остался бы пустым и анализировать было бы нечего.
   */
  async showIssueSlice(processLabel: string, slice: IssueSlice): Promise<void> {
    await vscode.commands.executeCommand(`${PerformanceChartPanel.viewType}.focus`);
    const view = this.view;
    if (view === undefined) {
      return;
    }

    const { issue } = slice;
    // Небольшой запас по краям, но не шире сохранённых точек: за ними линий нет,
    // и по краям графика осталось бы пустое место.
    const range = clampToData(paddedRange({ fromMs: issue.fromMs, toMs: issue.toMs }), slice.points);
    await view.webview.postMessage({
      type: 'issueSlice',
      meta: this.buildMeta(),
      processLabel,
      issue,
      points: slice.points,
      gcEvents: slice.gcEvents,
      fromMs: issue.fromMs,
      toMs: issue.toMs,
      viewFromMs: range.fromMs,
      viewToMs: range.toMs,
      generation: this.state.generation,
      strings: this.strings,
      locale: vscode.env.language,
    });
  }

  /** Передаёт в панель новые данные, если вид сейчас показан. */
  sync(): void {
    const view = this.view;
    if (view === undefined || !view.visible) {
      return;
    }

    const points = this.buildPoints();
    const gcEvents = this.buildGcEvents();

    if (this.sentGeneration !== this.state.generation || points.length < this.sentCount) {
      this.sendSnapshot();
      return;
    }

    const fresh = points.filter(point => point.t > this.sentLastTime);
    if (fresh.length === 0) {
      // Данных пока нет, но шапка может требовать обновления.
      void view.webview.postMessage({
        type: 'meta',
        meta: this.buildMeta(),
        issues: this.buildIssues(),
        generation: this.state.generation,
        strings: this.strings,
        locale: vscode.env.language,
      });
      return;
    }

    this.sentCount = points.length;
    this.sentLastTime = fresh[fresh.length - 1].t;
    void view.webview.postMessage({
      type: 'append',
      points: fresh,
      gcEvents: gcEvents.filter(event => event.t > this.sentLastTime - this.windowMs()),
      issues: this.buildIssues(),
      meta: this.buildMeta(),
      generation: this.state.generation,
      strings: this.strings,
      locale: vscode.env.language,
    });
  }

  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
    }

    if (this.targetsTimer !== undefined) {
      clearInterval(this.targetsTimer);
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Сообщения из webview. */
  private handleMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'ready':
        // Панель загрузила скрипты и готова принимать данные: значит разметка и политика безопасности верны.
        this.logger.info(translate('Charts panel is ready, sending data.'));
        this.sendSnapshot();
        void this.refreshTargets();
        return;

      case 'selectTarget':
        // Пользователь выбрал другой процесс: переключаем мониторинг на него.
        if (typeof message.target === 'string' && message.target.length > 0) {
          void this.options.selectTarget(message.target);
        }

        return;

      case 'revealIssue':
        // Пользователь нажал на найденную проблему в списке панели.
        if (typeof message.issueId === 'string' && typeof message.fromMs === 'number' && typeof message.toMs === 'number') {
          void this.options.revealIssue({ issueId: message.issueId, fromMs: message.fromMs, toMs: message.toMs });
        }

        return;

      case 'requestSnapshot':
        this.sendSnapshot();
        return;

      case 'rendered':
        // Подтверждение от панели: данные дошли и графики нарисованы.
        this.logger.info(translate(
          'Charts panel: points drawn — {0}, canvas sizes [{1}], pixels painted: {2}, issues shown: {3}.',
          message.points ?? 0,
          message.canvases ?? '—',
          message.painted === true ? translate('yes') : translate('no'),
          message.issues ?? 0,
        ));
        return;

      case 'problem':
        // Панель сообщает о сбое отрисовки — пишем в журнал, чтобы проблема не потерялась.
        this.logger.error(translate('Charts panel: {0}', message.message ?? translate('unknown error')));
        return;

      default:
        this.logger.warn(translate('Charts panel sent an unknown message: {0}', JSON.stringify(message)));
        return;
    }
  }

  /** Отправляет полный снимок данных. */
  private sendSnapshot(): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }

    const points = this.buildPoints();
    this.logger.info(translate('Charts panel: points sent — {0}.', points.length));
    this.sentCount = points.length;
    this.sentLastTime = points.length > 0 ? points[points.length - 1].t : 0;
    this.sentGeneration = this.state.generation;

    void view.webview.postMessage({
      type: 'snapshot',
      meta: this.buildMeta(),
      points,
      gcEvents: this.buildGcEvents().slice(-CHART_HISTORY_LIMIT),
      issues: this.buildIssues(),
      generation: this.state.generation,
      strings: this.strings,
      locale: vscode.env.language,
    });
  }

  /** Собирает точки графика из состояния (не больше предела истории). */
  private buildPoints(): ChartPoint[] {
    const series = this.state.series;
    const from = Math.max(0, series.length - CHART_HISTORY_LIMIT);
    return series.slice(from).map(toChartPoint);
  }

  /** Собирает события GC для отметок на графике. */
  private buildGcEvents(): ChartGcEvent[] {
    const result: ChartGcEvent[] = [];
    for (const event of this.state.gcEvents) {
      const converted = toChartGcEvent(event);
      if (converted !== undefined) {
        result.push(converted);
      }
    }

    return result;
  }

  /**
   * Проблемы для панели: найденные сейчас и сохранённые при смене процесса.
   * Список ведёт накопитель, поэтому он не пустеет на каждом обновлении данных.
   */
  private buildIssues(): ChartIssue[] {
    return this.listIssues();
  }

  private buildMeta(): ChartMeta {
    const latest = this.state.latest;
    return buildChartMeta(
      this.state.hello,
      this.state.status,
      this.state.statusHint ?? this.state.lastError ?? null,
      this.getRefreshIntervalSeconds(),
      this.getWindowSeconds(),
      latest?.gcCollections ?? { gen0: 0, gen1: 0, gen2: 0 },
    );
  }

  private windowMs(): number {
    return Math.max(1, this.getWindowSeconds()) * 1000;
  }

  /** Склеивает частые изменения в одно обновление. */
  private scheduleFlush(): void {
    if (this.flushTimer !== undefined || this.view === undefined || !this.view.visible) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.sync();
    }, 150);
  }

  /** Разметка панели: шапка, плитки, область графиков и сводка по выделению. */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'charts.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'charts.css'));

    // Строгая политика: только собственные скрипты и стили, без внешних источников.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Monitor Dotnet: Performance</title>
</head>
<body>
  <header>
    <div class="process-head">
      <div class="process-name" id="process-name">${translate('No process selected')}</div>
      <div class="controls">
        <button id="pause" type="button" aria-pressed="false">${translate('Pause')}</button>
        <button id="reset-selection" type="button">${translate('Reset selection')}</button>
      </div>
    </div>
    <div class="process-details" id="process-details"></div>
    <label class="target" for="target">
      <span class="target-label">${translate('Process')}</span>
      <select id="target" aria-label="${translate('Process to monitor')}"></select>
    </label>
  </header>
  <section class="archive" id="archive" hidden>
    <div class="archive-text" id="archive-text"></div>
    <button id="archive-exit" type="button">${translate('Back to live data')}</button>
  </section>
  <section class="cards" id="cards"></section>
  <section class="issues" id="issues" hidden></section>
  <section class="charts" id="charts"></section>
  <section class="summary" id="summary" hidden></section>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Случайная строка для атрибута nonce в политике безопасности. */
function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 32; index++) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return result;
}
