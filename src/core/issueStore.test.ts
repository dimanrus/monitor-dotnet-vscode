/**
 * Проверки накопителя найденных проблем.
 *
 * Модуль не зависит от API VS Code, поэтому проверяем главное: проблемы распределяются
 * по процессам, не пропадают при смене процесса и забываются по требованию.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartIssue } from './chartData.ts';
import { ISSUE_HISTORY_LIMIT, ISSUE_SLICE_PADDING_MS, IssueStore, type IssueStoreSource, type MonitoredProcess } from './issueStore.ts';
import type { ProcessSeriesPoint } from './monitorState.ts';

/** Проблема с настраиваемым временем окончания: остальное берём из значений по умолчанию. */
function issue(id: string, toMs: number): ChartIssue {
  return {
    id,
    kind: 'cpu-saturation',
    chart: 'cpu',
    severity: 'warning',
    fromMs: toMs - 5_000,
    toMs,
    title: 'CPU is pegged at full load',
    details: 'Load stayed above 90 % for 5 s (peak 99 %).',
  };
}

/** Процесс для проверок. */
function process(pid: number, name = 'SampleApp'): MonitoredProcess {
  return { key: `pid:${pid}`, label: `${name} (PID ${pid})` };
}

/** Точка ряда с заданным временем: значения не важны для проверок интервалов. */
function point(timestampMs: number): ProcessSeriesPoint {
  return {
    timestampMs,
    cpuPercent: 5,
    privateMemoryBytes: 1_000,
    workingSetBytes: 1_000,
    managedHeapBytes: 500,
    allocationRateBytesPerSec: 10,
    timeInGcPercent: 1,
    threadCount: 2,
    gcCollections: { gen0: 1, gen1: 0, gen2: 0 },
  };
}

/**
 * Накопитель с подменяемым состоянием монитора.
 * Живые проблемы зависят от текущего процесса: у каждого процесса они свои.
 */
function createStore(
  liveByProcess: Map<string, ChartIssue[]> = new Map(),
  pointsByProcess: Map<string, ProcessSeriesPoint[]> = new Map(),
): {
  store: IssueStore;
  monitor: (value: MonitoredProcess | undefined) => void;
  setLive: (pid: number, issues: ChartIssue[]) => void;
  setPoints: (pid: number, points: ProcessSeriesPoint[]) => void;
  setEnabled: (value: boolean) => void;
} {
  let monitored: MonitoredProcess | undefined;
  let enabled = true;

  const source = (): IssueStoreSource => ({
    points: monitored === undefined ? [] : pointsByProcess.get(monitored.key) ?? [],
    gcEvents: [],
  });

  const store = new IssueStore(
    () => (monitored === undefined ? [] : liveByProcess.get(monitored.key) ?? []),
    () => enabled,
    () => monitored,
    source,
  );

  return {
    store,
    monitor: value => monitored = value,
    setLive: (pid, issues) => liveByProcess.set(`pid:${pid}`, issues),
    setPoints: (pid, points) => pointsByProcess.set(`pid:${pid}`, points),
    setEnabled: value => enabled = value,
  };
}

test('пока проблем нет, списки пусты', () => {
  const { store, monitor } = createStore();
  monitor(process(100));

  assert.deepEqual(store.current(), []);
  assert.deepEqual(store.groups(), []);
});

test('проблемы текущего процесса попадают в обе выборки', () => {
  const { store, monitor, setLive } = createStore();
  monitor(process(100));
  setLive(100, [issue('cpu-saturation:1000', 10_000)]);

  assert.deepEqual(store.current().map(item => item.id), ['cpu-saturation:1000']);

  const groups = store.groups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, 'pid:100');
  assert.equal(groups[0].label, 'SampleApp (PID 100)');
  assert.equal(groups[0].isCurrent, true);
  assert.deepEqual(groups[0].issues.map(item => item.id), ['cpu-saturation:1000']);
});

