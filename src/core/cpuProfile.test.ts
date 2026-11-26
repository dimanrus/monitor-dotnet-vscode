/** Проверки разбора профиля CPU из Speedscope: методы, дерево вызовов и сравнение. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCpuProfile,
  compareCpuProfiles,
  cpuDurationMilliseconds,
  frameKey,
  parseSpeedscope,
  weightToMilliseconds,
  type CpuProfile,
} from './cpuProfile.ts';

/** Профиль: Main → Work → Alloc, плюс прямой вызов Alloc из Main. */
const SAMPLE_PROFILE = {
  shared: {
    frames: [
      { name: 'Main', file: 'Program.cs', line: 10 },
      { name: 'Work', file: 'Program.cs', line: 20 },
      { name: 'Alloc', file: 'Lib.cs', line: 5 },
    ],
  },
  profiles: [
    {
      type: 'sampled',
      unit: 'milliseconds',
      name: 'SampleApp',
      samples: [[0, 1, 2], [0, 1], [0, 1, 2], [0, 2]],
      weights: [10, 15, 5, 20],
    },
  ],
};

function profileFrom(raw: unknown): CpuProfile {
  const profile = buildCpuProfile(raw, '/out/cpu-1.speedscope.json', 1_700_000_000_000);
  assert.notEqual(profile, undefined);
  return profile as CpuProfile;
}

function method(profile: CpuProfile, name: string) {
  const found = profile.methods.find(item => item.name === name);
  assert.notEqual(found, undefined, `method ${name} is missing`);
  return found!;
}

test('суммирует собственное и полное время по сэмплам', () => {
  const profile = profileFrom(SAMPLE_PROFILE);

  assert.equal(profile.total, 50);
  assert.equal(profile.samples, 4);
  assert.equal(profile.unit, 'milliseconds');
  assert.equal(profile.name, 'SampleApp');
  assert.equal(profile.file, '/out/cpu-1.speedscope.json');

  const main = method(profile, 'Main');
  assert.equal(main.exclusive, 0);
  assert.equal(main.inclusive, 50);
  assert.equal(main.inclusivePercent, 100);
  assert.equal(main.inclusiveSamples, 4);

  const work = method(profile, 'Work');
  assert.equal(work.exclusive, 15);
  assert.equal(work.inclusive, 30);
  assert.equal(work.exclusivePercent, 30);
  assert.equal(work.inclusivePercent, 60);

  const alloc = method(profile, 'Alloc');
  assert.equal(alloc.exclusive, 35);
  assert.equal(alloc.inclusive, 35);
  assert.equal(alloc.exclusivePercent, 70);
  assert.equal(alloc.exclusiveSamples, 3);
  assert.equal(alloc.inclusiveSamples, 3);
  assert.equal(alloc.file, 'Lib.cs');
  assert.equal(alloc.line, 5);
});

test('строит дерево вызовов с сортировкой по полному времени', () => {
  const profile = profileFrom(SAMPLE_PROFILE);

  assert.equal(profile.truncated, false);
  assert.equal(profile.roots.length, 1);
  const main = profile.roots[0];
  assert.equal(main.name, 'Main');
  assert.equal(main.exclusive, 0);
  assert.equal(main.inclusive, 50);

  // Сначала Work (30), затем прямой вызов Alloc (20).
  assert.deepEqual(main.children.map(child => [child.name, child.inclusive, child.exclusive]), [
    ['Work', 30, 15],
    ['Alloc', 20, 20],
  ]);
  assert.deepEqual(main.children[0].children.map(child => [child.name, child.inclusive, child.exclusive]), [
    ['Alloc', 15, 15],
  ]);
  assert.equal(main.children[1].children.length, 0);
});

