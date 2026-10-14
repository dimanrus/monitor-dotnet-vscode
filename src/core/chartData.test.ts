import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildChartMeta,
  buildTimeTicks,
  buildValueTicks,
  niceCeiling,
  smooth,
  toChartGcEvent,
  toChartPoint,
} from './chartData.ts';
import type { BridgeGcEventValue } from './protocol.ts';
import type { ProcessSeriesPoint } from './monitorState.ts';

function seriesPoint(): ProcessSeriesPoint {
  return {
    timestampMs: 1000,
    cpuPercent: 12.5,
    privateMemoryBytes: 100,
    workingSetBytes: 80,
    managedHeapBytes: 60,
    allocationRateBytesPerSec: 40,
    timeInGcPercent: 1.5,
    threadCount: 7,
    gcCollections: { gen0: 1, gen1: 2, gen2: 3 },
  };
}

test('toChartPoint: переносит показатели и время', () => {
  const point = toChartPoint(seriesPoint());

  assert.equal(point.t, 1000);
  assert.equal(point.cpu, 12.5);
  assert.equal(point.priv, 100);
  assert.equal(point.heap, 60);
  assert.equal(point.thr, 7);
});

test('toChartGcEvent: берёт только завершённые сборки', () => {
  const start: BridgeGcEventValue = {
    timestampUnixMs: 1,
    generation: 1,
    reason: 'AllocSmall',
    gcType: 'NonConcurrentGC',
    phase: 'start',
    durationMs: null,
    count: 5,
  };
  const stop: BridgeGcEventValue = { ...start, phase: 'stop', durationMs: 3.5 };

  assert.equal(toChartGcEvent(start), undefined);
  assert.deepEqual(toChartGcEvent(stop), { t: 1, gen: 1, dur: 3.5, reason: 'AllocSmall' });
});

test('niceCeiling: округляет шкалу до читаемых значений', () => {
  assert.equal(niceCeiling(0.4), 0.5);
  assert.equal(niceCeiling(1.2), 2);
  assert.equal(niceCeiling(37), 50);
  assert.equal(niceCeiling(120), 200);
  assert.equal(niceCeiling(0), 1);
});

test('buildValueTicks: линии сетки идут от нуля до верхней границы', () => {
  const ticks = buildValueTicks(37, 4);

  assert.equal(ticks[0], 0);
  assert.equal(ticks.at(-1), 50);
  assert.equal(ticks.length, 5);
  for (let index = 1; index < ticks.length; index++) {
    assert.ok(ticks[index] > ticks[index - 1], 'значения должны возрастать');
  }
});

test('buildTimeTicks: метки равномерно покрывают диапазон', () => {
  const ticks = buildTimeTicks(1000, 3000, 2);

  assert.deepEqual(ticks, [1000, 2000, 3000]);
  assert.deepEqual(buildTimeTicks(2000, 1000), []);
});

test('smooth: сглаживает середину и сохраняет края', () => {
  const smoothed = smooth([10, 0, 10], true);

  assert.equal(smoothed[0], 10);
  assert.equal(smoothed[1], 5);
  assert.equal(smoothed[2], 10);
  assert.deepEqual(smooth([1, 2, 3], false), [1, 2, 3]);
});

test('buildChartMeta: подставляет данные процесса или значения по умолчанию', () => {
  const empty = buildChartMeta(undefined, 'idle', null, 1, 120, { gen0: 0, gen1: 0, gen2: 0 });
  assert.equal(empty.processName, '');
  assert.equal(empty.pid, 0);

  const meta = buildChartMeta({
    type: 'hello',
    protocolVersion: '1.0',
    pid: 42,
    processName: 'SampleApp',
    runtimeVersion: '10.0.0',
    os: 'Linux',
    architecture: 'X64',
    commandLine: null,
    processorCount: 8,
    startedAtUnixMs: 0,
  }, 'running', null, 1, 120, { gen0: 3, gen1: 2, gen2: 1 });

  assert.equal(meta.processName, 'SampleApp');
  assert.equal(meta.pid, 42);
  assert.equal(meta.windowSeconds, 120);
  assert.deepEqual(meta.gcCollections, { gen0: 3, gen1: 2, gen2: 1 });
});
