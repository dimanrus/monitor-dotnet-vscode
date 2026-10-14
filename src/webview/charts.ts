/**
 * Логика панели графиков (выполняется внутри webview).
 *
 * Задачи модуля:
 *  - хранить полученные от расширения точки и события GC;
 *  - рисовать графики CPU, GC и памяти на canvas;
 *  - показывать подсказки, выделять диапазон и считать по нему сводку;
 *  - подстраиваться под тему VS Code и размер панели.
 *
 * Данные и тексты приходят сообщениями: `snapshot` (полная замена), `append` (добавка точек), `meta`.
 * Тексты присылает расширение, потому что внутри webview нет API локализации VS Code.
 */

import {
  buildChartMeta,
  type ChartGcEvent,
  type ChartIssue,
  type ChartMeta,
  type ChartPoint,
} from '../core/chartData.ts';
import {
  formatBytes,
  formatClockTime,
  formatDuration,
  formatNumber,
  formatPercent,
} from '../core/formatting.ts';
import { archiveReplaced, liveVisibleRange, type TimeRange } from '../core/chartView.ts';
import { configureLocale, formatTemplate, word } from '../core/locale.ts';
import { DEFAULT_WEBVIEW_STRINGS, type WebviewStrings } from '../core/webviewStrings.ts';
import type { TargetEntry, TargetGroups } from '../core/targetChoices.ts';
import { resolveCanvasColor } from './colors.ts';
import { drawChart, type ChartPalette, type ChartSpec, type ChartView } from './render.ts';
import './charts.css';

/** Сообщение от расширения. */
type IncomingMessage =
  | {
      type: 'snapshot';
      meta: ChartMeta;
      points: ChartPoint[];
      gcEvents: ChartGcEvent[];
      issues?: ChartIssue[];
      generation?: number;
      strings?: WebviewStrings;
      locale?: string;
    }
  | {
      type: 'append';
      points: ChartPoint[];
      gcEvents: ChartGcEvent[];
      meta?: ChartMeta;
      issues?: ChartIssue[];
      generation?: number;
      strings?: WebviewStrings;
      locale?: string;
    }
  | {
      type: 'meta';
      meta: ChartMeta;
      issues?: ChartIssue[];
      generation?: number;
      strings?: WebviewStrings;
      locale?: string;
    }
  | { type: 'selectRange'; fromMs: number; toMs: number; locale?: string }
  | {
      type: 'issueSlice';
      meta: ChartMeta;
      processLabel: string;
      issue: ChartIssue;
      points: ChartPoint[];
      gcEvents: ChartGcEvent[];
      fromMs: number;
      toMs: number;
      viewFromMs: number;
      viewToMs: number;
      generation?: number;
      strings?: WebviewStrings;
      locale?: string;
    }
  | { type: 'targets'; groups: TargetGroups; strings?: WebviewStrings; locale?: string };

/** Сообщение в расширение. */
type OutgoingMessage =
  | { type: 'ready' }
  | { type: 'requestSnapshot' }
  | { type: 'problem'; message: string }
  | { type: 'rendered'; points: number; canvases: string; painted: boolean; issues: number }
  | { type: 'selectTarget'; target: string }
  | { type: 'revealIssue'; issueId: string; fromMs: number; toMs: number };

