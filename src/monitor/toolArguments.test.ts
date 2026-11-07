/** Проверки имени Speedscope-файла. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolDuration, speedscopeFileFor, traceBaseFor } from './toolArguments.ts';

test('имя Speedscope-файла строится из имени трассировки', () => {
  assert.equal(
    speedscopeFileFor('/project/.monitor-dotnet/trace-123.nettrace'),
    '/project/.monitor-dotnet/trace-123.speedscope.json',
  );
  // Расширение в верхнем регистре тоже встречается на Windows.
  assert.equal(speedscopeFileFor('C:/out/trace.Nettrace'), 'C:/out/trace.speedscope.json');
});

test('для convert расширение снимается: инструмент добавляет своё', () => {
  assert.equal(traceBaseFor('/out/trace-123.nettrace'), '/out/trace-123');
  assert.equal(traceBaseFor('/out/trace-123'), '/out/trace-123');
});

test('длительность передаётся в формате dd:hh:mm:ss', () => {
  assert.equal(formatToolDuration(30), '00:00:00:30');
  assert.equal(formatToolDuration(90), '00:00:01:30');
  assert.equal(formatToolDuration(3_600), '00:01:00:00');
  assert.equal(formatToolDuration(90_061), '01:01:01:01');
  assert.equal(formatToolDuration(0), '00:00:00:00');
});
