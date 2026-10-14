/**
 * Данные для графиков панели Performance.
 * Здесь только чистая логика: преобразование точек, округление шкалы и разметка осей —
 * это позволяет проверять её тестами без браузера.
 */

import type { BridgeGcEventValue, BridgeHelloMessage } from './protocol.ts';
import type { ProcessSeriesPoint } from './monitorState.ts';

/** Точка ряда в компактном виде: короткие ключи уменьшают объём сообщений в webview. */
export interface ChartPoint {
  /** Время, миллисекунды UNIX. */
  t: number;
  /** Загрузка процессора, %. */
  cpu: number;
  /** Приватная память, байты. */
  priv: number;
  /** Рабочий набор, байты. */
  ws: number;
  /** Управляемая куча, байты. */
  heap: number;
  /** Скорость выделения памяти, байт/с. */
  alloc: number;
  /** Доля времени в сборке мусора, %. */
  tig: number;
  /** Число потоков. */
  thr: number;
}

/** Событие сборки мусора для отметок на графике. */
export interface ChartGcEvent {
  t: number;
  /** Поколение: 0, 1 или 2. */
  gen: number;
  /** Длительность паузы в миллисекундах (если известна). */
  dur: number | null;
  reason: string;
}

/** Вид найденной проблемы. */
export type IssueKind = 'cpu-saturation' | 'gc-pause' | 'gc-pressure' | 'allocation-spike';

/** Важность проблемы: от информационной до критичной. */
export type IssueSeverity = 'info' | 'warning' | 'critical';

/** Найденная проблема производительности с интервалом времени. */
export interface ChartIssue {
  /** Стабильный ключ: по нему панель отличает новые проблемы от уже показанных. */
  id: string;
  kind: IssueKind;
  /** График, на котором проблема отображается. */
  chart: 'cpu' | 'gc' | 'memory';
  severity: IssueSeverity;
  fromMs: number;
  toMs: number;
  /** Заголовок и описание уже переведены на язык пользователя. */
  title: string;
  details: string;
}

/** Сведения о процессе и состоянии монитора — для шапки панели. */
export interface ChartMeta {
  pid: number;
  processName: string;
  runtimeVersion: string | null;
  os: string;
  architecture: string;
  processorCount: number;
  refreshIntervalSeconds: number;
  /** Сколько секунд данных показывать на графиках. */
  windowSeconds: number;
  /** Накопленное число сборок мусора по поколениям. */
  gcCollections: { gen0: number; gen1: number; gen2: number };
  /** Состояние монитора: idle | connecting | running | stopped | failed. */
  status: string;
  /** Пояснение к состоянию. */
  hint: string | null;
}

/** Предел числа точек, которые отправляются в webview. */
export const CHART_HISTORY_LIMIT = 5000;

/** Преобразует точку состояния в компактную точку графика. */
export function toChartPoint(point: ProcessSeriesPoint): ChartPoint {
  return {
    t: point.timestampMs,
    cpu: point.cpuPercent,
    priv: point.privateMemoryBytes,
    ws: point.workingSetBytes,
    heap: point.managedHeapBytes,
    alloc: point.allocationRateBytesPerSec,
    tig: point.timeInGcPercent,
    thr: point.threadCount,
  };
}

/**
 * Преобразует событие GC в отметку графика.
 * Берём только завершённые сборки: у них известна длительность паузы.
 */
export function toChartGcEvent(event: BridgeGcEventValue): ChartGcEvent | undefined {
  if (event.phase !== 'stop') {
    return undefined;
  }

  return {
    t: event.timestampUnixMs,
    gen: event.generation,
    dur: event.durationMs,
    reason: event.reason,
  };
}

/** Формирует сведения для шапки панели. */
export function buildChartMeta(
  hello: BridgeHelloMessage | undefined,
  status: string,
  hint: string | null,
  refreshIntervalSeconds: number,
  windowSeconds: number,
  gcCollections: { gen0: number; gen1: number; gen2: number },
): ChartMeta {
  return {
    pid: hello?.pid ?? 0,
    processName: hello?.processName ?? '',
    runtimeVersion: hello?.runtimeVersion ?? null,
    os: hello?.os ?? '',
    architecture: hello?.architecture ?? '',
    processorCount: hello?.processorCount ?? 0,
    refreshIntervalSeconds,
    windowSeconds,
    gcCollections,
    status,
    hint,
  };
}

/**
 * Округляет верхнюю границу шкалы вверх до «красивого» числа,
 * чтобы подписи оси были читаемыми (1, 2, 5, 10 × 10^n).
 */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;

  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Строит значения для горизонтальных линий сетки от нуля до максимума.
 * Возвращает список пар «значение — доля от максимума» в порядке возрастания.
 */
export function buildValueTicks(maxValue: number, count = 4): number[] {
  const limit = niceCeiling(maxValue);
  if (limit <= 0 || count < 1) {
    return [];
  }

  const ticks: number[] = [];
  for (let index = 0; index <= count; index++) {
    ticks.push((limit / count) * index);
  }

  return ticks;
}

/**
 * Строит отметки времени для горизонтальной оси: не более `count` штук
 * равномерно по видимому диапазону.
 */
export function buildTimeTicks(fromMs: number, toMs: number, count = 6): number[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || count < 1) {
    return [];
  }

  const ticks: number[] = [];
  for (let index = 0; index <= count; index++) {
    ticks.push(fromMs + ((toMs - fromMs) / count) * index);
  }

  return ticks;
}

/**
 * Небольшое сглаживание для плавности линий: значение берётся как среднее
 * с двумя соседями. Мгновенные пики при этом сохраняются, если окно маленькое.
 */
export function smooth(values: readonly number[], enabled: boolean): number[] {
  if (!enabled || values.length < 3) {
    return [...values];
  }

  const result: number[] = [values[0]];
  for (let index = 1; index < values.length - 1; index++) {
    result.push((values[index - 1] + values[index] * 2 + values[index + 1]) / 4);
  }

  result.push(values[values.length - 1]);
  return result;
}