interface VsCodeApi {
  postMessage(message: OutgoingMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** Верхняя граница числа хранимых точек: защита от роста памяти при очень широком окне. */
const MAX_POINTS = 6000;

/** Данные и настройки панели. */
const state = {
  points: [] as ChartPoint[],
  gcEvents: [] as ChartGcEvent[],
  /** Найденные проблемы производительности: показываются списком и полосами на графиках. */
  issues: [] as ChartIssue[],
  /** Цели мониторинга: сессии отладки и процессы .NET. */
  targets: { sessions: [], processes: [] } as TargetGroups,
  /** Значение, выбранное в списке целей: сообщение о выборе отправляется только при смене. */
  selectedTarget: '',
  meta: buildChartMeta(undefined, 'idle', null, 1, 120, { gen0: 0, gen1: 0, gen2: 0 }),
  /** Окно отображения в секундах: сколько времени показывать на графиках. */
  windowSeconds: 120,
  paused: false,
  /**
   * Сохранённый интервал проблемы, когда живые графики уже ушли вперёд.
   * Пока он открыт, графики рисуются по этим точкам, а живые данные копятся в фоне.
   */
  archive: null as {
    points: ChartPoint[];
    gcEvents: ChartGcEvent[];
    issues: ChartIssue[];
    meta: ChartMeta;
    label: string;
    fromMs: number;
    toMs: number;
    viewFromMs: number;
    viewToMs: number;
    generation: number;
  } | null,
  selection: null as { from: number; to: number } | null,
  hoverT: null as number | null,
  hoverChart: '' as string,
  dragging: null as { chartId: string; fromT: number; toT: number } | null,
  strings: DEFAULT_WEBVIEW_STRINGS,
};

/** Ссылки на созданные элементы графиков. */
interface ChartElements {
  spec: ChartSpec;
  canvas: HTMLCanvasElement;
  tooltip: HTMLElement;
}

const charts: ChartElements[] = [];
let redrawQueued = false;

/** Описание графиков: подписи берутся из переданных текстов. */
function buildSpecs(strings: WebviewStrings): ChartSpec[] {
  return [
    {
      id: 'cpu',
      title: strings.chartCpuTitle,
      format: value => formatPercent(value, 0),
      fixedMax: 100,
      series: [{ key: 'cpu', label: strings.legendCpu, color: 'var(--chart-cpu)', style: 'area' }],
    },
    {
      id: 'gc',
      title: strings.chartGcTitle,
      format: value => `${formatBytes(value, 0)}/${word('secondShort')}`,
      showGcMarkers: true,
      series: [{ key: 'alloc', label: strings.legendAllocation, color: 'var(--chart-allocation)', style: 'area' }],
    },
    {
      id: 'memory',
      title: strings.chartMemoryTitle,
      format: value => formatBytes(value, 0),
      series: [
        { key: 'priv', label: strings.legendPrivateMemory, color: 'var(--chart-private-memory)', style: 'area' },
        { key: 'heap', label: strings.legendManagedHeap, color: 'var(--chart-managed-heap)', style: 'line' },
        { key: 'ws', label: strings.legendWorkingSet, color: 'var(--chart-working-set)', style: 'line', tooltip: false },
      ],
    },
  ];
}

/** Точка входа: разметка, подписки на сообщения и события. */
function main(): void {
  createCharts();
  bindControls();
  bindWindowEvents();
  observeTheme();
  vscode.postMessage({ type: 'ready' });
  render();
}

/** Пересоздаёт графики: вызывается при запуске и при смене языка интерфейса. */
function createCharts(): void {
  const root = document.getElementById('charts');
  if (root === null) {
    return;
  }

  root.textContent = '';
  charts.length = 0;
  for (const spec of buildSpecs(state.strings)) {
    charts.push(createChart(root, spec));
  }
}

/** Создаёт разметку одного графика. */
function createChart(root: HTMLElement, spec: ChartSpec): ChartElements {
  const container = document.createElement('section');
  container.className = 'chart';

  const head = document.createElement('div');
  head.className = 'chart-head';

  const title = document.createElement('span');
  title.className = 'chart-title';
  title.textContent = spec.title;
  head.append(title);

  const legend = document.createElement('span');
  legend.className = 'legend';
  for (const series of spec.series) {
    legend.append(legendItem(series.label, series.color, '9px'));
  }

  if (spec.showGcMarkers === true) {
    const markers: Array<[string, string]> = [
      [state.strings.legendGen0, 'var(--chart-gen0)'],
      [state.strings.legendGen1, 'var(--chart-gen1)'],
      [state.strings.legendGen2, 'var(--chart-gen2)'],
    ];
    for (const [label, color] of markers) {
      legend.append(legendItem(label, color, '3px'));
    }
  }

  head.append(legend);

  const wrap = document.createElement('div');
  wrap.className = 'chart-canvas-wrap';

  const canvas = document.createElement('canvas');
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip';
  wrap.append(canvas, tooltip);

  container.append(head, wrap);
  root.append(container);

  canvas.addEventListener('mousemove', event => onPointerMove(event, spec, canvas, tooltip));
  canvas.addEventListener('mouseleave', () => onPointerLeave(spec));
  canvas.addEventListener('mousedown', event => onPointerDown(event, spec, canvas));
  canvas.addEventListener('dblclick', () => resetSelection());

  return { spec, canvas, tooltip };
}

/** Элемент легенды: цветной квадратик и подпись. */
function legendItem(label: string, color: string, size: string): HTMLElement {
  const item = document.createElement('span');
  item.className = 'legend-item';
  const swatch = document.createElement('span');
  swatch.className = 'legend-swatch';
  swatch.style.background = color;
  swatch.style.width = size;
  item.append(swatch, document.createTextNode(label));
  return item;
}

/** Подписка на сообщения расширения. */
window.addEventListener('message', event => {
  const message = event.data as IncomingMessage;
  const previousStrings = state.strings;

  if (message.locale !== undefined) {
    // Числа, время и сокращения единиц должны соответствовать языку интерфейса.
    configureLocale(message.locale);
  }

  switch (message.type) {
    case 'snapshot':
      state.points = message.points.slice(-MAX_POINTS);
      state.gcEvents = message.gcEvents.slice(-MAX_POINTS);
      // Данные заменили (новый процесс или очистка) — сохранённый интервал больше не к месту.
      dropArchiveWhenReplaced(message.generation);
      if (state.archive === null) {
        state.meta = message.meta;
        state.issues = message.issues ?? [];
      }

      state.strings = message.strings ?? state.strings;
      state.windowSeconds = readWindowSeconds(message.meta);
      break;
    case 'append':
      if (state.paused && state.archive === null) {
        // На паузе данные не принимаем: при возобновлении запрашиваем свежий снимок.
        return;
      }

      state.points = [...state.points, ...message.points].slice(-MAX_POINTS);
      state.gcEvents = [...state.gcEvents, ...message.gcEvents].slice(-MAX_POINTS);
      if (state.archive === null && message.meta !== undefined) {
        state.meta = message.meta;
        state.windowSeconds = readWindowSeconds(message.meta);
      }

      if (state.archive === null && message.issues !== undefined) {
        state.issues = message.issues;
      }

      if (message.strings !== undefined) {
        state.strings = message.strings;
      }

      // Открыт сохранённый интервал: живые данные копим в фоне, но показываем сохранённые.
      break;
    case 'meta':
      dropArchiveWhenReplaced(message.generation);
      if (state.archive === null) {
        state.meta = message.meta;
        state.issues = message.issues ?? state.issues;
      }

      state.strings = message.strings ?? state.strings;
      state.windowSeconds = readWindowSeconds(message.meta);
      break;

    case 'issueSlice':
      state.archive = {
        points: message.points.slice(-MAX_POINTS),
        gcEvents: message.gcEvents.slice(-MAX_POINTS),
        issues: [message.issue],
        meta: message.meta,
        label: message.processLabel,
        fromMs: message.fromMs,
        toMs: message.toMs,
        viewFromMs: message.viewFromMs,
        viewToMs: message.viewToMs,
        generation: message.generation ?? state.archive?.generation ?? 0,
      };
      state.meta = message.meta;
      state.issues = [message.issue];
      state.selection = { from: message.fromMs, to: message.toMs };
      state.strings = message.strings ?? state.strings;
      state.windowSeconds = readWindowSeconds(message.meta);
      break;

    case 'selectRange':
      selectRange(message.fromMs, message.toMs);
      return;

    case 'targets':
      state.targets = message.groups;
      updateTargets();
      return;
  }

  if (state.strings !== previousStrings) {
    // Язык интерфейса изменился: перерисовываем подписи графиков и кнопок.
    createCharts();
    applyPauseLabel();
  }

  updateHeader();
  updateIssues();
  updateArchive();
  scheduleRedraw();
});

/**
 * Точки, по которым сейчас рисуются графики: живые или сохранённый интервал.
 * Пока открыт сохранённый интервал, показываем именно его — иначе выделение
 * оказалось бы поверх пустого места.
 */
function displayPoints(): ChartPoint[] {
  return state.archive?.points ?? state.points;
}

/** События GC показанных данных. */
function displayGcEvents(): ChartGcEvent[] {
  return state.archive?.gcEvents ?? state.gcEvents;
}

/** Проблемы, к которым относятся показанные данные: у сохранённого интервала — только он сам. */
function displayIssues(): ChartIssue[] {
  return state.archive?.issues ?? state.issues;
}

/**
 * Закрывает сохранённый интервал, если данные монитора заменили.
 * Новый процесс или очистка делают сохранённые точки чужими для графиков.
 */
function dropArchiveWhenReplaced(generation: number | undefined): void {
  if (state.archive === null || !archiveReplaced(state.archive.generation, generation)) {
    return;
  }

  state.archive = null;
  state.selection = null;
}

/** Закрывает сохранённый интервал и возвращает панель к живым данным. */
function exitArchive(): void {
  if (state.archive === null) {
    return;
  }

  state.archive = null;
  state.selection = null;
  vscode.postMessage({ type: 'requestSnapshot' });
}

/** Полоса о показанном сохранённом интервале: объясняет, чьи данные на графиках. */
function updateArchive(): void {
  const container = document.getElementById('archive');
  const text = document.getElementById('archive-text');
  const exit = document.getElementById('archive-exit');
  if (container === null || text === null || exit === null) {
    return;
  }

  const archive = state.archive;
  container.hidden = archive === null;
  if (archive === null) {
    return;
  }

  text.textContent = formatTemplate(
    state.strings.archiveHint,
    `${archive.label} · ${formatClockTime(archive.fromMs)} — ${formatClockTime(archive.toMs)}`,
  );
  exit.textContent = state.strings.buttonBackToLive;
}

/** Показывает список целей мониторинга: сессии отладки отдельно, процессы отдельно. */
function updateTargets(): void {
  const select = document.getElementById('target') as HTMLSelectElement | null;
  if (select === null) {
    return;
  }

  const groups = state.targets;
  const total = groups.sessions.length + groups.processes.length;
  select.textContent = '';
  select.disabled = total === 0;

  if (total === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = state.strings.targetEmpty;
    select.append(option);
    return;
  }

  appendGroup(select, state.strings.targetSessions, groups.sessions);
  appendGroup(select, state.strings.targetProcesses, groups.processes);

  // Показываем текущую цель, не отправляя сообщение о выборе: иначе получится цикл переключений.
  const current = [...groups.sessions, ...groups.processes].find(entry => entry.isCurrent);
  if (current !== undefined) {
    state.selectedTarget = current.value;
    select.value = current.value;
  }
}

/** Добавляет в список группу целей, если она не пуста. */
function appendGroup(select: HTMLSelectElement, label: string, entries: readonly TargetEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  const group = document.createElement('optgroup');
  group.label = label;

  for (const entry of entries) {
    const option = document.createElement('option');
    option.value = entry.value;
    // Текущая цель помечается галочкой: так её видно и в раскрытом списке.
    option.textContent = `${entry.isCurrent ? '✓ ' : ''}${entry.name} — ${entry.detail}`;
    option.title = entry.detail;
    group.append(option);
  }

  select.append(group);
}

/** Выделяет интервал по запросу расширения: используется при переходе из дерева проблем. */
function selectRange(fromMs: number, toMs: number): void {
  const from = Math.min(fromMs, toMs);
  const to = Math.max(fromMs, toMs);
  state.selection = { from, to };
  updateSummary();
  scheduleRedraw();
}

/** Окно отображения приходит в мете: по умолчанию 120 секунд. */
function readWindowSeconds(meta: ChartMeta): number {
  return typeof meta.windowSeconds === 'number' && meta.windowSeconds > 0 ? meta.windowSeconds : state.windowSeconds;
}

/** Кнопки управления панелью. */
function bindControls(): void {
  document.getElementById('pause')?.addEventListener('click', () => {
    state.paused = !state.paused;
    applyPauseLabel();
    if (!state.paused) {
      // После паузы данные в панели устарели — берём свежий снимок.
      vscode.postMessage({ type: 'requestSnapshot' });
    }
  });

  document.getElementById('reset-selection')?.addEventListener('click', () => resetSelection());
  document.getElementById('archive-exit')?.addEventListener('click', () => exitArchive());
  document.getElementById('target')?.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (select.value.length === 0 || select.value === state.selectedTarget) {
      return;
    }

    // Переключение делает расширение: ему нужно запустить мост на другом процессе.
    state.selectedTarget = select.value;
    vscode.postMessage({ type: 'selectTarget', target: select.value });
  });
  applyPauseLabel();
}

