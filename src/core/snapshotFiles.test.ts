/** Проверки группировки снимков по виду. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupSnapshots, type SnapshotFileInfo } from './snapshotFiles.ts';

function snapshot(file: string, kind: SnapshotFileInfo['kind'], modifiedMs: number): SnapshotFileInfo {
  return { file, kind, modifiedMs, bytes: file.length };
}

test('снимки делятся на группы CPU и памяти, свежие первыми', () => {
  const groups = groupSnapshots([
    snapshot('/out/memory-old.gcdump', 'memory', 1_000),
    snapshot('/out/cpu-old.speedscope.json', 'cpu', 1_000),
    snapshot('/out/memory-new.gcdump', 'memory', 3_000),
    snapshot('/out/cpu-new.speedscope.json', 'cpu', 2_000),
  ]);

  assert.deepEqual(groups.map(group => group.kind), ['cpu', 'memory']);
  assert.deepEqual(groups[0].files.map(file => file.file), [
    '/out/cpu-new.speedscope.json',
    '/out/cpu-old.speedscope.json',
  ]);
  assert.deepEqual(groups[1].files.map(file => file.file), [
    '/out/memory-new.gcdump',
    '/out/memory-old.gcdump',
  ]);
});

test('пустые группы не показываются', () => {
  assert.deepEqual(groupSnapshots([]), []);
  const onlyMemory = groupSnapshots([snapshot('/out/m.gcdump', 'memory', 1)]);
  assert.deepEqual(onlyMemory.map(group => group.kind), ['memory']);
});
