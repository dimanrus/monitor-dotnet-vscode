/** Проверки разбора снимков памяти `dotnet-gcdump report`. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeGcdumpOutput, formatGcdumpReport, parseGcdumpReport } from './gcdumpAnalysis.ts';

/**
 * Настоящий формат `dotnet-gcdump report`: размер одного объекта и количество
 * объектов ровно такого размера. Крупные объекты попадают в диапазон `(Bytes > …)`.
 */
const REPORT = [
  '     15,303,007  GC Heap bytes',
  '          4,675  GC Heap objects',
  '',
  '   Object Bytes     Count  Type',
  '        131,096       114  System.Byte[] (Bytes > 100K)  [System.Private.CoreLib.dll]',
  '         30,898         1  System.String (Bytes > 10K)  [System.Private.CoreLib.dll]',
  '             22     1,498  System.String  [System.Private.CoreLib.dll]',
  '          4,024         1  LogEntry[]  [SampleApp.dll]',
].join('\n');

test('типы складываются по всем строкам, итоги берутся из шапки', () => {
  const heap = parseGcdumpReport(REPORT);
  assert.ok(heap !== undefined);
  assert.equal(heap.totalSize, 15_303_007);
  assert.equal(heap.totalCount, 4_675);

  // Одни и те же строки разных размеров дают один тип.
  assert.deepEqual(heap.entries.map(entry => entry.typeName), [
    'System.Byte[]',
    'System.String',
    'LogEntry[]',
  ]);
  assert.deepEqual(heap.entries.map(entry => entry.count), [114, 1499, 1]);
  assert.deepEqual(heap.entries.map(entry => entry.size), [131_096 * 114, 30_898 + 22 * 1_498, 4_024]);
});

test('без таблицы разбор не выдумывает данные', () => {
  assert.equal(parseGcdumpReport('Unhandled exception. System.IO.FileNotFoundException'), undefined);
});

test('отчёт снимка получает свои заголовки и панель кучи', () => {
  const analysis = analyzeGcdumpOutput('/tmp/memory-1.gcdump', REPORT, new Date(2026, 10, 7, 12, 30, 0), {
    takenAt: new Date(2026, 10, 7, 12, 0, 0),
    fileBytes: 154_961,
  });

  assert.equal(analysis.report.source, 'gcdump');
  assert.equal(analysis.report.title, 'Memory snapshot analysis');
  assert.equal(analysis.report.dumpFile, '/tmp/memory-1.gcdump');
  assert.equal(analysis.report.takenAt, '2026-11-07 12:00:00');
  assert.equal(analysis.report.dumpBytes, 154_961);
  assert.equal(analysis.report.typeCount, 3);
  assert.equal(analysis.report.views?.[0]?.blocks[0]?.kind, 'heapTypes');

  // Куча пригодна для сравнения снимков: сравнение работает по фактам, а не по выводу.
  assert.equal(analysis.facts.heap?.totalSize, 15_303_007);
  assert.equal(analysis.facts.heap?.entries.length, 3);
});

test('текстовый отчёт перечисляет крупнейшие типы и сохраняет вывод инструмента', () => {
  const text = formatGcdumpReport('/tmp/memory-1.gcdump', REPORT, new Date(2026, 10, 7, 12, 30, 0));
  assert.match(text, /Memory snapshot analysis/);
  assert.match(text, /\/tmp\/memory-1\.gcdump/);
  assert.match(text, /System\.Byte\[\]/);
  assert.match(text, /Object Bytes/);
});

test('нераспознанный снимок даёт предупреждение в наблюдениях', () => {
  const analysis = analyzeGcdumpOutput('/tmp/broken.gcdump', 'garbage', new Date(2026, 10, 7));
  assert.equal(analysis.report.heap, undefined);
  assert.equal(analysis.report.findings[0]?.level, 'warning');
});