/** Обновляет подписи кнопок с учётом языка и состояния паузы. */
function applyPauseLabel(): void {
  const pause = document.getElementById('pause');
  if (pause !== null) {
    pause.textContent = state.paused ? state.strings.buttonResume : state.strings.buttonPause;
    pause.setAttribute('aria-pressed', state.paused ? 'true' : 'false');
  }

  const reset = document.getElementById('reset-selection');
  if (reset !== null) {
    reset.textContent = state.strings.buttonResetSelection;
  }
}

/** Реакция на изменение размера панели и нажатия клавиш. */
function bindWindowEvents(): void {
  const observer = new ResizeObserver(() => scheduleRedraw());
  observer.observe(document.body);
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      resetSelection();
    }
  });
}

/** Тема VS Code меняется классом на body — перерисовываем графики. */
function observeTheme(): void {
  new MutationObserver(() => scheduleRedraw()).observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'data-vscode-theme-kind'],
  });
}

function resetSelection(): void {
  if (state.selection === null) {
    return;
  }

  state.selection = null;
  document.getElementById('summary')?.setAttribute('hidden', 'true');
  scheduleRedraw();
}

/** Наведение: запоминаем время под курсором. */
function onPointerMove(event: MouseEvent, spec: ChartSpec, canvas: HTMLCanvasElement, tooltip: HTMLElement): void {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const view = currentView();
  const area = chartArea(canvas);

  if (state.dragging !== null && state.dragging.chartId === spec.id) {
    state.dragging.toT = viewFromX(x, area, view);
    applyDraggingSelection();
    scheduleRedraw();
    return;
  }

  state.hoverT = viewFromX(x, area, view);
  state.hoverChart = spec.id;

  if (state.hoverT < view.fromMs || state.hoverT > view.toMs || x < area.left) {
    tooltip.style.display = 'none';
    scheduleRedraw();
    return;
  }

  showTooltip(tooltip, spec, canvas, x);
  scheduleRedraw();
}

