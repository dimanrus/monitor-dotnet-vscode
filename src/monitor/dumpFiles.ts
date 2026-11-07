/**
 * Список файлов памяти в каталоге результатов: дампы `.dmp` и снимки `.gcdump`.
 *
 * Нужен панели «Дампы»: она показывает все файлы со временем и размером,
 * чтобы любой из них можно было сразу открыть для анализа или сравнения.
 * Модуль не зависит от API VS Code: его проверяют тесты.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Что лежит в файле: полный дамп процесса или снимок управляемой кучи. */
export type MemoryFileKind = 'dump' | 'snapshot';

/** Файл памяти в каталоге результатов. */
export interface DumpFileInfo {
  /** Полный путь к файлу. */
  file: string;
  /** Размер файла в байтах. */
  bytes: number;
  /** Время изменения файла в миллисекундах. */
  modifiedMs: number;
  /** Вид файла: от него зависит команда открытия. */
  kind: MemoryFileKind;
}

/** Расширение файла и его вид. */
const MEMORY_EXTENSIONS: ReadonlyArray<readonly [string, MemoryFileKind]> = [
  ['.dmp', 'dump'],
  ['.gcdump', 'snapshot'],
];

/** Файлы памяти в каталоге: самые свежие первыми. */
export async function listMemoryFiles(directory: string): Promise<DumpFileInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const files: DumpFileInfo[] = [];
  for (const entry of entries) {
    const extension = MEMORY_EXTENSIONS.find(([suffix]) => entry.toLowerCase().endsWith(suffix));
    if (extension === undefined) {
      continue;
    }

    const file = path.join(directory, entry);
    try {
      const info = await stat(file);
      if (info.isFile()) {
        files.push({ file, bytes: info.size, modifiedMs: info.mtimeMs, kind: extension[1] });
      }
    } catch {
      // Файл исчез, пока читали каталог: пропускаем.
    }
  }

  return files.sort((left, right) => right.modifiedMs - left.modifiedMs);
}

/** Дампы `.dmp` в каталоге: самые свежие первыми. */
export async function listDumpFiles(directory: string): Promise<DumpFileInfo[]> {
  return (await listMemoryFiles(directory)).filter(file => file.kind === 'dump');
}

/** Снимки памяти `.gcdump` в каталоге: самые свежие первыми. */
export async function listSnapshotFiles(directory: string): Promise<DumpFileInfo[]> {
  return (await listMemoryFiles(directory)).filter(file => file.kind === 'snapshot');
}
