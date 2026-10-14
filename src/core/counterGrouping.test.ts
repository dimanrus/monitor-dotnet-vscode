import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupCounters } from './counterGrouping.ts';
import type { CounterSample, MetricSample } from './monitorState.ts';

function counter(provider: string, name: string, value: number): CounterSample {
  return {
    provider,
    name,
    displayName: `${name} display`,
    unit: 'B',
    counterType: 'Mean',
    value,
    mean: value,
    min: value,
    max: value,
    standardDeviation: 0,
    intervalSeconds: 1,
    series: null,
    sampleCount: 1,
    timestampMs: 1000,
  };
}

function metric(meter: string, instrument: string, value: number, tags: string | null = null): MetricSample {
  return {
    meter,
    meterVersion: null,
    instrument,
    kind: 'counter',
    unit: null,
    value,
    rate: null,
    count: null,
    sum: null,
    tags,
    description: null,
    timestampMs: 1000,
  };
}

test('groupCounters: группирует счётчики по провайдеру, а метрики — по метру', () => {
  const groups = groupCounters(
    [counter('System.Runtime', 'cpu-usage', 5), counter('SampleApp', 'sample-queue', 2)],
    [metric('SampleApp', 'app.requests', 10), metric('System.Runtime', 'dotnet.thread.count', 8)],
  );

  // Группы сортируются по имени, при одинаковых именах счётчики идут перед метриками.
  const labels = groups.map(group => `${group.kind}:${group.label}`);
  assert.deepEqual(labels, [
    'counter:SampleApp',
    'metric:SampleApp',
    'counter:System.Runtime',
    'metric:System.Runtime',
  ]);
});

test('groupCounters: элементы внутри группы отсортированы и содержат значение', () => {
  const groups = groupCounters(
    [counter('System.Runtime', 'working-set', 1024), counter('System.Runtime', 'alloc-rate', 2048)],
    [],
  );

  const group = groups[0];
  assert.equal(group.items.length, 2);
  assert.equal(group.items[0].label, 'alloc-rate display');
  assert.match(group.items[0].description, /2/);
  assert.match(group.items[0].tooltip, /System.Runtime/);
});

test('groupCounters: метрики с разными тегами не смешиваются', () => {
  const groups = groupCounters([], [
    metric('SampleApp', 'app.requests', 1, '{"endpoint":"/a"}'),
    metric('SampleApp', 'app.requests', 2, '{"endpoint":"/b"}'),
  ]);

  assert.equal(groups[0].items.length, 2);
  assert.notEqual(groups[0].items[0].key, groups[0].items[1].key);
});
