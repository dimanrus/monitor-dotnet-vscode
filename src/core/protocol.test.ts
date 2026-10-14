import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUsableSample, parseBridgeMessage, PROTOCOL_VERSION } from './protocol.ts';

test('parseBridgeMessage: разбирает сообщение моста', () => {
  const message = parseBridgeMessage('{"type":"status","state":"running","message":null}');

  assert.equal(message?.type, 'status');
});

test('parseBridgeMessage: игнорирует пустые и повреждённые строки', () => {
  assert.equal(parseBridgeMessage(''), null);
  assert.equal(parseBridgeMessage('   '), null);
  assert.equal(parseBridgeMessage('{ не json }'), null);
  assert.equal(parseBridgeMessage('42'), null);
  assert.equal(parseBridgeMessage('{"безТипа":true}'), null);
});

test('parseBridgeMessage: неизвестный тип не проходит проверку', () => {
  assert.equal(parseBridgeMessage('{"type":"unknown-message"}'), null);
});

test('isUsableSample: отбрасывает срезы без числовых показателей', () => {
  const valid = {
    type: 'sample' as const,
    timestampUnixMs: 1000,
    process: {
      cpuPercent: 1,
      privateMemoryBytes: 2,
      workingSetBytes: 3,
      threadCount: 4,
      managedHeapBytes: 5,
      gen0HeapBytes: 0,
      gen1HeapBytes: 0,
      gen2HeapBytes: 0,
      lohHeapBytes: 0,
      allocationRateBytesPerSec: 0,
      timeInGcPercent: 0,
      gcCollections: { gen0: 0, gen1: 0, gen2: 0 },
      exceptionsPerSecond: null,
    },
    counters: [],
    metrics: [],
    gcEvents: [],
  };

  assert.equal(isUsableSample(valid), true);
  assert.equal(isUsableSample({ ...valid, process: { ...valid.process, cpuPercent: Number.NaN } }), false);
});

test('версия протокола расширения совпадает с версией в мосте', async () => {
  // Версия должна совпадать со значением ProtocolVersion.Current в bridge/MonitorDotnet.Bridge/Protocol/ProtocolVersion.cs.
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const bridgeFile = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'bridge',
    'MonitorDotnet.Bridge',
    'Protocol',
    'ProtocolVersion.cs',
  );

  const content = await readFile(bridgeFile, 'utf8');
  assert.match(content, new RegExp(`Current\\s*=\\s*"${PROTOCOL_VERSION.replace('.', '\\.')}"`));
});
