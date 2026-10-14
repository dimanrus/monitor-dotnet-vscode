/**
 * Поиск проблем производительности в собранных данных.
 *
 * Модуль анализирует уже накопленные точки и события GC и отмечает интервалы,
 * на которые стоит обратить внимание: загрузка процессора в потолок, долгие паузы сборки мусора,
 * рост скорости выделения памяти. Результат показывается списком в панели графиков,
 * а сами интервалы подсвечиваются прямо на графике.
 *
 * Логика не зависит от API VS Code, поэтому её проверяют тесты.
 */

import type { ChartGcEvent, ChartIssue, ChartPoint, IssueKind, IssueSeverity } from './chartData.ts';
import { formatBytes, formatDuration, formatPercent } from './formatting.ts';
import { translate } from './locale.ts';

/** Пороги срабатывания. */
export interface IssueThresholds {
  /** Загрузка процессора, с которой начинается «упор в потолок», %. */
  cpuSaturatedPercent: number;
  /** Сколько подряд идущих точек с высокой загрузкой считаем проблемой. */
  cpuSaturatedPoints: number;
  /** Разрыв между всплесками, который ещё считается одним интервалом, в точках. */
  mergeGapPoints: number;
  /** Пауза сборки мусора, с которой начинаем предупреждать, мс. */
  gcPauseWarningMs: number;
  /** Пауза сборки мусора, которую считаем серьёзной, мс. */
  gcPauseCriticalMs: number;
  /** Длина окна для оценки частоты сборок, мс. */
  gcPressureWindowMs: number;
  /** Сколько сборок в окне считаем признаком давления, штук. */
  gcPressureCollections: number;
  /** Суммарная пауза в окне, после которой предупреждаем, мс. */
  gcPressureTotalPauseMs: number;
  /** Во сколько раз скорость выделения должна превысить обычную. */
  allocationSpikeFactor: number;
  /** Минимальная скорость выделения для проверки на всплеск, байт/с. */
  allocationSpikeFloorBytesPerSec: number;
  /** Сколько точек подряд должны превышать норму. */
  allocationSpikePoints: number;
  /** Максимальное число проблем в списке. */
  maxIssues: number;
}

/** Значения порогов по умолчанию: подобраны по практике профилирования. */
export const ISSUE_THRESHOLDS: IssueThresholds = {
  /** Загрузка процессора, с которой начинается «упор в потолок», %. */
  cpuSaturatedPercent: 90,
  /** Сколько подряд идущих точек с высокой загрузкой считаем проблемой. */
  cpuSaturatedPoints: 3,
  /** Разрыв между всплесками, который ещё считается одним интервалом, в точках. */
  mergeGapPoints: 2,
  /** Пауза сборки мусора, с которой начинаем предупреждать, мс. */
  gcPauseWarningMs: 100,
  /** Пауза сборки мусора, которую считаем серьёзной, мс. */
  gcPauseCriticalMs: 300,
  /** Длина окна для оценки частоты сборок, мс. */
  gcPressureWindowMs: 10_000,
  /** Сколько сборок в окне считаем признаком давления, штук. */
  gcPressureCollections: 10,
  /** Суммарная пауза в окне, после которой предупреждаем, мс. */
  gcPressureTotalPauseMs: 200,
  /** Во сколько раз скорость выделения должна превысить обычную. */
  allocationSpikeFactor: 3,
  /** Минимальная скорость выделения для проверки на всплеск, байт/с. */
  allocationSpikeFloorBytesPerSec: 1024 * 1024,
  /** Сколько точек подряд должны превышать норму. */
  allocationSpikePoints: 2,
  /** Максимальное число проблем в списке. */
  maxIssues: 20,
};

/**
 * Находит проблемы в собранных данных.
 * Возвращает список от новых к старым: пользователю важнее свежие интервалы.
 */
export function detectIssues(
  points: readonly ChartPoint[],
  gcEvents: readonly ChartGcEvent[],
  thresholds: IssueThresholds = ISSUE_THRESHOLDS,
): ChartIssue[] {
  if (points.length === 0) {
    return [];
  }

  const issues: ChartIssue[] = [
    ...detectCpuSaturation(points, thresholds),
    ...detectGcPauses(gcEvents, thresholds),
    ...detectGcPressure(gcEvents, points, thresholds),
    ...detectAllocationSpikes(points, thresholds),
  ];

  // Свежие интервалы важнее: сортируем по времени окончания и ограничиваем список.
  return issues
    .sort((left, right) => right.toMs - left.toMs)
    .slice(0, thresholds.maxIssues);
}

/** Загрузка процессора держится у потолка. */
function detectCpuSaturation(points: readonly ChartPoint[], thresholds: IssueThresholds): ChartIssue[] {
  const runs = collectRuns(
    points,
    point => point.cpu >= thresholds.cpuSaturatedPercent,
    thresholds.mergeGapPoints,
  );

  return runs
    .filter(run => run.length >= thresholds.cpuSaturatedPoints)
    .map(run => {
      const peak = Math.max(...run.map(point => point.cpu));
      const durationMs = run[run.length - 1].t - run[0].t;

      return {
        id: `cpu-saturation:${run[0].t}`,
        kind: 'cpu-saturation' as IssueKind,
        chart: 'cpu',
        severity: 'warning' as IssueSeverity,
        fromMs: run[0].t,
        toMs: run[run.length - 1].t,
        title: translate('CPU is pegged at full load'),
        details: translate(
          'Load stayed above {0} for {1} (peak {2}).',
          formatPercent(thresholds.cpuSaturatedPercent, 0),
          formatDuration(durationMs),
          formatPercent(peak),
        ),
      };
    });
}