function onPointerLeave(spec: ChartSpec): void {
  if (state.dragging !== null) {
    return;
  }

  if (state.hoverChart === spec.id) {
    state.hoverT = null;
    state.hoverChart = '';
    scheduleRedraw();
  }

  for (const chart of charts) {
    chart.tooltip.style.display = 'none';
  }
}

/** Начало выделения диапазона. */
function onPointerDown(event: MouseEvent, spec: ChartSpec, canvas: HTMLCanvasElement): void {
  const rect = canvas.getBoundingClientRect();
  const view = currentView();
  const time = viewFromX(event.clientX - rect.left, chartArea(canvas), view);

  state.dragging = { chartId: spec.id, fromT: time, toT: time };

  const onUp = (): void => {
    window.removeEventListener('mouseup', onUp);
    const dragging = state.dragging;
    state.dragging = null;
    if (dragging === null) {
      return;
    }

    // Короткое движение мышью считаем обычным кликом, а не выделением.
    if (Math.abs(dragging.toT - dragging.fromT) < 300) {
      resetSelection();
      return;
    }

    state.selection = {
      from: Math.min(dragging.fromT, dragging.toT),
      to: Math.max(dragging.fromT, dragging.toT),
    };
    updateSummary();
    scheduleRedraw();
  };

  window.addEventListener('mouseup', onUp);
}

