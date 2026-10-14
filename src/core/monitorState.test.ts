import assert from 'node:assert/strict';
import { test } from 'node:test';
import { counterKey, MonitorState } from './monitorState.ts';
import type { BridgeSampleMessage } from './protocol.ts';

function createSample(timestampMs: number, overrides: Partial<BridgeSampleMessage['process']> = {}): BridgeSampleMessage {
  return {
    type: 'sample',
    timestampUnixMs: timestampMs,
    process: {
      cpuPercent: 10,
      privateMemoryBytes: 100_000_000,
      workingSetBytes: 80_000_000,
      threadCount: 12,
      managedHeapBytes: 20_000_000,
      gen0HeapBytes: 1,
      gen1HeapBytes: 2,
      gen2HeapBytes: 3,
      lohHeapBytes: 4,
      allocationRateBytesPerSec: 1024,
      timeInGcPercent: 2,
      gcCollections: { gen0: 1, gen1: 2, gen2: 3 },
      exceptionsPerSecond: 0,
      ...overrides,
    },
    counters: [{
      provider: 'System.Runtime',
      name: 'cpu-usage',
      displayName: 'CPU Usage',
      unit: '%',
      counterType: 'Mean',
      value: 10,
      mean: 10,
      min: 9,
      max: 11,
      standardDeviation: 1,
      intervalSeconds: 1,
      series: null,
      sampleCount: 1,
    }],
    metrics: [{
      meter: 'SampleApp',
      meterVersion: null,
      instrument: 'app.requests',
      kind: 'counter',
      unit: null,
      value: 5,
      rate: 5,
      count: null,
      sum: null,
      tags: null,
      description: null,
    }],
    gcEvents: [{
      timestampUnixMs: timestampMs,
      generation: 1,
      reason: 'AllocSmall',
      gcType: 'NonConcurrentGC',
      phase: 'stop',
      durationMs: 3,
      count: 7,
    }],
  };
}

test('applySample: наполняет ряд, счётчики и метрики', () => {
  const state = new MonitorState();
  state.applySample(createSample(1000));

  assert.equal(state.series.length, 1);
  assert.equal(state.latest?.cpuPercent, 10);
  assert.equal(state.counters.size, 1);
  assert.equal(state.counters.get(counterKey('System.Runtime', 'cpu-usage'))?.value, 10);
  assert.equal(state.metrics.size, 1);
  assert.equal(state.gcEvents.length, 1);
  assert.equal(state.status, 'running');
});

test('applySample: история ограничена окном', () => {
  const state = new MonitorState();
  state.setMaxPoints(5);
  for (let index = 0; index < 20; index++) {
    state.applySample(createSample(index));
  }

  assert.equal(state.series.length, 5);
  assert.equal(state.latest?.timestampMs, 19);
});

test('applySample: последнее значение счётчика перезаписывается', () => {
  const state = new MonitorState();
  state.applySample(createSample(1000));

  const updated = createSample(2000);
  updated.counters[0] = { ...updated.counters[0], value: 55 };
  state.applySample(updated);

  assert.equal(state.counters.size, 1);
  assert.equal(state.counters.get(counterKey('System.Runtime', 'cpu-usage'))?.value, 55);
});

test('gcEvents: число хранимых событий ограничено', () => {
  const state = new MonitorState();
  for (let index = 0; index < 700; index++) {
    state.applySample(createSample(index));
  }

  assert.ok(state.gcEvents.length <= 500);
});

test('подписчики получают уведомления об изменениях', () => {
  const state = new MonitorState();
  let notifications = 0;
  const unsubscribe = state.onDidChange(() => notifications++);

  state.applySample(createSample(1));
  state.clear();
  unsubscribe();
  state.applySample(createSample(2));

  assert.equal(notifications, 2);
});

test('reset: очищает данные и сведения о процессе', () => {
  const state = new MonitorState();
  state.applySample(createSample(1));
  state.applyHello({
    type: 'hello',
    protocolVersion: '1.0',
    pid: 42,
    processName: 'app',
    runtimeVersion: '10.0.0',
    os: 'Linux',
    architecture: 'X64',
    commandLine: null,
    processorCount: 8,
    startedAtUnixMs: 0,
  });

  state.reset();

  assert.equal(state.series.length, 0);
  assert.equal(state.hello, undefined);
  assert.equal(state.status, 'idle');
});

test('applyError: фатальная ошибка переводит состояние в failed', () => {
  const state = new MonitorState();
  state.applyError('нет доступа', true);

  assert.equal(state.status, 'failed');
  assert.equal(state.lastError, 'нет доступа');
});

test('range: показывает границы собранного ряда', () => {
  const state = new MonitorState();
  assert.equal(state.range, undefined, 'без данных диапазона быть не должно');

  state.applySample(createSample(1_000));
  state.applySample(createSample(3_000));

  assert.deepEqual(state.range, { fromMs: 1_000, toMs: 3_000 });
});

test('range: после очистки данных диапазона снова нет', () => {
  const state = new MonitorState();
  state.applySample(createSample(1_000));
  state.clear();

  assert.equal(state.range, undefined);
});
