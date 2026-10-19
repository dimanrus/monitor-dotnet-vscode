/**
 * Проверки поиска исполняемых файлов инструментов диагностики.
 *
 * Главный случай из жизни: `dotnet-trace` установлен глобально и доступен в терминале,
 * но расширение искало его как подкоманду `dotnet`, то есть запускало `dotnet dotnet-trace`.
 * Такой запуск завершается ошибкой «command or file was not found», и пользователь видел
 * сообщение «инструмент не установлен» при установленном инструменте.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { resolveToolPath, TRACE_TOOL, type ToolEnvironment } from './dotnetToolLocator.ts';

/** Окружение с заданным набором существующих файлов. */
function environment(existing: readonly string[], executableExtension = ''): ToolEnvironment {
  const files = new Set(existing);
  return {
    searchDirectories: ['/usr/local/bin', '/home/user/.dotnet/tools'],
    isExecutable: candidate => files.has(candidate),
    executableExtension,
  };
}

test('инструмент находится в каталоге глобальных инструментов (.NET на Linux и macOS)', () => {
  const found = resolveToolPath(
    TRACE_TOOL,
    environment(['/home/user/.dotnet/tools/dotnet-trace']),
  );

  assert.equal(found, '/home/user/.dotnet/tools/dotnet-trace');
});

test('инструмент находится в любом каталоге PATH', () => {
  const found = resolveToolPath(TRACE_TOOL, environment(['/usr/local/bin/dotnet-trace']));

  assert.equal(found, '/usr/local/bin/dotnet-trace');
});

test('на Windows имя ищется с расширением .exe', () => {
  const environmentWindows = environment(['/home/user/.dotnet/tools/dotnet-trace.exe'], '.exe');

  assert.equal(
    resolveToolPath(TRACE_TOOL, environmentWindows),
    '/home/user/.dotnet/tools/dotnet-trace.exe',
  );
  // Без расширения .exe инструмент не считается найденным.
  assert.equal(resolveToolPath(TRACE_TOOL, environment(['/home/user/.dotnet/tools/dotnet-trace'])), '/home/user/.dotnet/tools/dotnet-trace');
});

test('первый найденный каталог побеждает: порядок как в PATH', () => {
  const found = resolveToolPath(
    TRACE_TOOL,
    environment(['/usr/local/bin/dotnet-trace', '/home/user/.dotnet/tools/dotnet-trace']),
  );

  assert.equal(found, '/usr/local/bin/dotnet-trace');
});

test('файл, который не является исполняемым, не подходит', () => {
  // Окружение считает исполняемым только перечисленные пути: остальные «есть, но не запускаются».
  const found = resolveToolPath(TRACE_TOOL, environment([]));

  assert.equal(found, undefined);
});

test('пустые каталоги в списке поиска пропускаются', () => {
  const withEmpty: ToolEnvironment = {
    searchDirectories: ['', '/home/user/.dotnet/tools'],
    isExecutable: candidate => candidate === path.join('/home/user/.dotnet/tools', 'dotnet-trace'),
    executableExtension: '',
  };

  assert.equal(resolveToolPath(TRACE_TOOL, withEmpty), '/home/user/.dotnet/tools/dotnet-trace');
});

test('ненайденный инструмент даёт undefined, а не исключение', () => {
  assert.equal(resolveToolPath(TRACE_TOOL, environment([])), undefined);
});

test('поиск идёт по имени команды, а не по имени пакета', () => {
  // Пакет и команда совпадают у всех трёх инструментов, но проверка страхует от переименования.
  const found = resolveToolPath(
    { command: 'custom-tool', packageName: 'some.package', purpose: 'test' },
    environment(['/home/user/.dotnet/tools/custom-tool', '/home/user/.dotnet/tools/some.package']),
  );

  assert.equal(found, '/home/user/.dotnet/tools/custom-tool');
});
