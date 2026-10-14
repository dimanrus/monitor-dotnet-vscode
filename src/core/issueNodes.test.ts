/**
 * Проверки узлов дерева проблем.
 *
 * Модуль не зависит от API VS Code, поэтому его можно проверять напрямую:
 * важно, что подписи, значки и интервалы соответствуют найденной проблеме.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartIssue } from './chartData.ts';
import { buildIssueNodes } from './issueNodes.ts';
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