test('рекурсивный метод учитывается в inclusive один раз за сэмпл', () => {
  const profile = profileFrom({
    shared: { frames: [{ name: 'Recurse', file: 'R.cs', line: 1 }, { name: 'Leaf', file: 'R.cs', line: 2 }] },
    profiles: [{ type: 'sampled', unit: 'milliseconds', samples: [[0, 0, 1]], weights: [10] }],
  });

  const recurse = method(profile, 'Recurse');
  assert.equal(recurse.inclusive, 10);
  assert.equal(recurse.inclusiveSamples, 1);
  assert.equal(recurse.exclusive, 0);

  const root = profile.roots[0];
  assert.equal(root.inclusive, 10);
  assert.equal(root.children[0].name, 'Recurse');
  assert.equal(root.children[0].inclusive, 10);
  assert.equal(root.children[0].children[0].name, 'Leaf');
});

test('без весов каждый сэмпл весит единицу', () => {
  const profile = profileFrom({
    shared: { frames: [{ name: 'A', file: 'a.cs', line: 1 }] },
    profiles: [{ type: 'sampled', samples: [[0], [0], [0]] }],
  });

  assert.equal(profile.total, 3);
  assert.equal(profile.samples, 3);
  assert.equal(method(profile, 'A').exclusive, 3);
  // Единицы инструмента не указаны: проценты всё равно считаются.
  assert.equal(profile.unit, 'none');
});

test('событийный профиль переводится в интервалы', () => {
  const profile = profileFrom({
    shared: { frames: [{ name: 'Main', file: 'M.cs', line: 1 }, { name: 'Child', file: 'M.cs', line: 2 }] },
    profiles: [{
      type: 'evented',
      unit: 'milliseconds',
      startValue: 0,
      endValue: 30,
      events: [
        { type: 'O', frame: 0, at: 0 },
        { type: 'O', frame: 1, at: 10 },
        { type: 'C', frame: 1, at: 20 },
        { type: 'C', frame: 0, at: 30 },
      ],
    }],
  });

  assert.equal(profile.total, 30);
  assert.equal(method(profile, 'Main').exclusive, 20);
  assert.equal(method(profile, 'Main').inclusive, 30);
  assert.equal(method(profile, 'Child').exclusive, 10);
  assert.equal(method(profile, 'Child').inclusive, 10);
});

test('время блокировки исключается из профиля CPU', () => {
  const profile = profileFrom({
    shared: {
      frames: [
        { name: 'Main', file: 'M.cs', line: 1 },
        { name: 'Work', file: 'M.cs', line: 2 },
        { name: 'CPU_TIME' },
        { name: 'UNMANAGED_CODE_TIME' },
      ],
    },
    profiles: [{
      type: 'sampled',
      unit: 'milliseconds',
      samples: [[0, 1, 2], [0, 1, 3], [0, 3]],
      weights: [10, 90, 50],
    }],
  });

  // В профиль CPU попадает только сэмпл с маркером CPU_TIME.
  assert.equal(profile.total, 10);
  assert.equal(profile.samples, 1);
  assert.equal(profile.blocked, 140);
  assert.equal(profile.blockedSamples, 2);
  assert.equal(profile.methods.length, 2);
  assert.equal(method(profile, 'Work').exclusivePercent, 100);
  // Служебные кадры не становятся методами.
  assert.equal(profile.methods.some(item => item.name === 'CPU_TIME'), false);
});

test('служебные кадры процесса и потоков не заслоняют стек', () => {
  const profile = profileFrom({
    shared: {
      frames: [
        { name: 'Process64 dotnet (149296) Args: app.dll' },
        { name: '(Non-Activities)' },
        { name: 'Threads' },
        { name: 'Thread (149309)' },
        { name: 'Main', file: 'M.cs', line: 1 },
        { name: 'Work', file: 'M.cs', line: 2 },
      ],
    },
    profiles: [{ type: 'sampled', unit: 'milliseconds', samples: [[0, 1, 2, 3, 4, 5]], weights: [10] }],
  });

  assert.equal(profile.roots.length, 1);
  assert.equal(profile.roots[0].name, 'Thread (149309)');
  assert.equal(profile.roots[0].inclusivePercent, 100);
  assert.equal(profile.roots[0].children[0].name, 'Main');
  assert.equal(profile.roots[0].children[0].children[0].name, 'Work');
  // Служебные кадры не должны попадать в список методов.
  assert.deepEqual(profile.methods.map(item => item.name).sort(), ['Main', 'Work']);
});

