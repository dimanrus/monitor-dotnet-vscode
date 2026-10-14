import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeCounter,
  describeMetric,
  formatBytes,
  formatCounterValue,
  formatDuration,
  formatMetricValue,
  formatNumber,
  formatPercent,
  truncate,
} from './formatting.ts';
import { configureLocale } from './locale.ts';
import type { BridgeCounterValue, BridgeMetricValue } from './protocol.ts';

function createCounter(overrides: Partial<BridgeCounterValue> = {}): BridgeCounterValue {
  return {
    provider: 'System.Runtime',
    name: 'cpu-usage',
    displayName: 'CPU Usage',
    unit: '%',
    counterType: 'Mean',
    value: 12.34,
    mean: 12.34,
    min: 10,
    max: 15,
    standardDeviation: 1,
    intervalSeconds: 1,
    series: 'Interval=1000',
    sampleCount: 1,
    ...overrides,
  };
}

function createMetric(overrides: Partial<BridgeMetricValue> = {}): BridgeMetricValue {
  return {
    meter: 'SampleApp',
    meterVersion: '1.0.0',
    instrument: 'app.requests',
    kind: 'counter',
    unit: '{request}',
    value: 42,
    rate: 4.2,
    count: null,
    sum: null,
    tags: null,
    description: null,
    ...overrides,
  };
}

test('formatBytes: переводит в подходящие единицы', () => {
  configureLocale('en');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15.0 MB');
  assert.equal(formatBytes(null), '—');

  configureLocale('ru');
  assert.equal(formatBytes(512), '512 Б');
  assert.equal(formatBytes(1536), '1.5 КБ');
  assert.equal(formatBytes(15 * 1024 * 1024), '15.0 МБ');
  configureLocale('en');
});

test('formatNumber: сокращения и разделители зависят от языка', () => {
  configureLocale('en');
  assert.equal(formatNumber(1234), '1,234');
  assert.equal(formatNumber(2_500_000), '2.50 M');
  assert.equal(formatNumber(0.5), '0.5');
  assert.equal(formatNumber(-3), '-3');

  configureLocale('ru');
  assert.equal(formatNumber(1234), '1\u00a0234');
  assert.equal(formatNumber(2_500_000), '2.50 млн');
  configureLocale('en');
});

test('formatPercent и formatDuration', () => {
  configureLocale('en');
  assert.equal(formatPercent(12.34), '12.3 %');
  assert.equal(formatDuration(0.5), '0.50 ms');
  assert.equal(formatDuration(250), '250.0 ms');
  assert.equal(formatDuration(2500), '2.50 s');

  configureLocale('ru');
  assert.equal(formatDuration(250), '250.0 мс');
  assert.equal(formatDuration(2500), '2.50 с');
  configureLocale('en');
});

test('formatCounterValue: счётчики-суммы показываются в секунду', () => {
  configureLocale('en');
  const perSecond = createCounter({ name: 'alloc-rate', unit: 'B', counterType: 'Sum', value: 1024 });
  const plain = createCounter();

  assert.equal(formatCounterValue(perSecond), '1,024 B/s');
  assert.equal(formatCounterValue(plain), '12.34 %');
});

test('formatMetricValue: добавляет единицы измерения', () => {
  configureLocale('en');
  assert.equal(formatMetricValue(createMetric()), '42 {request}');
  assert.equal(formatMetricValue(createMetric({ unit: null })), '42');
});

test('describeCounter: статистика интервала на текущем языке', () => {
  configureLocale('en');
  const english = describeCounter(createCounter());
  assert.match(english, /Average/);
  assert.match(english, /Interval: 1\.0 s/);
  assert.match(english, /Max/);

  configureLocale('ru');
  const russian = describeCounter(createCounter());
  assert.match(russian, /Среднее/);
  assert.match(russian, /Интервал: 1\.0 с/);
  assert.match(russian, /Макс/);
  configureLocale('en');
});

test('translateMetricKind: виды инструментов переводятся', () => {
  configureLocale('en');
  assert.equal(describeMetric(createMetric({ kind: 'histogram' })).startsWith('Kind: histogram'), true);

  configureLocale('ru');
  assert.equal(describeMetric(createMetric({ kind: 'histogram' })).startsWith('Вид: гистограмма'), true);
  configureLocale('en');
});

test('truncate: обрезает длинный текст', () => {
  assert.equal(truncate('короткий', 20), 'короткий');
  assert.equal(truncate('длинный текст', 8), 'длинный…');
});
