import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChartGcEvent, ChartPoint } from './chartData.ts';
import { detectIssues, ISSUE_THRESHOLDS } from './issueDetection.ts';

/** Точка с шагом в секунду: время задаётся номером секунды. */
function point(second: number, overrides: Partial<ChartPoint> = {}): ChartPoint {
  return {
    t: second * 1000,
    cpu: 5,
    priv: 100,
    ws: 90,
    heap: 50,
    alloc: 1024,
    tig: 1,
    thr: 8,
    ...overrides,
  };
}

function gcEvent(second: number, pauseMs: number, generation = 1, reason = 'AllocSmall'): ChartGcEvent {
  return { t: second * 1000, gen: generation, dur: pauseMs, reason };
}

test('пустые данные не дают проблем', () => {
  assert.deepEqual(detectIssues([], []), []);
});

test('загрузка процессора в потолок распознаётся как проблема', () => {
  const points = [point(0), point(1), point(2, { cpu: 95 }), point(3, { cpu: 99 }), point(4, { cpu: 97 }), point(5)];

  const issues = detectIssues(points, []);
  const cpu = issues.filter(issue => issue.kind === 'cpu-saturation');

  assert.equal(cpu.length, 1);
  assert.equal(cpu[0].chart, 'cpu');
  assert.equal(cpu[0].severity, 'warning');
  assert.equal(cpu[0].fromMs, 2000);
  assert.equal(cpu[0].toMs, 4000);
  assert.match(cpu[0].title, /CPU is pegged/);
  assert.match(cpu[0].details, /99\.0 %/);
});

test('короткий всплеск загрузки проблемой не считается', () => {
  const points = [point(0), point(1, { cpu: 95 }), point(2), point(3)];

  assert.deepEqual(detectIssues(points, []).filter(issue => issue.kind === 'cpu-saturation'), []);
});

test('одиночный провал внутри перегрузки не разрывает интервал', () => {
  const points = [
    point(0, { cpu: 95 }),
    point(1, { cpu: 96 }),
    point(2, { cpu: 10 }),
    point(3, { cpu: 97 }),
    point(4, { cpu: 95 }),
  ];

  const cpu = detectIssues(points, []).filter(issue => issue.kind === 'cpu-saturation');

  // Точки идут подряд, разрыв в одну точку объединяется в один интервал.
  assert.equal(cpu.length, 1);
  assert.equal(cpu[0].fromMs, 0);
  assert.equal(cpu[0].toMs, 4000);
});

test('долгая пауза сборки мусора попадает в список с важностью', () => {
  const events = [gcEvent(5, 120), gcEvent(8, 400, 2)];

  const issues = detectIssues([point(0), point(9)], events).filter(issue => issue.kind === 'gc-pause');

  assert.equal(issues.length, 2);
  // Новые интервалы идут первыми.
  assert.equal(issues[0].severity, 'critical');
  assert.equal(issues[0].fromMs, 8000 - 400);
  assert.equal(issues[0].toMs, 8000);
  assert.match(issues[0].details, /gen2 paused for 400\.0 ms/);
  assert.equal(issues[1].severity, 'warning');
});

test('быстрые сборки мусора с длинными паузами дают проблему давления', () => {
  const points = [point(0), point(12)];
  const events: ChartGcEvent[] = [];
  for (let index = 1; index <= 12; index++) {
    events.push(gcEvent(index, 30));
  }

  const issues = detectIssues(points, events).filter(issue => issue.kind === 'gc-pressure');

  assert.equal(issues.length, 1);
  assert.match(issues[0].title, /Frequent garbage collections/);
  // В окно длиной 10 секунд попадают сборки со 1-й по 10-ю секунду.
  assert.equal(issues[0].details, '10 collections in 10.00 s, 300.0 ms spent in pauses.');
  assert.equal(issues[0].fromMs, 0);
  assert.equal(issues[0].toMs, 10_000);
});

test('редкие сборки мусора проблемой не считаются', () => {
  const events = [gcEvent(1, 30), gcEvent(2, 30)];

  assert.deepEqual(detectIssues([point(0), point(5)], events).filter(issue => issue.kind === 'gc-pressure'), []);
});

test('всплеск скорости выделения определяется относительно обычной', () => {
  const baseline = 1024 * 1024;
  const points = [
    point(0, { alloc: baseline }),
    point(1, { alloc: baseline }),
    point(2, { alloc: baseline * 10 }),
    point(3, { alloc: baseline * 10 }),
    point(4, { alloc: baseline }),
  ];

  const issues = detectIssues(points, []).filter(issue => issue.kind === 'allocation-spike');

  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'info');
  assert.equal(issues[0].chart, 'gc');
  assert.match(issues[0].details, /against the usual/);
});

test('ровное выделение памяти без всплесков не считается проблемой', () => {
  const points = Array.from({ length: 10 }, (_, index) => point(index, { alloc: 1024 * 1024 }));

  assert.deepEqual(detectIssues(points, []).filter(issue => issue.kind === 'allocation-spike'), []);
});

test('список проблем ограничен и отсортирован по свежести', () => {
  const points = Array.from({ length: 40 }, (_, index) => point(index));
  const events = Array.from({ length: 12 }, (_, index) => gcEvent(index + 1, 150));
  const issues = detectIssues(points, events);

  assert.ok(issues.length <= ISSUE_THRESHOLDS.maxIssues);
  for (let index = 1; index < issues.length; index++) {
    assert.ok(issues[index - 1].toMs >= issues[index].toMs, 'проблемы должны идти от новых к старым');
  }
});

test('пороги можно переопределить', () => {
  const points = [point(0, { cpu: 60 }), point(1, { cpu: 60 })];

  // По умолчанию 60 % — не проблема, с пониженным порогом — проблема.
  assert.deepEqual(detectIssues(points, []).filter(issue => issue.kind === 'cpu-saturation'), []);
  const custom = detectIssues(points, [], {
    ...ISSUE_THRESHOLDS,
    cpuSaturatedPercent: 50,
    cpuSaturatedPoints: 2,
  });
  assert.equal(custom.filter(issue => issue.kind === 'cpu-saturation').length, 1);
});