test('некорректный файл не считается профилем, пустой разбирается без времени', () => {
  assert.equal(parseSpeedscope('не json'), undefined);
  assert.equal(parseSpeedscope('{}'), undefined);
  assert.equal(parseSpeedscope(JSON.stringify({ shared: { frames: [] } })), undefined);

  const empty = parseSpeedscope(JSON.stringify({ shared: { frames: [] }, profiles: [] }), 'empty.speedscope.json');
  assert.notEqual(empty, undefined);
  assert.equal(empty?.total, 0);
  assert.deepEqual(empty?.methods, []);
  assert.deepEqual(empty?.roots, []);
});

test('сэмплы с неизвестными кадрами пропускаются, а не ломают разбор', () => {
  const profile = profileFrom({
    shared: { frames: [{ name: 'Main', file: 'M.cs', line: 1 }] },
    profiles: [{ type: 'sampled', samples: [[0], [99], ['x'], []], weights: [5, 1, 1, 1] }],
  });

  assert.equal(profile.total, 5);
  assert.equal(profile.samples, 1);
  assert.equal(profile.methods.length, 1);
});

test('одинаковые имена в разных файлах — разные методы', () => {
  const profile = profileFrom({
    shared: {
      frames: [
        { name: 'Run', file: 'First.cs', line: 1 },
        { name: 'Run', file: 'Second.cs', line: 2 },
      ],
    },
    profiles: [{ type: 'sampled', samples: [[0], [1]], weights: [10, 30] }],
  });

  assert.equal(profile.methods.length, 2);
  assert.equal(method(profile, 'Run').file, 'Second.cs');
  assert.notEqual(frameKey({ name: 'Run', file: 'First.cs' }), frameKey({ name: 'Run', file: 'Second.cs' }));
});

test('сравнение показывает добавленные, удалённые и изменённые методы', () => {
  const before = profileFrom({
    shared: {
      frames: [
        { name: 'Main', file: 'M.cs', line: 1 },
        { name: 'Old', file: 'O.cs', line: 1 },
      ],
    },
    profiles: [{ type: 'sampled', samples: [[0, 1]], weights: [40] }],
  });
  const after = profileFrom({
    shared: {
      frames: [
        { name: 'Main', file: 'M.cs', line: 1 },
        { name: 'New', file: 'N.cs', line: 1 },
      ],
    },
    profiles: [{ type: 'sampled', samples: [[0, 1]], weights: [60] }],
  });

  const comparison = compareCpuProfiles(before, after);
  assert.equal(comparison.rows.length, 3);
  assert.equal(comparison.rows[0].status, 'added');
  assert.equal(comparison.rows[0].name, 'New');
  assert.equal(comparison.rows[0].deltaExclusivePercent, 100);
  assert.equal(comparison.rows[1].status, 'removed');
  assert.equal(comparison.rows[1].name, 'Old');
  assert.equal(comparison.rows[1].deltaExclusivePercent, -100);

  const main = comparison.rows.find(row => row.name === 'Main');
  assert.equal(main?.status, 'changed');
  assert.equal(main?.beforeInclusivePercent, 100);
  assert.equal(main?.afterInclusivePercent, 100);
  assert.equal(main?.deltaInclusivePercent, 0);

  // Общее время выросло с 40 до 60 мс — на 50 %.
  assert.equal(comparison.totalDeltaPercent, 50);
});

test('длительность профиля переводится в миллисекунды', () => {
  assert.equal(weightToMilliseconds(1, 'milliseconds'), 1);
  assert.equal(weightToMilliseconds(1.5, 'seconds'), 1500);
  assert.equal(weightToMilliseconds(2000, 'microseconds'), 2);
  assert.equal(weightToMilliseconds(3_000_000, 'nanoseconds'), 3);
  assert.equal(weightToMilliseconds(42, 'none'), 42);

  const profile = profileFrom(SAMPLE_PROFILE);
  assert.equal(cpuDurationMilliseconds(profile), 50);
});
