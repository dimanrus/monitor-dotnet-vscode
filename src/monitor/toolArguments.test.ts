/** Проверки имени Speedscope-файла. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cpuSnapshotArgs,
  formatToolDuration,
  netTraceFileFor,
  speedscopeFileFor,
  traceBaseFor,
  traceTopNArgs,
} from './toolArguments.ts';

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

test('парный .nettrace находится для снимка CPU и для самой трассировки', () => {
  assert.equal(
    netTraceFileFor('/out/cpu-12.speedscope.json'),
    '/out/cpu-12.nettrace',
  );
  assert.equal(netTraceFileFor('/out/trace-12.nettrace'), '/out/trace-12.nettrace');
  // Для памяти и других файлов пары нет.
  assert.equal(netTraceFileFor('/out/memory-1.gcdump'), undefined);
  assert.equal(netTraceFileFor('/out/notes.txt'), undefined);
});

test('снимок CPU использует профиль dotnet-sampled-thread-time и длительность', () => {
  assert.deepEqual(cpuSnapshotArgs(12, '/out/cpu-12.nettrace', 5), [
    'collect',
    '-p', '12',
    '--profile', 'dotnet-sampled-thread-time',
    '--format', 'Speedscope',
    '--duration', '00:00:00:05',
    '-o', '/out/cpu-12.nettrace',
  ]);
  // Нулевая и дробная длительность превращаются в целую секунду, а не в пустой замер.
  assert.deepEqual(cpuSnapshotArgs(7, 'cpu.nettrace', 1.6), [
    'collect',
    '-p', '7',
    '--profile', 'dotnet-sampled-thread-time',
    '--format', 'Speedscope',
    '--duration', '00:00:00:02',
    '-o', 'cpu.nettrace',
  ]);
  assert.ok(cpuSnapshotArgs(1, 'cpu.nettrace', 0).includes('00:00:00:01'));
});

test('отчёт topN сортируется по exclusive или inclusive времени', () => {
  assert.deepEqual(traceTopNArgs('/out/trace.nettrace'), [
    'report', '/out/trace.nettrace', 'topN', '-n', '20',
  ]);
  assert.deepEqual(traceTopNArgs('/out/trace.nettrace', { number: 5, inclusive: true }), [
    'report', '/out/trace.nettrace', 'topN', '-n', '5', '--inclusive',
  ]);
  // Некорректное число не должно превращаться в пустой отчёт.
  assert.deepEqual(traceTopNArgs('trace.nettrace', { number: 0 }), [
    'report', 'trace.nettrace', 'topN', '-n', '1',
  ]);
});
