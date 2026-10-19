/**
 * Поиск исполняемых файлов инструментов диагностики .NET.
 *
 * `dotnet-trace`, `dotnet-stack` и `dotnet-gcdump` — это глобальные инструменты,
 * то есть отдельные исполняемые файлы в каталоге `<home>/.dotnet/tools`.
 * Они не являются подкомандами `dotnet`: запуск `dotnet dotnet-trace` завершается ошибкой
 * «Could not execute because the specified command or file was not found», которую легко
 * принять за «инструмент не установлен».
 *
 * Модуль не зависит от API VS Code, поэтому его проверяют тесты.
 */

import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Инструмент .NET, нужный для получения данных. */
export interface DotnetTool {
  /** Имя команды, например `dotnet-stack`. */
  command: string;
  /** Имя пакета для `dotnet tool install -g`. */
  packageName: string;
  /** Что делает инструмент — для сообщений пользователю. */
  purpose: string;
}

export const CALL_STACK_TOOL: DotnetTool = {
  command: 'dotnet-stack',
  packageName: 'dotnet-stack',
  purpose: 'collecting a call stack',
};

export const MEMORY_SNAPSHOT_TOOL: DotnetTool = {
  command: 'dotnet-gcdump',
  packageName: 'dotnet-gcdump',
  purpose: 'taking a memory snapshot',
};

export const TRACE_TOOL: DotnetTool = {
  command: 'dotnet-trace',
  packageName: 'dotnet-trace',
  purpose: 'performance profiling',
};

export const DUMP_TOOL: DotnetTool = {
  command: 'dotnet-dump',
  packageName: 'dotnet-dump',
  purpose: 'taking a memory dump',
};

export const SYMBOL_TOOL: DotnetTool = {
  command: 'dotnet-symbol',
  packageName: 'dotnet-symbol',
  purpose: 'downloading symbols',
};

/**
 * Окружение поиска. Вынесено отдельно, чтобы тесты не зависели от содержимого диска
 * и от переменных окружения машины.
 */
export interface ToolEnvironment {
  /** Каталоги поиска в порядке приоритета. */
  searchDirectories: readonly string[];
  /** Существует ли файл и разрешён ли его запуск. */
  isExecutable: (candidate: string) => boolean;
  /** Расширение исполняемых файлов платформы: пусто или `.exe`. */
  executableExtension: string;
}

/**
 * Возвращает путь к исполняемому файлу инструмента.
 * `undefined` означает, что инструмент действительно не установлен.
 */
export function resolveToolPath(
  tool: DotnetTool,
  environment: ToolEnvironment = defaultToolEnvironment,
): string | undefined {
  const fileName = tool.command + environment.executableExtension;

  for (const directory of environment.searchDirectories) {
    if (directory.length === 0) {
      continue;
    }

    const candidate = path.join(directory, fileName);
    if (environment.isExecutable(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

/** Поиск по PATH, затем в каталоге глобальных инструментов .NET. */
export const defaultToolEnvironment: ToolEnvironment = {
  searchDirectories: searchDirectoriesForTools(),
  isExecutable: candidate => {
    try {
      const stats = statSync(candidate);
      if (!stats.isFile()) {
        return false;
      }

      // На Windows права на запуск проверяет само расширение файла, `X_OK` там не работает.
      if (process.platform !== 'win32') {
        accessSync(candidate, constants.X_OK);
      }

      return true;
    } catch {
      return false;
    }
  },
  executableExtension: process.platform === 'win32' ? '.exe' : '',
};

/** Каталоги, где может лежать глобальный инструмент. */
function searchDirectoriesForTools(): string[] {
  const directories: string[] = [];

  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry.length > 0) {
      directories.push(entry);
    }
  }

  // `dotnet tool install --global` складывает инструменты в `<DOTNET_CLI_HOME>/.dotnet/tools`,
  // а без этой переменной — в домашний каталог пользователя.
  const cliHome = process.env.DOTNET_CLI_HOME;
  if (cliHome !== undefined && cliHome.length > 0) {
    directories.push(path.join(cliHome, '.dotnet', 'tools'));
  }

  directories.push(path.join(os.homedir(), '.dotnet', 'tools'));

  return [...new Set(directories)];
}
