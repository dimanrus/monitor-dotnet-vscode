/**
 * Отрисовка графиков на canvas.
 * Здесь нет ни DOM-событий, ни обмена сообщениями — только рисование по готовым данным,
 * поэтому функцию легко вызывать повторно на каждое изменение.
 */

import {
  buildTimeTicks,
  buildValueTicks,
  niceCeiling,
  type ChartGcEvent,
  type ChartIssue,
  type ChartPoint,
} from '../core/chartData.ts';

/** Ключ показателя, который выводится на графике. */
export type SeriesKey = keyof Omit<ChartPoint, 't'>;

/** Описание одной линии графика. */
export interface SeriesSpec {
  key: SeriesKey;
  label: string;
  color: string;
  /** Линия с заливкой под ней или обычная линия. */
  style: 'area' | 'line';
  /** Показывать значение в подсказке при наведении. */
  tooltip?: boolean;
}

/** Описание графика. */
export interface ChartSpec {
  id: string;
  title: string;
  series: SeriesSpec[];
  /** Формат подписей оси Y и значений. */
  format: (value: number) => string;
  /** Фиксированная верхняя граница шкалы (например, 100 % для загрузки CPU). */
  fixedMax?: number;
  /** Рисовать отметки сборок мусора по времени. */
  showGcMarkers?: boolean;
}

/** Цвета, зависящие от темы VS Code. */
export interface ChartPalette {
  text: string;
  grid: string;
  crosshair: string;
  selectionFill: string;
  selectionBorder: string;
  font: string;
  gen0: string;
  gen1: string;
  gen2: string;
  issueInfo: string;
  issueWarning: string;
  issueCritical: string;
  /**
   * Превращает цвет ряда в значение, понятное canvas.
   * Обязательно: canvas не понимает `var(--chart-cpu)`.
   */
  resolveColor: (value: string) => string;
}

/** Текущее состояние отображения: видимый диапазон, наведение и выделение. */
export interface ChartView {
  fromMs: number;
  toMs: number;
  /** Время под курсором или null, если курсор вне графика. */
  hoverT: number | null;
  /** Выделенный пользователем диапазон времени. */
  selection: { from: number; to: number } | null;
  /** Текст, который показывается, пока данных нет (переводится на стороне расширения). */
  placeholder: string;
  /** Найденные проблемы: их интервалы подсвечиваются на соответствующем графике. */
  issues: readonly ChartIssue[];
}

/** Область рисования внутри канваса. */
interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Масштабы по осям: время по X, значение по Y. */
interface Scales {
  toX: (timeMs: number) => number;
  toY: (value: number) => number;
  limit: number;
  fromMs: number;
  toMs: number;
}

/** Отступы внутри области графика. */
const PADDING = { left: 70, right: 14, top: 10, bottom: 22 };

/** Количество линий сетки по вертикали и отметок времени по горизонтали. */
const VALUE_TICK_COUNT = 4;
const TIME_TICK_COUNT = 6;

/**
 * Рисует график целиком.
 * Канвас масштабируется по плотности пикселей, поэтому рисование идёт в CSS-пикселях.
 */
export function drawChart(
  canvas: HTMLCanvasElement,
  spec: ChartSpec,
  points: readonly ChartPoint[],
  gcEvents: readonly ChartGcEvent[],
  view: ChartView,
  palette: ChartPalette,
): void {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) {
    return;
  }

  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }

  const context = canvas.getContext('2d');
  if (context === null) {
    return;
  }

  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);

  const area: Area = {
    left: PADDING.left,
    top: PADDING.top,
    right: width - PADDING.right,
    bottom: height - PADDING.bottom,
  };

  if (area.right <= area.left || area.bottom <= area.top) {
    return;
  }

  const scales = createScales(points, spec, view, area);
  if (scales === undefined) {
    drawPlaceholder(context, area, palette, view.placeholder);
    return;
  }

  const visible = points.filter(point => point.t >= view.fromMs - 1000 && point.t <= view.toMs);

  drawGrid(context, area, palette, spec, scales);
  drawIssueBands(context, area, spec, scales, palette, view);
  drawSeries(context, area, spec, visible, scales, palette);
  if (spec.showGcMarkers === true) {
    drawGcMarkers(context, area, gcEvents, scales, palette, view);
  }

  drawSelection(context, area, view, palette, scales);
  drawHover(context, area, spec, visible, scales, palette, view);
}