/** Отдельные долгие паузы сборки мусора. */
function detectGcPauses(gcEvents: readonly ChartGcEvent[], thresholds: IssueThresholds): ChartIssue[] {
  return gcEvents
    .filter(event => (event.dur ?? 0) >= thresholds.gcPauseWarningMs)
    .map(event => {
      const pause = event.dur ?? 0;
      const severity: IssueSeverity = pause >= thresholds.gcPauseCriticalMs ? 'critical' : 'warning';

      return {
        id: `gc-pause:${event.t}:${event.gen}`,
        kind: 'gc-pause' as IssueKind,
        chart: 'gc',
        severity,
        // Пауза могла начаться раньше отметки о завершении, поэтому интервал начинаем со сдвигом.
        fromMs: event.t - pause,
        toMs: event.t,
        title: translate('Long garbage collection pause'),
        details: translate('gen{0} paused for {1}{2}.', event.gen, formatDuration(pause), reasonSuffix(event.reason)),
      };
    });
}

/** Сборки мусора идут слишком часто и суммарно отнимают много времени. */
function detectGcPressure(
  gcEvents: readonly ChartGcEvent[],
  points: readonly ChartPoint[],
  thresholds: IssueThresholds,
): ChartIssue[] {
  if (gcEvents.length === 0) {
    return [];
  }

  const lastPointMs = points[points.length - 1].t;
  const firstPointMs = points[0].t;
  const result: ChartIssue[] = [];

  // Идём окнами по времени: в каждом считаем число сборок и суммарную паузу.
  for (let windowStart = firstPointMs; windowStart <= lastPointMs; windowStart += thresholds.gcPressureWindowMs) {
    const windowEnd = windowStart + thresholds.gcPressureWindowMs;
    const inWindow = gcEvents.filter(event => event.t > windowStart && event.t <= windowEnd);
    if (inWindow.length < thresholds.gcPressureCollections) {
      continue;
    }

    const totalPause = inWindow.reduce((sum, event) => sum + (event.dur ?? 0), 0);
    if (totalPause < thresholds.gcPressureTotalPauseMs) {
      continue;
    }

    result.push({
      id: `gc-pressure:${windowStart}`,
      kind: 'gc-pressure',
      chart: 'gc',
      severity: 'warning',
      fromMs: windowStart,
      toMs: windowEnd,
      title: translate('Frequent garbage collections'),
      details: translate(
        '{0} collections in {1}, {2} spent in pauses.',
        inWindow.length,
        formatDuration(thresholds.gcPressureWindowMs),
        formatDuration(totalPause),
      ),
    });
  }

  return result;
}

/** Скорость выделения памяти резко выросла относительно обычной. */
function detectAllocationSpikes(points: readonly ChartPoint[], thresholds: IssueThresholds): ChartIssue[] {
  if (points.length < thresholds.allocationSpikePoints) {
    return [];
  }

  const rates = points.map(point => point.alloc).filter(rate => rate > 0);
  if (rates.length === 0) {
    return [];
  }

  const baseline = median(rates);
  // Порог не опускается ниже «пола»: иначе мелкие колебания на пустом профиле дают ложные срабатывания.
  const limit = Math.max(baseline * thresholds.allocationSpikeFactor, thresholds.allocationSpikeFloorBytesPerSec);

  const runs = collectRuns(points, point => point.alloc >= limit, thresholds.mergeGapPoints);

  return runs
    .filter(run => run.length >= thresholds.allocationSpikePoints)
    .map(run => {
      const peak = Math.max(...run.map(point => point.alloc));

      return {
        id: `allocation-spike:${run[0].t}`,
        kind: 'allocation-spike' as IssueKind,
        chart: 'gc',
        severity: 'info' as IssueSeverity,
        fromMs: run[0].t,
        toMs: run[run.length - 1].t,
        title: translate('Memory allocation spike'),
        details: translate(
          'Allocation rate reached {0}/s against the usual {1}/s.',
          formatBytes(peak),
          formatBytes(baseline),
        ),
      };
    });
}

/**
 * Собирает интервалы из подряд идущих точек, подходящих под условие.
 * Короткие разрывы (до `mergeGapPoints` точек) внутри одного интервала объединяются:
 * одиночный провал обычно не означает, что проблема закончилась.
 */
function collectRuns(
  points: readonly ChartPoint[],
  matches: (point: ChartPoint) => boolean,
  mergeGapPoints: number,
): ChartPoint[][] {
  const runs: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  let gap = 0;

  for (const point of points) {
    if (matches(point)) {
      current.push(point);
      gap = 0;
      continue;
    }

    if (current.length === 0) {
      continue;
    }

    gap++;
    if (gap > mergeGapPoints) {
      runs.push(current);
      current = [];
      gap = 0;
    }
  }

  if (current.length > 0) {
    runs.push(current);
  }

  return runs;
}

/** Медиана значений: устойчива к выбросам, в отличие от среднего. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** Причина сборки в скобках, если она известна. */
function reasonSuffix(reason: string): string {
  return reason.length > 0 ? ` (${reason})` : '';
}
