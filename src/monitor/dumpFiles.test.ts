/** Проверки списка файлов дампов. */

import assert from 'node:assert/strict';
import { mkdtemp, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listDumpFiles, listMemoryFiles, listSnapshotFiles } from './dumpFiles.ts';

test('в список попадают только .dmp, свежие первыми', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-dotnet-dumps-'));
  const older = path.join(directory, 'dump-1.dmp');
  const newer = path.join(directory, 'dump-2.DMP');
  await writeFile(older, 'old');
  await writeFile(newer, 'newer');
  await writeFile(path.join(directory, 'notes.txt'), 'not a dump');
  await utimes(older, new Date(2020, 0, 1), new Date(2020, 0, 1));
  await utimes(newer, new Date(2021, 0, 1), new Date(2021, 0, 1));

  const files = await listDumpFiles(directory);
  assert.deepEqual(files.map(file => path.basename(file.file)), ['dump-2.DMP', 'dump-1.dmp']);
  assert.deepEqual(files.map(file => file.bytes), [5, 3]);
  assert.deepEqual(files.map(file => file.kind), ['dump', 'dump']);
  assert.ok(files[0].modifiedMs >= files[1].modifiedMs);
});

test('снимки памяти отделяются от дампов', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'monitor-dotnet-memory-'));
  await writeFile(path.join(directory, 'dump-1.dmp'), 'dump');
  await writeFile(path.join(directory, 'memory-1.gcdump'), 'snapshot');

  const all = await listMemoryFiles(directory);
  assert.deepEqual(all.map(file => path.basename(file.file)).sort(), ['dump-1.dmp', 'memory-1.gcdump']);

  const snapshots = await listSnapshotFiles(directory);
  assert.deepEqual(snapshots.map(file => path.basename(file.file)), ['memory-1.gcdump']);
  assert.deepEqual(snapshots.map(file => file.kind), ['snapshot']);
});

test('отсутствующий каталог даёт пустой список', async () => {
  assert.deepEqual(await listDumpFiles(path.join(os.tmpdir(), 'monitor-dotnet-missing-dumps')), []);
});
