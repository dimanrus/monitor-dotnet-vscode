/**
 * Проверки узлов дерева проблем.
 *
 * Модуль не зависит от API VS Code, поэтому его можно проверять напрямую:
 * важно, что подписи, значки и интервалы соответствуют найденной проблеме.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartIssue } from './chartData.ts';
import { buildIssueNodes, buildIssueTree } from './issueNodes.ts';
import type { IssueProcess } from './issueStore.ts';
import { setTranslator } from './locale.ts';

/** Проблема с настраиваемыми полями: остальное берём из значений по умолчанию. */
function issue(overrides: Partial<ChartIssue> = {}): ChartIssue {
  return {
    id: 'issue-1',
    kind: 'cpu-saturation',
    chart: 'cpu',
    severity: 'warning',
    fromMs: Date.UTC(2026, 0, 2, 10, 30, 0),
    toMs: Date.UTC(2026, 0, 2, 10, 30, 12),
    title: 'CPU is pegged at full load',
    details: 'Load stayed above 90 % for 12 s (peak 99 %).',
    ...overrides,
  };
}

/** Группа проблем одного процесса. */
function group(pid: number, issues: ChartIssue[], isCurrent = false, name = 'SampleApp'): IssueProcess {
  return { key: `pid:${pid}`, label: `${name} (PID ${pid})`, issues, isCurrent };
}

test.beforeEach(() => {
  // Без VS Code переводчик возвращает исходные (английские) строки.
  setTranslator(message => message);
});

test('узел проблемы содержит заголовок, время начала и длительность', () => {
  const nodes = buildIssueNodes([issue()]);

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, 'CPU is pegged at full load');
  // Время зависит от часового пояса, поэтому проверяем формат, а не конкретные цифры.
  assert.match(nodes[0].description, /^\d{2}:\d{2}:\d{2} · /);
  assert.ok(nodes[0].description.includes('12'), `нет длительности: ${nodes[0].description}`);
  assert.equal(nodes[0].fromMs, issue().fromMs);
  assert.equal(nodes[0].toMs, issue().toMs);
});

test('подсказка показывает интервал и подробности', () => {
  const nodes = buildIssueNodes([issue()]);

  assert.ok(nodes[0].tooltip.startsWith('Interval: '), `неожиданная подсказка: ${nodes[0].tooltip}`);
  assert.ok(nodes[0].tooltip.includes('Load stayed above 90 % for 12 s (peak 99 %).'));
});

test('значок и цвет зависят от важности', () => {
  const [critical] = buildIssueNodes([issue({ severity: 'critical' })]);
  const [warning] = buildIssueNodes([issue({ severity: 'warning' })]);
  const [info] = buildIssueNodes([issue({ severity: 'info' })]);

  assert.deepEqual(
    { icon: critical.iconId, color: critical.colorId },
    { icon: 'error', color: 'errorForeground' },
  );
  assert.deepEqual(
    { icon: warning.iconId, color: warning.colorId },
    { icon: 'warning', color: 'editorWarning.foreground' },
  );
  assert.deepEqual({ icon: info.iconId, color: info.colorId }, { icon: 'info', color: 'editorInfo.foreground' });
});

test('порядок проблем сохраняется: свежие сверху', () => {
  const nodes = buildIssueNodes([
    issue({ id: 'new', title: 'Newest' }),
    issue({ id: 'old', title: 'Oldest' }),
  ]);

  assert.deepEqual(nodes.map(node => node.id), ['new', 'old']);
});

test('пустой список даёт пустой набор узлов', () => {
  assert.deepEqual(buildIssueNodes([]), []);
});

test('подсказка и заголовок переводятся, когда словарь подключён', () => {
  setTranslator(message =>
    message === 'Interval: {0} — {1} ({2}).' ? 'Интервал: {0} — {1} ({2}).' : message,
  );

  const [node] = buildIssueNodes([issue()]);
  assert.ok(node.tooltip.startsWith('Интервал: '), `подсказка не переведена: ${node.tooltip}`);
});

test('у одного процесса дерево остаётся плоским списком проблем', () => {
  const tree = buildIssueTree([group(100, [issue({ id: 'a', title: 'First' }), issue({ id: 'b', title: 'Second' })], true)]);

  assert.deepEqual(tree.map(node => node.kind), ['entry', 'entry']);
  const entries = tree.flatMap(node => node.kind === 'entry' ? [node.entry] : []);
  assert.deepEqual(entries.map(entry => entry.data.label), ['First', 'Second']);
  assert.deepEqual(entries.map(entry => entry.processKey), ['pid:100', 'pid:100']);
  assert.ok(entries.every(entry => entry.isCurrentProcess), 'проблемы текущего процесса помечены как чужие');
});

test('единственный процесс с проблемами показывается группой, если он не мониторится', () => {
  // Мониторинг уже переключился на другой процесс: без группы не понять, чьи это интервалы.
  const tree = buildIssueTree([group(100, [issue({ id: 'a' })], false)]);

  assert.deepEqual(tree.map(node => node.kind), ['process']);
  const [process] = tree.flatMap(node => node.kind === 'process' ? [node.process] : []);
  assert.equal(process.expanded, false);
  assert.deepEqual(process.entries.map(entry => entry.data.id), ['a']);
});

test('пустой список процессов даёт пустое дерево', () => {
  assert.deepEqual(buildIssueTree([]), []);
});

test('несколько процессов группируются, текущий раскрыт и помечен', () => {
  const current = group(200, [issue({ id: 'a' })], true, 'WebApi');
  const history = group(100, [issue({ id: 'b' }), issue({ id: 'c' })], false, 'OldApp');

  const tree = buildIssueTree([current, history]);

  assert.deepEqual(tree.map(node => node.kind), ['process', 'process']);
  const processes = tree.flatMap(node => node.kind === 'process' ? [node.process] : []);
  assert.deepEqual(processes.map(process => process.label), ['WebApi (PID 200)', 'OldApp (PID 100)']);
  assert.deepEqual(processes.map(process => process.expanded), [true, false]);
  assert.equal(processes[0].description, '1 · monitoring now', 'текущий процесс не помечен');
  assert.equal(processes[1].description, '2', 'у чужого процесса не показано число проблем');
  assert.deepEqual(processes[1].entries.map(entry => entry.data.id), ['b', 'c']);
  assert.ok(processes[1].entries.every(entry => !entry.isCurrentProcess), 'чужие проблемы помечены как текущие');
  assert.equal(processes[1].entries[0].processLabel, 'OldApp (PID 100)');
});

test('описание группы процессов переводится', () => {
  setTranslator(message => message === 'monitoring now' ? 'мониторится сейчас' : message);

  const tree = buildIssueTree([
    group(100, [issue()], true),
    group(200, [issue({ id: 'other' })], false, 'WebApi'),
  ]);
  const [first] = tree;
  assert.equal(first.kind, 'process');
  assert.equal(first.kind === 'process' ? first.process.description : '', '1 · мониторится сейчас');
});
