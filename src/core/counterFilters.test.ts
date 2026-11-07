/** Проверки дополнения фильтров сбора из панели Counters. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withCounterFilter, withMetricFilter } from './counterFilters.ts';

test('новый счётчик добавляется отдельной записью', () => {
  assert.deepEqual(withCounterFilter([], 'System.Runtime', 'cpu-usage'), ['System.Runtime[cpu-usage]']);
  assert.deepEqual(withCounterFilter(['System.Runtime'], 'MyProvider'), ['System.Runtime', 'MyProvider']);
});

test('счётчик дописывается в существующую запись провайдера', () => {
  assert.deepEqual(
    withCounterFilter(['System.Runtime[gc-heap-size]'], 'System.Runtime', 'cpu-usage'),
    ['System.Runtime[gc-heap-size,cpu-usage]'],
  );
});

test('повторное добавление ничего не меняет', () => {
  const current = ['System.Runtime[cpu-usage]'];
  assert.deepEqual(withCounterFilter(current, 'System.Runtime', 'cpu-usage'), current);
  // Провайдер целиком уже включает все счётчики.
  assert.deepEqual(withCounterFilter(['System.Runtime'], 'System.Runtime', 'cpu-usage'), ['System.Runtime']);
  assert.deepEqual(withCounterFilter(current, 'system.runtime', 'CPU-USAGE'), current);
});

test('новый метр добавляется, а `*` и повтор не меняют фильтр', () => {
  assert.deepEqual(withMetricFilter(['*'], 'MyMeter', 'Latency'), ['*']);
  assert.deepEqual(withMetricFilter([], 'MyMeter'), ['MyMeter']);
  assert.deepEqual(withMetricFilter(['MyMeter'], 'MyMeter', 'Latency'), ['MyMeter']);
  assert.deepEqual(withMetricFilter([], 'MyMeter', 'Latency'), ['MyMeter\\Latency']);
  assert.deepEqual(withMetricFilter(['MyMeter\\Latency'], 'MyMeter', 'Latency'), ['MyMeter\\Latency']);
  assert.deepEqual(withMetricFilter(['MyMeter\\Latency'], 'MyMeter', 'Queue'), ['MyMeter\\Latency', 'MyMeter\\Queue']);
});

test('пустые имена игнорируются', () => {
  assert.deepEqual(withCounterFilter(['System.Runtime'], '  '), ['System.Runtime']);
  assert.deepEqual(withMetricFilter(['MyMeter'], ''), ['MyMeter']);
});
