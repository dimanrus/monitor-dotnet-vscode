import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCanvasColor } from './colors.ts';

/** Читатель переменных, как это делает браузер для темы VS Code. */
function reader(values: Record<string, string>): (name: string) => string {
  return name => values[name] ?? '';
}

test('обычный цвет возвращается без изменений', () => {
  assert.equal(resolveCanvasColor('#ff0000', reader({})), '#ff0000');
  assert.equal(resolveCanvasColor('rgb(1, 2, 3)', reader({})), 'rgb(1, 2, 3)');
});

test('переменная темы подставляется', () => {
  const color = resolveCanvasColor('var(--chart-cpu)', reader({ '--chart-cpu': '#4b9cff' }));

  assert.equal(color, '#4b9cff');
});

test('вложенные переменные разрешаются по цепочке', () => {
  // Именно так устроены цвета темы: --chart-cpu ссылается на --vscode-charts-blue.
  const color = resolveCanvasColor('var(--chart-cpu)', reader({
    '--chart-cpu': 'var(--vscode-charts-blue)',
    '--vscode-charts-blue': '#007acc',
  }));

  assert.equal(color, '#007acc');
});

test('если переменная не задана, берётся запасной цвет из значения', () => {
  const color = resolveCanvasColor('var(--chart-cpu, #123456)', reader({}));

  assert.equal(color, '#123456');
});

test('если переменная не задана и запасного цвета нет, берётся цвет по умолчанию', () => {
  const color = resolveCanvasColor('var(--chart-cpu)', reader({}));

  assert.equal(color, '#4b9cff');
  assert.equal(resolveCanvasColor('var(--unknown-color)', reader({})), '#8a8a8a');
});

test('циклические ссылки не приводят к зависанию', () => {
  const color = resolveCanvasColor('var(--a)', reader({ '--a': 'var(--b)', '--b': 'var(--a)' }));

  assert.equal(color, '#8a8a8a');
});

test('пустое значение заменяется цветом по умолчанию', () => {
  assert.equal(resolveCanvasColor('', reader({}), '#000000'), '#000000');
});
