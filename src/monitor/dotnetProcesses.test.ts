import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDotnetCandidate, isIgnored, type DotnetDetectionEnvironment } from './dotnetProcesses.ts';
import type { ProcessCandidate } from '../core/debuggeeMatching.ts';

/** Окружение без доступа к диску: наличие сборки задаётся явно. */
function environmentWithAssemblies(...paths: string[]): DotnetDetectionEnvironment {
  const known = new Set(paths);
  return { hasSiblingAssembly: path => known.has(path) };
}

const noAssemblies = environmentWithAssemblies();

function candidate(commandLine: string, executablePath = ''): ProcessCandidate {
  return {
    pid: 1,
    name: 'unknown',
    commandLine,
    startTimeMs: 1,
    executablePath,
  };
}

test('процесс хоста dotnet распознаётся по имени (случай "dotnet App.dll")', () => {
  assert.equal(isDotnetCandidate(candidate('/usr/bin/dotnet /repo/App.dll'), noAssemblies), true);
});

test('процесс распознаётся, если в командной строке есть сборка', () => {
  assert.equal(isDotnetCandidate(candidate('/repo/App /repo/App.dll'), noAssemblies), true);
});

test('apphost распознаётся по сборке рядом с исполняемым файлом', () => {
  // Регрессия: отладчик .NET запускает apphost, в командной строке нет ни "dotnet", ни ".dll".
  const apphost = candidate(
    '/home/user/app/bin/Debug/net10.0/SampleApp',
    '/home/user/app/bin/Debug/net10.0/SampleApp',
  );

  assert.equal(
    isDotnetCandidate(apphost, environmentWithAssemblies('/home/user/app/bin/Debug/net10.0/SampleApp')),
    true,
  );
});

test('apphost распознаётся, даже если путь в командной строке относительный', () => {
  // Путь берём от операционной системы: в командной строке он может быть относительным.
  const apphost = candidate('./bin/Debug/net10.0/SampleApp', '/repo/samples/SampleApp/bin/Debug/net10.0/SampleApp');

  assert.equal(
    isDotnetCandidate(apphost, environmentWithAssemblies('/repo/samples/SampleApp/bin/Debug/net10.0/SampleApp')),
    true,
  );
});

test('посторонний процесс не считается приложением .NET', () => {
  assert.equal(isDotnetCandidate(candidate('/usr/bin/bash -c echo'), noAssemblies), false);
  assert.equal(isDotnetCandidate(candidate('/usr/bin/python3 script.py'), noAssemblies), false);
});

test('служебные процессы мониторинга и редактора отбрасываются', () => {
  assert.equal(isIgnored(candidate('dotnet /ext/dist/bridge/MonitorDotnet.Bridge.dll --pid 1')), true);
  assert.equal(isIgnored(candidate('dotnet-counters monitor -p 1')), true);
  assert.equal(isIgnored(candidate('/usr/share/code/code /home/user/.vscode/extensions/app/bin/server')), true);

  assert.equal(isIgnored(candidate('/home/user/app/bin/Debug/net10.0/SampleApp')), false);
});

test('оболочка, которая лишь упоминает путь к .dll, не считается процессом .NET (регрессия)', () => {
  // Случай из живой проверки: `bash -c` с текстом команды в аргументах попадал в кандидаты
  // и мог обыграть настоящую цель при выборе «самого позднего» процесса.
  assert.equal(
    isDotnetCandidate(candidate('/bin/bash -c node probe.ts --program /repo/App/bin/Debug/net10.0/App.dll'), noAssemblies),
    false,
  );
  assert.equal(
    isDotnetCandidate(candidate('/usr/lib/code/code --folder-uri file:///repo /repo/App.dll'), noAssemblies),
    false,
  );
});

test('запуск сборки хостом распознаётся по второй подсказке в командной строке', () => {
  assert.equal(isDotnetCandidate(candidate('/usr/bin/myhost /repo/App.dll'), noAssemblies), true);
});

test('инфраструктура Aspire не попадает в кандидаты', () => {
  // Командная строка Aspire, дашборд и оркестратор запускаются ради отладки, а не для мониторинга.
  assert.equal(isIgnored(candidate('/home/user/.dotnet/tools/aspire run --apphost /repo/AppHost')), true);
  assert.equal(isIgnored(candidate('/home/user/.dotnet/tools/.store/aspire.cli/13.6.1/dashboard/Aspire.Dashboard')), true);
  assert.equal(isIgnored(candidate('/home/user/.dotnet/tools/.store/aspire.cli/13.6.1/dcp/dcp start-apiserver')), true);
  // Сам проект AppHost при этом остаётся кандидатом.
  assert.equal(isIgnored(candidate('/repo/AspireApp.AppHost/bin/Debug/net10.0/AspireApp.AppHost')), false);
});