function createScales(
  points: readonly ChartPoint[],
  spec: ChartSpec,
  view: ChartView,
  area: Area,
): Scales | undefined {
  if (view.toMs <= view.fromMs) {
    return undefined;
  }

  let maxValue = 0;
  for (const point of points) {
    for (const series of spec.series) {
      const value = point[series.key];
      if (Number.isFinite(value) && value > maxValue) {
        maxValue = value;
      }
    }
  }

  const limit = Math.max(1, spec.fixedMax ?? niceCeiling(maxValue));
  // Все графики начинаются от нуля: так лучше видно реальное потребление и пики.
  const valuesFrom = 0;
  const span = limit - valuesFrom;

  const toX = (timeMs: number): number =>
    area.left + ((timeMs - view.fromMs) / (view.toMs - view.fromMs)) * (area.right - area.left);
  const toY = (value: number): number =>
    area.bottom - ((Math.min(Math.max(value, valuesFrom), limit) - valuesFrom) / span) * (area.bottom - area.top);

  return { toX, toY, limit, fromMs: view.fromMs, toMs: view.toMs };
}

/** Сетка и подписи осей. */
function drawGrid(
  context: CanvasRenderingContext2D,
  area: Area,
  palette: ChartPalette,
  spec: ChartSpec,
  scales: Scales,
): void {
  context.save();
  context.font = palette.font;
  context.lineWidth = 1;

  context.textAlign = 'right';
  context.textBaseline = 'middle';
  for (const value of buildValueTicks(scales.limit, VALUE_TICK_COUNT)) {
    // Полупиксельное смещение делает линии сетки ровными.
    const y = Math.round(scales.toY(value)) + 0.5;
    context.strokeStyle = palette.grid;
    context.beginPath();
    context.moveTo(area.left, y);
    context.lineTo(area.right, y);
    context.stroke();

    context.fillStyle = palette.text;
    context.fillText(spec.format(value), area.left - 8, y);
  }

  context.textAlign = 'center';
  context.textBaseline = 'top';
  for (const time of buildTimeTicks(scales.fromMs, scales.toMs, TIME_TICK_COUNT)) {
    const x = Math.round(scales.toX(time)) + 0.5;
    context.strokeStyle = palette.grid;
    context.beginPath();
    context.moveTo(x, area.top);
    context.lineTo(x, area.bottom);
    context.stroke();

    context.fillStyle = palette.text;
    context.fillText(formatClockTime(time), x, area.bottom + 6);
  }

  context.restore();
}

/**
 * Полосы найденных проблем: показывают интервал, на который стоит обратить внимание.
 * Рисуются под линиями, чтобы не мешать читать данные.
 */
function drawIssueBands(
  context: CanvasRenderingContext2D,
  area: Area,
  spec: ChartSpec,
  scales: Scales,
  palette: ChartPalette,
  view: ChartView,
): void {
  const issues = view.issues.filter(issue => issue.chart === spec.id);
  if (issues.length === 0) {
    return;
  }

  context.save();
  context.beginPath();
  context.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
  context.clip();
  context.globalAlpha = 0.16;

  for (const issue of issues) {
    const from = Math.max(area.left, scales.toX(issue.fromMs));
    const to = Math.min(area.right, scales.toX(issue.toMs));
    if (to <= from) {
      continue;
    }

    context.fillStyle = issueColor(issue.severity, palette);
    context.fillRect(from, area.top, to - from, area.bottom - area.top);
  }

  // Края интервалов обводим, чтобы полоса читалась и на пёстром графике.
  context.globalAlpha = 0.6;
  context.lineWidth = 1;
  for (const issue of issues) {
    const from = Math.max(area.left, scales.toX(issue.fromMs));
    const to = Math.min(area.right, scales.toX(issue.toMs));
    if (to <= from) {
      continue;
    }

    context.strokeStyle = issueColor(issue.severity, palette);
    context.strokeRect(from + 0.5, area.top + 0.5, Math.max(1, to - from - 1), area.bottom - area.top - 1);
  }

  context.restore();
}

/** Цвет полосы по важности проблемы. */
function issueColor(severity: ChartIssue['severity'], palette: ChartPalette): string {
  switch (severity) {
    case 'critical':
      return palette.issueCritical;
    case 'warning':
      return palette.issueWarning;
    default:
      return palette.issueInfo;
  }
}

