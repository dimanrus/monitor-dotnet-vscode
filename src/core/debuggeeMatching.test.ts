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

// ─── Сценарии Aspire и C# Dev Kit ───
// Данные для этих проверок сняты с живого дерева процессов: Aspire CLI запускает проект
// AppHost, а сервисы — через `dotnet run --project`, поэтому рядом оказывается много процессов .NET.

/** Каталог примера Aspire: так выглядит дерево процессов настоящего решения. */
const aspireRoot = '/repo/samples/AspireApp';

test('в решении Aspire выбирается процесс AppHost, а не сервисы (регрессия)', () => {
  // Раньше побеждал самый поздний процесс — им оказывался запущенный сервис.
  const pid = selectDebuggeePid([
    candidate(100, `${aspireRoot}/AspireApp.AppHost/bin/Debug/net10.0/AspireApp.AppHost`, sessionStartMs + 1_000, 'AspireApp.AppHost'),
    candidate(101, `dotnet run --project ${aspireRoot}/AspireApp.Api/AspireApp.Api.csproj --no-build`, sessionStartMs + 2_000),
    candidate(102, `${aspireRoot}/AspireApp.Api/bin/Debug/net10.0/AspireApp.Api`, sessionStartMs + 3_000, 'AspireApp.Api'),
  ], {
    // Расширение Aspire передаёт в конфигурации каталог проекта AppHost.
    program: `${aspireRoot}/AspireApp.AppHost`,
    cwd: aspireRoot,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 100);
});

test('путь к файлу проекта AppHost тоже приводит к хосту', () => {
  // Так выглядит конфигурация, если в `program` попал .csproj: имя без расширения совпадает
  // с именем сборки AppHost.
  const pid = selectDebuggeePid([
    candidate(110, `${aspireRoot}/AspireApp.AppHost/bin/Debug/net10.0/AspireApp.AppHost`, sessionStartMs + 1_000, 'AspireApp.AppHost'),
    candidate(111, `${aspireRoot}/AspireApp.Api/bin/Debug/net10.0/AspireApp.Api`, sessionStartMs + 2_000, 'AspireApp.Api'),
  ], {
    program: `${aspireRoot}/AspireApp.AppHost/AspireApp.AppHost.csproj`,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 110);
});

test('projectPath из конфигурации C# Dev Kit выбирает приложение, а не обёртку dotnet run', () => {
  const pid = selectDebuggeePid([
    candidate(120, `dotnet run --project ${aspireRoot}/AspireApp.Api/AspireApp.Api.csproj --no-build`, sessionStartMs + 1_000),
    candidate(121, `${aspireRoot}/AspireApp.Api/bin/Debug/net10.0/AspireApp.Api`, sessionStartMs + 2_000, 'AspireApp.Api'),
  ], {
    projectPath: `${aspireRoot}/AspireApp.Api/AspireApp.Api.csproj`,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 121);
});

test('подсказка о рабочем каталоге не перебивает точное имя сборки', () => {
  const pid = selectDebuggeePid([
    candidate(130, `${aspireRoot}/AspireApp.Api/bin/Debug/net10.0/AspireApp.Api`, sessionStartMs + 1_000, 'AspireApp.Api'),
    candidate(131, `${aspireRoot}/AspireApp.AppHost/bin/Debug/net10.0/AspireApp.AppHost`, sessionStartMs + 2_000, 'AspireApp.AppHost'),
  ], {
    program: `${aspireRoot}/AspireApp.AppHost/bin/Debug/net10.0/AspireApp.AppHost.dll`,
    cwd: aspireRoot,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 131);
});

// ─── F# (Ionide) ───
// Приложение на F# компилируется в обычную сборку и запускается на том же рантайме, поэтому
// среда отладки у него та же: Ionide использует сессию `coreclr` и указывает в `program`
// собранный файл. Отличий в поиске процесса нет — меняются только расширения файлов проекта.

/** Каталог проекта F#: структура та же, что у C#. */
const fsharpRoot = '/repo/samples/FSharpApp';

test('F#-приложение находится по сборке из конфигурации запуска', () => {
  const pid = selectDebuggeePid([
    candidate(140, `${fsharpRoot}/bin/Debug/net10.0/FSharpApp`, sessionStartMs + 1_000, 'FSharpApp'),
    // Похожее имя не должно перебивать точное совпадение с путём к сборке.
    candidate(141, `${fsharpRoot}/bin/Debug/net10.0/Old.FSharpApp`, sessionStartMs + 2_000, 'Old.FSharpApp'),
  ], {
    program: `${fsharpRoot}/bin/Debug/net10.0/FSharpApp.dll`,
    cwd: fsharpRoot,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 140);
});

test('файл проекта F# (.fsproj) в `program` не мешает найти приложение', () => {
  // Так выглядит конфигурация, если в `program` попал файл проекта: расширение .fsproj
  // отбрасывается наравне с .csproj, поэтому признаком цели снова становится имя сборки,
  // и обёртка `dotnet run` не побеждает.
  const pid = selectDebuggeePid([
    candidate(150, `dotnet run --project ${fsharpRoot}/FSharpApp.fsproj`, sessionStartMs + 1_000),
    candidate(151, `/usr/lib/dotnet/dotnet ${fsharpRoot}/bin/Debug/net10.0/FSharpApp.dll`, sessionStartMs + 2_000),
  ], {
    program: `${fsharpRoot}/FSharpApp.fsproj`,
    cwd: fsharpRoot,
    sessionStartMs,
    excludePids: [],
  });

  assert.equal(pid, 151);
});