function applyDraggingSelection(): void {
  const dragging = state.dragging;
  if (dragging === null) {
    return;
  }

  state.selection = {
    from: Math.min(dragging.fromT, dragging.toT),
    to: Math.max(dragging.fromT, dragging.toT),
  };
}

/** Подсказка со значениями всех рядов в точке под курсором. */
function showTooltip(tooltip: HTMLElement, spec: ChartSpec, canvas: HTMLCanvasElement, pointerX: number): void {
  const point = nearestPoint(displayPoints(), state.hoverT);
  if (point === undefined) {
    tooltip.style.display = 'none';
    return;
  }

  tooltip.textContent = '';

  const time = document.createElement('div');
  time.className = 'tooltip-time';
  time.textContent = formatClockTime(point.t);
  tooltip.append(time);

  for (const series of spec.series) {
    const row = document.createElement('div');
    row.className = 'tooltip-row';

    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = series.color;

    const label = document.createElement('span');
    label.textContent = series.label;

    const value = document.createElement('span');
    value.className = 'tooltip-value';
    value.textContent = spec.format(point[series.key]);

    row.append(swatch, label, value);
    tooltip.append(row);
  }

  // События GC рядом с этой точкой: поколение и длительность паузы.
  const nearby = displayGcEvents().filter(event => Math.abs(event.t - point.t) < 1000).slice(0, 4);
  for (const gcEvent of nearby) {
    const row = document.createElement('div');
    row.className = 'tooltip-row';
    const reason = gcEvent.reason.length > 0 ? ` (${gcEvent.reason})` : '';
    row.textContent = formatTemplate(
      state.strings.tooltipGc,
      gcEvent.gen,
      `${formatDuration(gcEvent.dur)}${reason}`,
    );
    tooltip.append(row);
  }

  tooltip.style.display = 'block';
  const maxLeft = Math.max(0, canvas.clientWidth - tooltip.offsetWidth - 8);
  tooltip.style.left = `${Math.min(Math.max(pointerX + 12, 4), maxLeft)}px`;
  tooltip.style.top = '6px';
}

