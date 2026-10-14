import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectDebuggeePid, type ProcessCandidate } from './debuggeeMatching.ts';

function candidate(pid: number, commandLine: string, startTimeMs = 0, name = 'dotnet'): ProcessCandidate {
  return { pid, commandLine, startTimeMs, name };
}

const sessionStartMs = 1_000_000;
const program = '/repo/samples/SampleApp/bin/Debug/net10.0/SampleApp.dll';

test('явный processId из конфигурации attach имеет приоритет', () => {
  const pid = selectDebuggeePid([candidate(5, '/usr/bin/dotnet app.dll', 900_000)], {
    processId: 77,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 77);
});

test('цель находится по пути к программе из конфигурации запуска', () => {
  const pid = selectDebuggeePid([
    candidate(10, '/usr/bin/dotnet /home/user/other/Other.dll', sessionStartMs),
    candidate(11, `/usr/bin/dotnet ${program}`, sessionStartMs + 3_000),
  ], {
    program,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 11);
});

test('похожий процесс, запущенный до сессии, не выбирается (регрессия)', () => {
  // Случай из реальной проверки: рядом уже работал такой же SampleApp,
  // запущенный за минуту до сессии. Подключаться к нему нельзя — ждём настоящую цель.
  const pid = selectDebuggeePid([
    candidate(65043, 'dotnet bin/Debug/net10.0/SampleApp.dll', sessionStartMs - 60_000),
  ], {
    program,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, undefined);
});

test('когда рядом есть старый процесс, выбирается именно отлаживаемый', () => {
  const pid = selectDebuggeePid([
    candidate(65043, 'dotnet bin/Debug/net10.0/SampleApp.dll', sessionStartMs - 60_000),
    candidate(67359, `${program.replace(/\.dll$/, '')}`, sessionStartMs + 3_000),
  ], {
    program,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 67359);
});

test('при нескольких совпадениях выбирается самый поздний процесс', () => {
  const pid = selectDebuggeePid([
    candidate(10, `/usr/bin/dotnet ${program}`, sessionStartMs + 1_000),
    candidate(11, `/usr/bin/dotnet ${program}`, sessionStartMs + 2_000),
  ], {
    program,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 11);
});

test('без подсказок берётся самый поздний процесс сессии', () => {
  const pid = selectDebuggeePid([
    candidate(3, '/usr/bin/dotnet старое.dll', 100_000),
    candidate(4, '/usr/bin/dotnet новое.dll', sessionStartMs + 500),
  ], {
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 4);
});

test('без подсказок и без свежих процессов цель не выбрана', () => {
  const pid = selectDebuggeePid([candidate(3, '/usr/bin/dotnet старое.dll', 100_000)], {
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, undefined);
});

test('процессы из списка исключений не выбираются', () => {
  const pid = selectDebuggeePid([candidate(9, `/usr/bin/dotnet ${program}`, sessionStartMs)], {
    program,
    sessionStartMs,
    excludePids: [9],
  });

  assert.equal(pid, undefined);
});

test('фильтр по имени процесса сужает список кандидатов', () => {
  const pid = selectDebuggeePid([
    candidate(20, `/usr/bin/dotnet ${program}`, sessionStartMs),
    candidate(21, '/usr/bin/dotnet /other/Api.dll', sessionStartMs),
  ], {
    program,
    processNameFilter: 'sampleapp',
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 20);
});

test('allowFallback разрешает выбор без совпадения по программе', () => {
  // Используется в самом конце поиска: лучше подключиться к единственному свежему процессу,
  // чем не запустить мониторинг вовсе.
  const pid = selectDebuggeePid([
    candidate(30, '/usr/bin/dotnet /other/Unknown.dll', sessionStartMs + 1_000),
  ], {
    program,
    sessionStartMs,
    excludePids: [],
    allowFallback: true,
  });

  assert.equal(pid, 30);
});

test('процесс без времени старта не выбирается по совпадению программы', () => {
  const pid = selectDebuggeePid([candidate(40, `/usr/bin/dotnet ${program}`, 0)], {
    program,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, undefined);
});
