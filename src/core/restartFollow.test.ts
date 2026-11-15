import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProcessCandidate } from './debuggeeMatching.ts';
import { findRestartedTarget, normalizeCommandLine, RESTART_START_TOLERANCE_MS } from './restartFollow.ts';

function candidate(pid: number, commandLine: string, startTimeMs = 0, name = 'dotnet'): ProcessCandidate {
  return { pid, commandLine, startTimeMs, name };
}

const exitedAtMs = 1_000_000;
const commandLine = '/usr/lib/dotnet/dotnet /repo/App/bin/Debug/net11.0/App.dll';

test('перезапущенный процесс находится по той же командной строке', () => {
  const pid = findRestartedTarget([
    candidate(201, commandLine, exitedAtMs + 500),
  ], { pid: 200, commandLine, exitedAtMs });

  assert.equal(pid, 201);
});

test('сам завершившийся процесс целью не считается', () => {
  const pid = findRestartedTarget([
    candidate(200, commandLine, exitedAtMs - 30_000),
  ], { pid: 200, commandLine, exitedAtMs });

  assert.equal(pid, undefined);
});

test('процесс, запущенный задолго до выхода, не выбирается', () => {
  // Такую же командную строку может иметь экземпляр, работающий с прошлого запуска.
  const pid = findRestartedTarget([
    candidate(202, commandLine, exitedAtMs - RESTART_START_TOLERANCE_MS - 1_000),
  ], { pid: 200, commandLine, exitedAtMs });

  assert.equal(pid, undefined);
});

test('процесс без времени старта не выбирается: он мог работать до перезапуска', () => {
  const pid = findRestartedTarget([
    candidate(203, commandLine, 0),
  ], { pid: 200, commandLine, exitedAtMs });

  assert.equal(pid, undefined);
});

test('из нескольких перезапусков берётся последний', () => {
  const pid = findRestartedTarget([
    candidate(204, commandLine, exitedAtMs + 400),
    candidate(205, commandLine, exitedAtMs + 2_000),
  ], { pid: 200, commandLine, exitedAtMs });

  assert.equal(pid, 205);
});

test('чужая командная строка игнорируется', () => {
  const pid = findRestartedTarget([
    candidate(206, '/usr/lib/dotnet/dotnet /repo/Other/bin/Debug/net11.0/Other.dll', exitedAtMs + 500),
  ], { pid: 200, commandLine, exitedAtMs });

  assert.equal(pid, undefined);
});

test('без командной строки перезапуск не ищется', () => {
  const pid = findRestartedTarget([
    candidate(207, commandLine, exitedAtMs + 500),
  ], { pid: 200, commandLine: '   ', exitedAtMs });

  assert.equal(pid, undefined);
});

test('normalizeCommandLine: кавычки и лишние пробелы не мешают сравнению', () => {
  assert.equal(
    normalizeCommandLine('  "/usr/lib/dotnet/dotnet"   "/repo/App.dll"  '),
    normalizeCommandLine('/usr/lib/dotnet/dotnet /repo/App.dll'),
  );
});