/** Список найденных проблем: нажатие выделяет интервал на графиках. */
function updateIssues(): void {
  const container = document.getElementById('issues');
  if (container === null) {
    return;
  }

  container.textContent = '';
  const issues = displayIssues();
  if (issues.length === 0) {
    container.hidden = true;
    return;
  }

  container.hidden = false;

  const title = document.createElement('div');
  title.className = 'issues-title';
  title.textContent = `${state.strings.issuesTitle} (${issues.length})`;
  container.append(title);

  const hint = document.createElement('div');
  hint.className = 'issues-hint';
  hint.textContent = state.strings.issuesHint;
  container.append(hint);

  for (const issue of issues) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'issue';

    const badge = document.createElement('span');
    badge.className = 'issue-badge';
    badge.textContent = severityBadge(issue.severity);

    const body = document.createElement('span');
    body.className = 'issue-body';

    const head = document.createElement('span');
    head.className = 'issue-title';
    head.textContent = `${formatClockTime(issue.fromMs)} · ${issue.title}`;

    const details = document.createElement('span');
    details.className = 'issue-details';
    details.textContent = issue.details;

    body.append(head, details);
    item.append(badge, body);
    item.addEventListener('click', () => selectIssueRange(issue));
    container.append(item);
  }
}

/** Значок важности проблемы. */
function severityBadge(severity: ChartIssue['severity']): string {
  switch (severity) {
    case 'critical':
      return '🔴';
    case 'warning':
      return '⚠️';
    default:
      return 'ℹ️';
  }
}

/**
 * Просит расширение показать интервал проблемы.
 * Живой ряд мог уже уйти вперёд, поэтому решение (выделить на графиках или показать
 * сохранённые точки) принимает расширение — у него есть данные интервала.
 */
function selectIssueRange(issue: ChartIssue): void {
  if (state.archive !== null) {
    // Открыт сохранённый интервал: в нём есть данные, выделяем сразу.
    state.selection = { from: issue.fromMs, to: issue.toMs };
    updateSummary();
    scheduleRedraw();
    return;
  }

  vscode.postMessage({ type: 'revealIssue', issueId: issue.id, fromMs: issue.fromMs, toMs: issue.toMs });
}

/** Сводка по выделенному диапазону: минимум, среднее и максимум. */
function updateSummary(): void {
  const summary = document.getElementById('summary');
  const selection = state.selection;
  if (summary === null || selection === null) {
    return;
  }

  const selected = displayPoints().filter(point => point.t >= selection.from && point.t <= selection.to);
  if (selected.length === 0) {
    summary.setAttribute('hidden', 'true');
    return;
  }

  const strings = state.strings;
  const rows: Array<[string, string]> = [
    [strings.summaryRange, `${formatClockTime(selection.from)} — ${formatClockTime(selection.to)}`],
    [strings.summaryPoints, formatNumber(selected.length, 0)],
    [strings.summaryCpu, statistic(selected, 'cpu', value => formatPercent(value))],
    [strings.summaryPrivateMemory, statistic(selected, 'priv', value => formatBytes(value))],
    [strings.summaryManagedHeap, statistic(selected, 'heap', value => formatBytes(value))],
  ];

  const inRange = displayGcEvents().filter(event => event.t >= selection.from && event.t <= selection.to);
  if (inRange.length > 0) {
    rows.push([strings.summaryGcCount, formatNumber(inRange.length, 0)]);
    rows.push([strings.summaryGcPause, formatDuration(average(inRange.map(event => event.dur ?? 0)))]);
  }

  summary.textContent = '';
  const title = document.createElement('div');
  title.className = 'summary-title';
  title.textContent = strings.summaryTitle;
  summary.append(title);

  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    const left = document.createElement('span');
    left.textContent = label;
    const right = document.createElement('span');
    right.textContent = value;
    row.append(left, right);
    summary.append(row);
  }

  summary.removeAttribute('hidden');
}

/** Минимум, среднее и максимум показателя по точкам. */
function statistic(points: readonly ChartPoint[], key: keyof Omit<ChartPoint, 't'>, format: (value: number) => string): string {
  const values = points.map(point => point[key]).filter(value => Number.isFinite(value));
  if (values.length === 0) {
    return '—';
  }

  return `${format(Math.min(...values))} / ${format(average(values))} / ${format(Math.max(...values))}`;
}

