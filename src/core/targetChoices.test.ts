/**
 * Проверки списка целей мониторинга.
 * Логика не зависит от VS Code, поэтому проверяется напрямую: важно, чтобы сессии отладки
 * шли первыми, дубликатов не было, а текущая цель была отмечена.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTargets, hasAlternativeTargets, targetCount, type TargetSession } from './targetChoices.ts';
import type { ProcessCandidate } from './debuggeeMatching.ts';
import { setTranslator } from './locale.ts';

function session(id: string, name: string, pid?: number, type = 'coreclr'): TargetSession {
  return { id, name, pid, type };
}

function process(pid: number, name: string, commandLine = `/app/${name}`): ProcessCandidate {
  return { pid, name, commandLine, startTimeMs: 1 };
}

test.beforeEach(() => {
  // Без подключённого словаря переводчик возвращает исходные (английские) строки.
  setTranslator(message => message);
});

test('сессии отладки идут первыми и сохраняют порядок запуска', () => {
  const groups = buildTargets(
    [session('s1', 'AppHost'), session('s2', 'Отладка WebApi')],
    [process(300, 'WebApi')],
  );

  assert.deepEqual(groups.sessions.map(entry => entry.name), ['AppHost', 'Отладка WebApi']);
  assert.deepEqual(groups.processes.map(entry => entry.name), ['WebApi']);
});

test('текущая цель отмечается', () => {
  const groups = buildTargets([session('s1', 'AppHost', 100)], [process(300, 'WebApi')], 300);

  assert.equal(groups.sessions[0].isCurrent, false);
  assert.equal(groups.processes[0].isCurrent, true);
});

test('процесс сессии не дублируется в списке процессов', () => {
  const groups = buildTargets([session('s1', 'AppHost', 100)], [process(100, 'AppHost'), process(300, 'WebApi')]);

  assert.deepEqual(groups.processes.map(entry => entry.pid), [300]);
});

test('сессия без найденного процесса остаётся в списке и объясняет это', () => {
  const groups = buildTargets([session('s1', 'Aspire: AppHost')], []);

  assert.equal(groups.sessions.length, 1);
  assert.equal(groups.sessions[0].pid, undefined);
  assert.match(groups.sessions[0].detail, /process is detected when selected/);
});

test('значения строк различают сессии и процессы', () => {
  const groups = buildTargets([session('s1', 'AppHost', 100)], [process(300, 'WebApi')]);

  assert.equal(groups.sessions[0].value, 'session:s1');
  assert.equal(groups.processes[0].value, 'pid:300');
});

test('все цели без текущего процесса: выбирать есть из чего только при двух и более', () => {
  const one = buildTargets([session('s1', 'AppHost', 100)], []);
  const two = buildTargets([session('s1', 'AppHost', 100)], [process(300, 'WebApi')]);

  assert.equal(targetCount(one), 1);
  assert.equal(hasAlternativeTargets(one), true);
  assert.equal(hasAlternativeTargets(two), true);
  assert.equal(hasAlternativeTargets(two, 100), true);
  // Одна цель, и она же мониторится: выбирать не из чего.
  assert.equal(hasAlternativeTargets(one, 100), false);
});

test('командная строка процесса обрезается', () => {
  const long = `dotnet run --project ${'/very/long/path'.repeat(12)}`;
  const groups = buildTargets([], [process(400, 'dotnet', long)]);

  assert.ok(groups.processes[0].detail.length <= 111, `слишком длинная строка: ${groups.processes[0].detail.length}`);
});

test('процессы без имени показываются словом «process»', () => {
  const groups = buildTargets([], [process(500, '')]);

  assert.equal(groups.processes[0].name, 'process');
});
