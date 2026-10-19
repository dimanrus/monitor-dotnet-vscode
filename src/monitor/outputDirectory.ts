/**
 * Каталог для результатов профилирования.
 *
 * По умолчанию файлы пишутся в папку проекта, в `.monitor-dotnet`: так они лежат рядом
 * с кодом, который профилировали, и не теряются во временном каталоге системы.
 * Внутри создаётся `.gitignore`, чтобы артефакты не попадали в репозиторий.
 *
 * Модуль не зависит от API VS Code: путь и запись файла передаются снаружи, поэтому
 * правила проверяются тестами.
 */

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Имя каталога с результатами внутри проекта. */
export const OUTPUT_DIRECTORY_NAME = '.monitor-dotnet';

/** Содержимое `.gitignore` внутри каталога: игнорируем всё, что там появится. */
const IGNORE_CONTENT = '# Результаты профилирования Monitor Dotnet\n*\n';

/**
 * Куда писать файлы, если настройка пуста.
 * В проекте — `.monitor-dotnet`, без проекта — временный каталог системы.
 */
export function defaultOutputDirectory(workspaceFolder: string | undefined): string {
  if (workspaceFolder !== undefined && workspaceFolder.length > 0) {
    return path.join(workspaceFolder, OUTPUT_DIRECTORY_NAME);
  }

  return path.join(os.tmpdir(), OUTPUT_DIRECTORY_NAME.replace('.', ''));
}

/**
 * Возвращает каталог для файлов и создаёт его при необходимости.
 * Для каталога внутри проекта кладёт `.gitignore`, повторный вызов ничего не ломает.
 */
export async function prepareOutputDirectory(
  configured: string,
  workspaceFolder: string | undefined,
): Promise<string> {
  const isDefault = configured.length === 0;
  const directory = isDefault ? defaultOutputDirectory(workspaceFolder) : path.resolve(configured);

  await mkdir(directory, { recursive: true });

  if (isDefault) {
    await ensureIgnored(directory);
  }

  return directory;
}

/**
 * Создаёт `.gitignore` с содержимым `*`, если его ещё нет.
 * Флаг `wx` не даёт перезаписать файл, который пользователь мог настроить сам.
 */
export async function ensureIgnored(directory: string): Promise<void> {
  try {
    await writeFile(path.join(directory, '.gitignore'), IGNORE_CONTENT, { flag: 'wx' });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      return;
    }

    throw error;
  }
}

/**
 * Файлы результатов с указанным расширением, самые свежие первыми.
 * Нужно кнопке «открыть профиль»: она берёт последний записанный файл.
 */
export async function listResultFiles(directory: string, extension: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const files: Array<{ path: string; modifiedMs: number }> = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(extension.toLowerCase())) {
      continue;
    }

    const fullPath = path.join(directory, entry);
    try {
      const info = await stat(fullPath);
      files.push({ path: fullPath, modifiedMs: info.mtimeMs });
    } catch {
      // Файл исчез, пока читали каталог: пропускаем.
    }
  }

  return files.sort((left, right) => right.modifiedMs - left.modifiedMs).map(file => file.path);
}