function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Обновляет шапку и плитки с текущими значениями. */
function updateHeader(): void {
  const meta = state.meta;
  const strings = state.strings;
  const name = document.getElementById('process-name');
  const details = document.getElementById('process-details');
  const latest = displayPoints().at(-1);

  if (name !== null) {
    name.textContent = meta.processName.length > 0
      ? `${meta.processName} (PID ${meta.pid})`
      : strings.processNotSelected;
  }

  if (details !== null) {
    const parts = [statusText(strings), meta.runtimeVersion ? `.NET ${meta.runtimeVersion}` : '', meta.os]
      .filter(part => part.length > 0);
    details.textContent = parts.join(' · ');
  }

  const cards = document.getElementById('cards');
  if (cards === null) {
    return;
  }

  cards.textContent = '';
  // Плитки показывают последние значения процесса на графиках: у сохранённого интервала
  // они относились бы к другому прогону, поэтому в этом режиме их не показываем.
  cards.hidden = state.archive !== null;
  if (cards.hidden) {
    return;
  }

  if (latest === undefined) {
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.textContent = meta.hint ?? strings.hintStart;
    cards.append(notice);
    return;
  }

  const tiles: Array<[string, string]> = [
    [strings.tileCpu, formatPercent(latest.cpu)],
    [strings.tilePrivateMemory, formatBytes(latest.priv)],
    [strings.tileManagedHeap, formatBytes(latest.heap)],
    [strings.tileAllocation, `${formatBytes(latest.alloc)}/${word('secondShort')}`],
    [strings.tileTimeInGc, formatPercent(latest.tig)],
    [strings.tileThreads, formatNumber(latest.thr, 0)],
    [strings.tileGcCounts, collectionCounts()],
  ];

  for (const [label, value] of tiles) {
    const card = document.createElement('div');
    card.className = 'card';
    const cardLabel = document.createElement('div');
    cardLabel.className = 'card-label';
    cardLabel.textContent = label;
    const cardValue = document.createElement('div');
    cardValue.className = 'card-value';
    cardValue.textContent = value;
    card.append(cardLabel, cardValue);
    cards.append(card);
  }
}

/** Накопленные сборки мусора приходят в мете. */
function collectionCounts(): string {
  const counts = state.meta.gcCollections;
  return `${formatNumber(counts.gen0, 0)} / ${formatNumber(counts.gen1, 0)} / ${formatNumber(counts.gen2, 0)}`;
}

function statusText(strings: WebviewStrings): string {
  switch (state.meta.status) {
    case 'running':
      return strings.statusRunning;
    case 'connecting':
      return strings.statusConnecting;
    case 'archive':
      return strings.statusArchive;
    case 'stopped':
      return state.meta.hint ?? strings.statusStopped;
    case 'failed':
      return state.meta.hint ?? strings.statusFailed;
    default:
      return strings.statusIdle;
  }
}

/**
 * Видимый диапазон времени.
 * У сохранённого интервала он приходит с данными (интервал и запас по краям),
 * у живых графиков считается по последним `windowSeconds` секундам.
 */
function currentView(): TimeRange {
  if (state.archive !== null) {
    return { fromMs: state.archive.viewFromMs, toMs: state.archive.viewToMs };
  }

  return liveVisibleRange(
    state.points,
    state.windowSeconds,
    Date.now(),
    state.selection === null ? null : { fromMs: state.selection.from, toMs: state.selection.to },
  );
}

/** Область рисования внутри канваса (должна совпадать с render.ts). */
function chartArea(canvas: HTMLCanvasElement): { left: number; top: number; right: number; bottom: number } {
  const padding = { left: 70, right: 14, top: 10, bottom: 22 };
  return {
    left: padding.left,
    top: padding.top,
    right: canvas.clientWidth - padding.right,
    bottom: canvas.clientHeight - padding.bottom,
  };
}

/** Переводит координату X в время. */
function viewFromX(x: number, area: { left: number; right: number }, view: { fromMs: number; toMs: number }): number {
  const width = Math.max(1, area.right - area.left);
  const ratio = Math.min(1, Math.max(0, (x - area.left) / width));
  return view.fromMs + ratio * (view.toMs - view.fromMs);
}

function nearestPoint(points: readonly ChartPoint[], timeMs: number | null): ChartPoint | undefined {
  if (timeMs === null || points.length === 0) {
    return undefined;
  }

  const target = timeMs;
  return points.reduce((best, point) => Math.abs(point.t - target) < Math.abs(best.t - target) ? point : best);
}

/** Ставит перерисовку в очередь: несколько изменений подряд дают одну отрисовку. */
function scheduleRedraw(): void {
  if (redrawQueued) {
    return;
  }

  redrawQueued = true;
  window.requestAnimationFrame(() => {
    redrawQueued = false;
    render();
  });
}

