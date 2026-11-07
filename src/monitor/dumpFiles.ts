/**
 * Список файлов дампов в каталоге результатов.
 *
 * Нужен панели «Дампы»: она показывает все `.dmp` со временем и размером,
 * чтобы любой из них можно было сразу открыть для анализа или сравнения.
 * Модуль не зависит от API VS Code: его проверяют тесты.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Файл дампа в каталоге результатов. */
export interface DumpFileInfo {
  /** Полный путь к файлу. */
  file: string;
  /** Размер файла в байтах. */
  bytes: number;
  /** Время изменения файла в миллисекундах. */
  modifiedMs: number;
}

/** Дампы `.dmp` в каталоге: самые свежие первыми. */
export async function listDumpFiles(directory: string): Promise<DumpFileInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const files: DumpFileInfo[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.dmp')) {
      continue;
    }

    const file = path.join(directory, entry);
    try {
      const info = await stat(file);
      if (info.isFile()) {
        files.push({ file, bytes: info.size, modifiedMs: info.mtimeMs });
      }
    } catch {
      // Файл исчез, пока читали каталог: пропускаем.
    }
  }

  return files.sort((left, right) => right.modifiedMs - left.modifiedMs);
}
