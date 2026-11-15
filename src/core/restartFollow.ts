/**
 * Поиск приложения, которое запустилось заново.
 *
 * `dotnet watch` поднимает приложение повторно: после сбоя (crash recovery), при перезапуске
 * из-за Hot Reload и при перезапуске Aspire AppHost. Новый экземпляр получает другой PID,
 * но запускается с той же командной строкой — по ней и находится цель, поэтому мониторинг
 * может продолжиться сам, без повторного выбора процесса.
 *
 * Логика не зависит от API VS Code, поэтому её проверяют тесты.
 */

import type { ProcessCandidate } from './debuggeeMatching.ts';

/** Что известно о завершившемся процессе. */
export interface RestartSearch {
  /** PID завершившегося процесса: его самого выбирать нельзя. */
  pid: number;
  /** Командная строка завершившегося процесса. */
  commandLine: string;
  /** Когда замечено завершение, миллисекунды UNIX. */
  exitedAtMs: number;
}

/**
 * Запас по времени старта: приложение могло запуститься за мгновение до того,
 * как расширение обработало выход предыдущего процесса.
 */
export const RESTART_START_TOLERANCE_MS = 5_000;

/**
 * Приводит командную строку к сравнимому виду.
 * Мост и список процессов читают её разными способами, поэтому кавычки и лишние
 * пробелы не должны мешать сравнению.
 */
export function normalizeCommandLine(commandLine: string): string {
  const unified = commandLine.replace(/"/g, '').replace(/\s+/g, ' ').trim();
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/**
 * Находит процесс, запущенный заново с той же командной строкой.
 * Возвращает `undefined`, пока нового экземпляра нет: вызывающий код продолжает ждать.
 */
export function findRestartedTarget(
  candidates: readonly ProcessCandidate[],
  search: RestartSearch,
): number | undefined {
  const expected = normalizeCommandLine(search.commandLine);
  if (expected.length === 0) {
    return undefined;
  }

  const earliestStartMs = search.exitedAtMs - RESTART_START_TOLERANCE_MS;
  let best: ProcessCandidate | undefined;
  for (const candidate of candidates) {
    // Процесс без времени старта мог работать и до перезапуска — такой целью не считаем.
    if (candidate.pid === search.pid || candidate.startTimeMs < earliestStartMs) {
      continue;
    }

    if (normalizeCommandLine(candidate.commandLine) !== expected) {
      continue;
    }

    // При нескольких совпадениях берём последний запущенный экземпляр.
    if (best === undefined || candidate.startTimeMs > best.startTimeMs) {
      best = candidate;
    }
  }

  return best?.pid;
}
