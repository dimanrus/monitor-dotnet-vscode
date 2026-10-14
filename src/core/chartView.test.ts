/**
 * Проверки расчёта видимого диапазона графиков.
 *
 * Главное, что здесь проверяется: выделенный интервал всегда попадает в диапазон показа,
 * иначе переход к найденной проблеме показал бы пустое место вместо данных.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveReplaced, clampToData, liveVisibleRange, paddedRange } from './chartView.ts';

/** Точки с заданными временами: значения не важны для расчёта диапазона. */
function points(times: readonly number[]): Array<{ t: number }> {
  return times.map(t => ({ t }));
}

test('без данных показывается окно до текущего момента', () => {
  const view = liveVisibleRange([], 60, 1_000_000, null);

  assert.deepEqual(view, { fromMs: 940_000, toMs: 1_000_000 });
});

test('диапазон охватывает последние windowSeconds секунд', () => {
  const view = liveVisibleRange(points([0, 60_000, 120_000, 180_000]), 60, 200_000, null);

  assert.deepEqual(view, { fromMs: 120_000, toMs: 180_000 });
});

test('короткий ряд не схлопывается в точку', () => {
  const view = liveVisibleRange(points([10_000]), 60, 10_000, null);

  assert.ok(view.toMs - view.fromMs >= 1_000, `слишком узкий диапазон: ${JSON.stringify(view)}`);
  assert.ok(view.fromMs <= 10_000 && view.toMs >= 10_000, 'точка не попала в диапазон');
});

test('выделенный интервал старше окна расширяет диапазон', () => {
  const view = liveVisibleRange(points([0, 60_000, 120_000]), 10, 120_000, { fromMs: 20_000, toMs: 25_000 });

  assert.equal(view.fromMs, 20_000, 'выделение осталось за левой границей');
  assert.equal(view.toMs, 120_000);
});

test('выделенный интервал полностью попадает в диапазон', () => {
  const selection = { fromMs: 30_000, toMs: 45_000 };
  const view = liveVisibleRange(points([0, 10_000]), 5, 10_000, selection);

  assert.ok(view.fromMs <= selection.fromMs && view.toMs >= selection.toMs, JSON.stringify(view));
});

test('перепутанные границы выделения не ломают диапазон', () => {
  const view = liveVisibleRange(points([0, 10_000]), 5, 10_000, { fromMs: 9_000, toMs: 7_000 });

  assert.ok(view.fromMs <= 7_000 && view.toMs >= 9_000, JSON.stringify(view));
});

test('диапазон сохранённого интервала включает запас по краям', () => {
  const view = paddedRange({ fromMs: 100_000, toMs: 120_000 });

  // 20 секунд интервала: запас по 25 % с каждой стороны.
  assert.deepEqual(view, { fromMs: 95_000, toMs: 125_000 });
});

test('у короткого интервала запас не меньше минимального', () => {
  const view = paddedRange({ fromMs: 100_000, toMs: 100_200 });

  assert.deepEqual(view, { fromMs: 99_000, toMs: 101_200 });
});

test('диапазон сохранённого интервала не зависит от порядка границ', () => {
  assert.deepEqual(paddedRange({ fromMs: 120_000, toMs: 100_000 }), paddedRange({ fromMs: 100_000, toMs: 120_000 }));
});

test('диапазон показа сужается до сохранённых точек', () => {
  // Запас по краям шире сохранённых данных: линий за их пределами нет.
  const clamped = clampToData(
    { fromMs: 0, toMs: 100_000 },
    points([10_000, 50_000, 90_000]),
  );

  assert.deepEqual(clamped, { fromMs: 10_000, toMs: 90_000 });
});

test('сужение не выходит за точки и не переворачивает диапазон', () => {
  const clamped = clampToData({ fromMs: 0, toMs: 5_000 }, points([10_000, 20_000]));

  assert.deepEqual(clamped, { fromMs: 10_000, toMs: 20_000 });
});

test('без точек диапазон остаётся прежним', () => {
  const range = { fromMs: 100, toMs: 200 };
  assert.deepEqual(clampToData(range, []), range);
});

test('сохранённый интервал закрывается только при смене данных', () => {
  // Данные заменили: новый процесс или очистка.
  assert.equal(archiveReplaced(3, 4), true);
  // Та же генерация: снимок пришёл, например, при показе панели.
  assert.equal(archiveReplaced(3, 3), false);
  // Генерация неизвестна: не трогаем то, что открыл пользователь.
  assert.equal(archiveReplaced(undefined, 4), false);
  assert.equal(archiveReplaced(3, undefined), false);
  assert.equal(archiveReplaced(undefined, undefined), false);
});
