/**
 * Общая обёртка над `execFile` с промисами.
 * Один экземпляр функции на всё расширение: одинаковые параметры и поведение
 * у поиска моста, списка процессов и запуска диагностических инструментов.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);