test('проблемы прошлого процесса остаются в дереве, но не на графиках', () => {
  const { store, monitor, setLive } = createStore();
  monitor(process(100));
  setLive(100, [issue('cpu-saturation:1000', 10_000)]);
  store.current();

  // Мониторинг переключился на другой процесс: данных у него ещё нет.
  monitor(process(200, 'WebApi'));
  setLive(200, []);

  assert.deepEqual(store.current(), [], 'на графиках оказались проблемы другого процесса');

  // У нового процесса проблем ещё нет, поэтому в дереве остаётся только прошлый процесс.
  const groups = store.groups();
  assert.deepEqual(groups.map(group => group.key), ['pid:100']);
  assert.equal(groups[0].isCurrent, false, 'прошлый процесс показан как текущий');
  assert.deepEqual(
    groups[0].issues.map(item => item.id),
    ['cpu-saturation:1000'],
    'проблемы прошлого процесса пропали',
  );
});

test('текущий процесс идёт первым, остальные — по свежести проблем', () => {
  const { store, monitor, setLive } = createStore();

  monitor(process(100, 'Old'));
  setLive(100, [issue('old', 10_000)]);
  store.groups();

  monitor(process(200, 'New'));
  setLive(200, [issue('new', 30_000)]);
  store.groups();

  monitor(process(300, 'Current'));
  setLive(300, [issue('current', 20_000)]);
  const groups = store.groups();

  assert.deepEqual(groups.map(group => group.key), ['pid:300', 'pid:200', 'pid:100']);
  assert.deepEqual(groups.map(group => group.isCurrent), [true, false, false]);
});

test('уточнение интервала обновляет проблему, а не добавляет вторую', () => {
  const { store, monitor, setLive } = createStore();
  monitor(process(100));
  setLive(100, [issue('cpu-saturation:1000', 10_000)]);
  store.current();

  // Точки продолжают приходить: интервал той же проблемы удлинился.
  setLive(100, [issue('cpu-saturation:1000', 15_000)]);
  const issues = store.current();

  assert.equal(issues.length, 1, 'одна и та же проблема попала в список дважды');
  assert.equal(issues[0].toMs, 15_000, 'интервал проблемы не уточнился');
});

test('clear забывает проблемы всех процессов', () => {
  const { store, monitor, setLive } = createStore();
  monitor(process(100));
  setLive(100, [issue('cpu-saturation:1000', 10_000)]);
  store.groups();

  monitor(process(200, 'WebApi'));
  setLive(200, [issue('gc-pause:2000', 20_000)]);
  assert.equal(store.groups().length, 2);

  // Команда очистки убирает и собранные данные, поэтому новых проблем не приходит.
  store.clear();
  setLive(200, []);

  assert.deepEqual(store.groups(), []);
  assert.deepEqual(store.current(), []);
});

test('признак текущего процесса отличает чужие проблемы', () => {
  const { store, monitor, setLive } = createStore();
  monitor(process(100));
  setLive(100, [issue('cpu-saturation:1000', 10_000)]);
  store.groups();

  monitor(process(200, 'WebApi'));
  setLive(200, []);

  assert.equal(store.isCurrentProcess('pid:200'), true);
  assert.equal(store.isCurrentProcess('pid:100'), false, 'проблемы прошлого процесса считаются текущими');
});

test('выключенный поиск скрывает и сохранённые проблемы', () => {
  const { store, monitor, setLive, setEnabled } = createStore();
  monitor(process(100));
  setLive(100, [issue('cpu-saturation:1000', 10_000)]);
  store.groups();

  setEnabled(false);
  assert.deepEqual(store.current(), []);
  assert.deepEqual(store.groups(), []);

  // Настройку вернули: сохранённые проблемы снова доступны.
  setEnabled(true);
  assert.deepEqual(store.groups().map(group => group.key), ['pid:100']);
});

test('список ограничен по длине: самые старые проблемы вытесняются', () => {
  const { store, monitor, setLive } = createStore();
  monitor(process(100));
  setLive(100, Array.from({ length: ISSUE_HISTORY_LIMIT + 5 }, (_, index) => issue(`issue-${index}`, 1_000 + index)));

  const issues = store.current();

  assert.equal(issues.length, ISSUE_HISTORY_LIMIT);
  assert.equal(issues[0].id, `issue-${ISSUE_HISTORY_LIMIT + 4}`, 'список не отсортирован от свежих к старым');
  assert.ok(!issues.some(item => item.id === 'issue-0'), 'самая старая проблема не вытеснена');
});

