/**
 * Форматирование значений для панелей: байты, проценты, длительности и значения счётчиков.
 * Модуль используется и расширением, и панелью графиков, поэтому названия единиц берутся
 * из общего словаря (`core/locale.ts`), который знает текущий язык интерфейса.
 */

import { localeTag, word } from './locale.ts';
import type { BridgeCounterValue, BridgeMetricValue } from './protocol.ts';

const BYTE_UNIT_KEYS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** Форматирует размер в удобных единицах: 1331 → «1.3 KB». */
export function formatBytes(bytes: number | null | undefined, fractionDigits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return '—';
  }

  const negative = bytes < 0;
  let value = Math.abs(bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNIT_KEYS.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const digits = value >= 100 || unitIndex === 0 ? 0 : fractionDigits;
  const text = `${value.toFixed(digits)} ${word(BYTE_UNIT_KEYS[unitIndex])}`;
  return negative ? `-${text}` : text;
}

/** Форматирует число: крупные значения — с разделителями разрядов и сокращениями. */
export function formatNumber(value: number | null | undefined, fractionDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(2)} ${word('billion')}`;
  }

  if (absolute >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)} ${word('million')}`;
  }

  if (absolute >= 1000) {
    return Math.round(value).toLocaleString(localeTag());
  }

  if (Number.isInteger(value)) {
    return value.toString();
  }

  return value.toFixed(fractionDigits).replace(/\.?0+$/, '');
}

/** Форматирует процент: 12.34 → «12.3 %». */
export function formatPercent(value: number | null | undefined, fractionDigits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  return `${value.toFixed(fractionDigits)} %`;
}

/** Форматирует длительность в миллисекундах. */
export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return '—';
  }

  if (milliseconds < 1) {
    return `${milliseconds.toFixed(2)} ${word('millisecondShort')}`;
  }

  if (milliseconds < 1000) {
    return `${milliseconds.toFixed(1)} ${word('millisecondShort')}`;
  }

  return `${(milliseconds / 1000).toFixed(2)} ${word('secondShort')}`;
}

/**
 * Значение счётчика с единицами измерения.
 * Счётчики-суммы уже приведены мостом к масштабу времени, поэтому подписываем их «/с».
 */
export function formatCounterValue(counter: BridgeCounterValue): string {
  const unit = counter.unit ?? '';
  const isPerSecond = (counter.counterType ?? '').toLowerCase() === 'sum' && counter.intervalSeconds > 0;
  const suffix = isPerSecond ? `${unit}/${word('secondShort')}`.trim() : unit;
  return `${formatNumber(counter.value)}${suffix.length > 0 ? ` ${suffix}` : ''}`.trim();
}

/** Значение метрики с единицами измерения. */
export function formatMetricValue(metric: BridgeMetricValue): string {
  const unit = metric.unit ?? '';
  return `${formatNumber(metric.value)}${unit.length > 0 ? ` ${unit}` : ''}`.trim();
}

/** Описание счётчика с единицами и типом — для подсказок. */
export function describeCounter(counter: BridgeCounterValue): string {
  const parts = [
    word('seriesAverage', formatNumber(counter.mean ?? counter.value)),
    word('seriesInterval', counter.intervalSeconds.toFixed(1)),
  ];

  if (counter.min !== null && counter.max !== null) {
    parts.push(word('seriesMin', formatNumber(counter.min)), word('seriesMax', formatNumber(counter.max)));
  }

  if (counter.counterType) {
    parts.push(word('seriesType', counter.counterType));
  }

  return parts.join(word('partSeparator'));
}

/** Описание метрики — для подсказок. */
export function describeMetric(metric: BridgeMetricValue): string {
  const parts = [word('metricKind', translateMetricKind(metric.kind))];
  if (metric.rate !== null) {
    parts.push(word('metricRate', formatNumber(metric.rate)));
  }

  if (metric.count !== null) {
    parts.push(word('metricMeasurements', formatNumber(metric.count, 0)));
  }

  if (metric.description) {
    parts.push(metric.description);
  }

  if (metric.tags) {
    parts.push(metric.tags);
  }

  return parts.join(word('partSeparator'));
}

/** Человекочитаемый вид инструмента метрик. */
export function translateMetricKind(kind: string): string {
  switch (kind) {
    case 'counter':
      return word('kindCounter');
    case 'updowncounter':
      return word('kindUpDownCounter');
    case 'gauge':
      return word('kindGauge');
    case 'histogram':
      return word('kindHistogram');
    default:
      return kind;
  }
}

/** Форматирует время события как «12:34:56» с учётом языка. */
export function formatClockTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString(localeTag(), { hour12: false });
}

/** Обрезает длинный текст, добавляя многоточие. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}