/** Перерисовывает все графики. */
function render(): void {
  const palette = readPalette();
  const view = currentView();
  const hoverT = state.hoverT !== null && state.hoverT >= view.fromMs && state.hoverT <= view.toMs
    ? state.hoverT
    : null;

  const chartView: ChartView = {
    fromMs: view.fromMs,
    toMs: view.toMs,
    hoverT,
    selection: state.selection,
    placeholder: state.strings.waitingForData,
    issues: displayIssues(),
  };

  const sizes: string[] = [];
  let painted = false;
  for (const chart of charts) {
    try {
      drawChart(chart.canvas, chart.spec, displayPoints(), displayGcEvents(), chartView, palette);
      sizes.push(`${chart.spec.id}:${chart.canvas.clientWidth}x${chart.canvas.clientHeight}`);
      painted = painted || hasPaintedPixels(chart.canvas);
    } catch (error) {
      // Ошибка одного графика не должна оставлять панель пустой без объяснения.
      reportProblem(`Could not draw the chart "${chart.spec.title}": ${String(error)}`);
    }
  }

  reportRenderOnce(displayPoints().length, sizes, painted);
}

/**
 * Отчёт об отрисовке.
 * Первое подтверждение после появления данных попадает в журнал, дальше молчим:
 * иначе журнал заполняется одной строкой в секунду. Если линии не нарисовались —
 * сообщаем повторно, но не чаще раза в 10 секунд.
 */
let reportedPainted = false;
let lastReportedAt = 0;

function reportRenderOnce(pointCount: number, sizes: readonly string[], painted: boolean): void {
  if (pointCount === 0) {
    // Данные сброшены (новый процесс или очистка) — снова ждём подтверждения.
    reportedPainted = false;
    return;
  }

  const now = Date.now();
  if (painted && reportedPainted) {
    return;
  }

  if (!painted && now - lastReportedAt < 10_000) {
    return;
  }

  reportedPainted = painted;
  lastReportedAt = now;
  vscode.postMessage({
    type: 'rendered',
    points: pointCount,
    canvases: sizes.join(', '),
    painted,
    issues: state.issues.length,
  });
}

/** Есть ли на канвасе хотя бы один непрозрачный пиксель: проверка, что линии реально нарисованы. */
function hasPaintedPixels(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext('2d');
  if (context === null || canvas.width === 0 || canvas.height === 0) {
    return false;
  }

  try {
    const width = Math.min(canvas.width, 240);
    const height = Math.min(canvas.height, 240);
    const data = context.getImageData(0, 0, width, height).data;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) {
        return true;
      }
    }
  } catch {
    // Некоторые среды запрещают чтение пикселей — тогда считаем проверку недоступной.
    return true;
  }

  return false;
}

/** Последнее отправленное сообщение о проблеме: одинаковые ошибки не дублируем. */
let lastProblem = '';

/** Сообщает расширению о проблеме отрисовки — это видно в журнале «Monitor Dotnet». */
function reportProblem(message: string): void {
  if (lastProblem === message) {
    return;
  }

  lastProblem = message;
  vscode.postMessage({ type: 'problem', message });
}

/**
 * Читает цвета темы из CSS-переменных.
 * Каждое значение проходит через resolveCanvasColor: canvas не понимает `var(--...)`,
 * а переменные темы VS Code сами ссылаются на другие переменные.
 */
function readPalette(): ChartPalette {
  const styles = getComputedStyle(document.body);
  const readVariable = (name: string): string => styles.getPropertyValue(name);
  const resolve = (name: string, fallback: string): string =>
    resolveCanvasColor(`var(${name}, ${fallback})`, readVariable, fallback);

  return {
    text: resolve('--chart-text', '#999999'),
    grid: resolve('--chart-grid', 'rgba(128,128,128,0.25)'),
    crosshair: resolve('--chart-crosshair', '#cccccc'),
    selectionFill: resolve('--chart-selection', 'rgba(58,110,165,0.35)'),
    selectionBorder: resolve('--chart-selection-border', '#007fd4'),
    font: `${styles.fontSize || '12px'} ${styles.fontFamily || 'sans-serif'}`,
    gen0: resolve('--chart-gen0', '#e5c07b'),
    gen1: resolve('--chart-gen1', '#d18616'),
    gen2: resolve('--chart-gen2', '#f14c4c'),
    issueInfo: resolve('--chart-issue-info', '#4b9cff'),
    issueWarning: resolve('--chart-issue-warning', '#cca700'),
    issueCritical: resolve('--chart-issue-critical', '#f14c4c'),
    resolveColor: value => resolveCanvasColor(value, readVariable),
  };
}

main();