test('точки интервала сохраняются вместе с запасом по краям', () => {
  const { store, monitor, setLive, setPoints } = createStore();
  monitor(process(100));
  setPoints(100, [point(4_000), point(5_000), point(9_000), point(11_000), point(16_000), point(20_000)]);
  setLive(100, [issue('cpu-saturation:10000', 10_000)]);
  store.current();

  const slice = store.slice('pid:100', 'cpu-saturation:10000');
  assert.ok(slice !== undefined, 'интервал проблемы не сохранён');
  // Проблема занимает 5–10 с, запас по 5 с с каждой стороны: 0–15 с.
  assert.deepEqual(slice.points.map(item => item.t), [4_000, 5_000, 9_000, 11_000]);
  assert.equal(slice.issue.id, 'cpu-saturation:10000');
  assert.equal(ISSUE_SLICE_PADDING_MS, 5_000);
});

test('сохранённый интервал переживает уход живого ряда и смену процесса', () => {
  const { store, monitor, setLive, setPoints } = createStore();
  monitor(process(100));
  setPoints(100, [point(9_000), point(11_000)]);
  setLive(100, [issue('cpu-saturation:10000', 10_000)]);
  store.current();

  // Ряд ушёл вперёд: старые точки вытеснены, затем мониторинг переключился на другой процесс.
  setPoints(100, [point(50_000)]);
  monitor(process(200, 'WebApi'));
  setLive(200, []);

  const slice = store.slice('pid:100', 'cpu-saturation:10000');
  assert.ok(slice !== undefined, 'сохранённый интервал пропал при смене процесса');
  assert.deepEqual(slice.points.map(item => item.t), [9_000, 11_000]);
  assert.equal(store.slice('pid:200', 'cpu-saturation:10000'), undefined, 'интервал нашёлся у чужого процесса');
});

test('уточнение интервала не теряет ранее сохранённые точки', () => {
  const { store, monitor, setLive, setPoints } = createStore();
  monitor(process(100));
  setPoints(100, [point(9_000), point(11_000)]);
  setLive(100, [issue('cpu-saturation:10000', 10_000)]);
  store.current();

  // Проблема удлинилась, а начало интервала из ряда уже вытеснено.
  setPoints(100, [point(18_000), point(20_000)]);
  setLive(100, [issue('cpu-saturation:10000', 20_000)]);
  store.current();

  const slice = store.slice('pid:100', 'cpu-saturation:10000');
  assert.deepEqual(slice?.points.map(item => item.t), [9_000, 11_000, 18_000, 20_000]);
  assert.equal(slice?.issue.toMs, 20_000, 'интервал в сохранённых данных не уточнился');
});

test('clear забывает и сохранённые интервалы', () => {
  const { store, monitor, setLive, setPoints } = createStore();
  monitor(process(100));
  setPoints(100, [point(9_000), point(11_000)]);
  setLive(100, [issue('cpu-saturation:10000', 10_000)]);
  store.current();

  store.clear();

  assert.equal(store.slice('pid:100', 'cpu-saturation:10000'), undefined);
});

test('вытесненная проблема уносит с собой сохранённый интервал', () => {
  const { store, monitor, setLive, setPoints } = createStore();
  monitor(process(100));
  setPoints(100, [point(2_500)]);
  const issues = Array.from({ length: ISSUE_HISTORY_LIMIT }, (_, index) => issue(`issue-${index}`, 1_000 + index * 10));
  setLive(100, issues);
  store.current();
  assert.ok(store.slice('pid:100', 'issue-0') !== undefined);

  // Появилась ещё одна проблема: самая старая вытесняется вместе со своим интервалом.
  setLive(100, [...issues, issue('issue-new', 99_999)]);
  store.current();

  assert.equal(store.slice('pid:100', 'issue-0'), undefined, 'интервал вытесненной проблемы остался в памяти');
  assert.ok(store.slice('pid:100', 'issue-new') !== undefined, 'интервал новой проблемы не сохранён');
});

test('подпись процесса доступна для сообщений о сохранённом интервале', () => {
  const { store, monitor, setLive } = createStore();
  monitor(process(100));
  setLive(100, [issue('cpu-saturation:1000', 10_000)]);
  store.groups();

  assert.equal(store.label('pid:100'), 'SampleApp (PID 100)');
  assert.equal(store.label('pid:999'), undefined);
});