/** Линии и заливки рядов. */
function drawSeries(
  context: CanvasRenderingContext2D,
  area: Area,
  spec: ChartSpec,
  points: readonly ChartPoint[],
  scales: Scales,
  palette: ChartPalette,
): void {
  if (points.length < 2) {
    return;
  }

  for (const series of spec.series) {
    const color = palette.resolveColor(series.color);

    context.save();
    context.beginPath();
    context.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
    context.clip();

    // Контур строится один раз и переиспользуется для заливки и линии.
    const path = new Path2D();
    for (let index = 0; index < points.length; index++) {
      const x = scales.toX(points[index].t);
      const y = scales.toY(points[index][series.key]);
      if (index === 0) {
        path.moveTo(x, y);
      } else {
        path.lineTo(x, y);
      }
    }

    if (series.style === 'area') {
      const fill = new Path2D(path);
      fill.lineTo(scales.toX(points[points.length - 1].t), area.bottom);
      fill.lineTo(scales.toX(points[0].t), area.bottom);
      fill.closePath();

      const gradient = context.createLinearGradient(0, area.top, 0, area.bottom);
      // Цвет уже разрешён в конкретное значение: addColorStop не принимает переменные темы.
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, 'transparent');
      context.save();
      context.globalAlpha = 0.3;
      context.fillStyle = gradient;
      context.fill(fill);
      context.restore();
    }

    context.strokeStyle = color;
    context.lineWidth = series.style === 'area' ? 2 : 1.4;
    context.lineJoin = 'round';
    context.stroke(path);
    context.restore();
  }
}

/** Вертикальные отметки сборок мусора: цвет — поколение. */
function drawGcMarkers(
  context: CanvasRenderingContext2D,
  area: Area,
  gcEvents: readonly ChartGcEvent[],
  scales: Scales,
  palette: ChartPalette,
  view: ChartView,
): void {
  context.save();
  context.beginPath();
  context.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
  context.clip();

  for (const event of gcEvents) {
    if (event.t < view.fromMs || event.t > view.toMs) {
      continue;
    }

    const x = Math.round(scales.toX(event.t)) + 0.5;
    context.strokeStyle = generationColor(event.gen, palette);
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, area.top);
    context.lineTo(x, area.bottom);
    context.stroke();
  }

  context.restore();
}

/** Выделенный пользователем диапазон. */
function drawSelection(
  context: CanvasRenderingContext2D,
  area: Area,
  view: ChartView,
  palette: ChartPalette,
  scales: Scales,
): void {
  if (view.selection === null) {
    return;
  }

  const from = Math.max(area.left, scales.toX(view.selection.from));
  const to = Math.min(area.right, scales.toX(view.selection.to));
  if (to <= from) {
    return;
  }

  context.save();
  context.fillStyle = palette.selectionFill;
  context.fillRect(from, area.top, to - from, area.bottom - area.top);
  context.strokeStyle = palette.selectionBorder;
  context.lineWidth = 1;
  context.strokeRect(from + 0.5, area.top + 0.5, Math.max(0, to - from - 1), area.bottom - area.top - 1);
  context.restore();
}

/** Линия под курсором и точки на рядах. */
function drawHover(
  context: CanvasRenderingContext2D,
  area: Area,
  spec: ChartSpec,
  points: readonly ChartPoint[],
  scales: Scales,
  palette: ChartPalette,
  view: ChartView,
): void {
  if (view.hoverT === null || points.length === 0) {
    return;
  }

  const hoverT = view.hoverT;
  const nearest = points.reduce((best, point) =>
    Math.abs(point.t - hoverT) < Math.abs(best.t - hoverT) ? point : best);

  const x = Math.round(scales.toX(nearest.t)) + 0.5;
  context.save();
  context.strokeStyle = palette.crosshair;
  context.lineWidth = 1;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(x, area.top);
  context.lineTo(x, area.bottom);
  context.stroke();
  context.setLineDash([]);

  for (const series of spec.series) {
    if (series.tooltip === false) {
      continue;
    }

    const y = scales.toY(nearest[series.key]);
    context.beginPath();
    context.fillStyle = palette.resolveColor(series.color);
    context.arc(x, y, 3, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = palette.selectionBorder;
    context.lineWidth = 1.5;
    context.stroke();
  }

  context.restore();
}

/** Надпись по центру области, когда данных ещё нет. */
function drawPlaceholder(
  context: CanvasRenderingContext2D,
  area: Area,
  palette: ChartPalette,
  text: string,
): void {
  context.save();
  context.fillStyle = palette.text;
  context.font = palette.font;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, (area.left + area.right) / 2, (area.top + area.bottom) / 2);
  context.restore();
}

/** Цвет отметки по поколению объекта. */
function generationColor(generation: number, palette: ChartPalette): string {
  switch (generation) {
    case 0:
      return palette.gen0;
    case 1:
      return palette.gen1;
    default:
      return palette.gen2;
  }
}

/** Время в формате ЧЧ:ММ:СС. */
function formatClockTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
