/**
 * Список целей мониторинга: запущенные сессии отладки и процессы .NET.
 *
 * Один источник данных для двух мест: выпадающего списка в панели Performance и команды
 * выбора процесса. Так список целей везде одинаковый и его проверяют тесты.
 *
 * Логика не зависит от API VS Code.
 */

import type { ProcessCandidate } from './debuggeeMatching.ts';
import { truncate } from './formatting.ts';
import { translate } from './locale.ts';

/** Сессия отладки в том виде, в каком она нужна списку целей. */
export interface TargetSession {
  id: string;
  name: string;
  type: string;
  pid?: number;
}

/** Одна строка списка: сессия отладки или отдельный процесс. */
export interface TargetEntry {
  kind: 'session' | 'process';
  /** Значение для выпадающего списка и для команды выбора. */
  value: string;
  /** Имя сессии или процесса. */
  name: string;
  /** Дополнительная строка: тип сессии и каталог либо командная строка. */
  detail: string;
  /** Процесс цели; неизвестен, пока сессия не подключилась к приложению. */
  pid?: number;
  /** Идентификатор сессии для `kind === 'session'`. */
  sessionId?: string;
  /** Цель, которую мониторят прямо сейчас. */
  isCurrent: boolean;
}

/** Цели, разложенные по группам: сначала сессии отладки, потом остальные процессы. */
export interface TargetGroups {
  sessions: TargetEntry[];
  processes: TargetEntry[];
}

/** Сколько символов командной строки показываем в списке. */
const COMMAND_LINE_LIMIT = 110;

/** Собирает список целей. Порядок сессий сохраняется: так же их показывает панель отладки. */
export function buildTargets(
  sessions: readonly TargetSession[],
  processes: readonly ProcessCandidate[],
  currentPid?: number,
): TargetGroups {
  const sessionEntries = sessions.map(session => sessionEntry(session, currentPid));
  const sessionPids = new Set(
    sessionEntries
      .map(entry => entry.pid)
      .filter((pid): pid is number => pid !== undefined),
  );

  const processEntries = processes
    // Процессы сессий уже показаны строкой сессии: дублировать их не нужно.
    .filter(process => !sessionPids.has(process.pid))
    .map(process => processEntry(process, currentPid))
    .sort((left, right) => left.name.localeCompare(right.name) || (left.pid ?? 0) - (right.pid ?? 0));

  return { sessions: sessionEntries, processes: processEntries };
}

/** Строка сессии отладки. */
function sessionEntry(session: TargetSession, currentPid?: number): TargetEntry {
  const isCurrent = session.pid !== undefined && session.pid === currentPid;
  return {
    kind: 'session',
    value: `session:${session.id}`,
    name: session.name,
    detail: session.pid === undefined
      ? translate('debug session {0} · process is detected when selected', session.type)
      : translate('debug session {0} · PID {1}', session.type, session.pid),
    pid: session.pid,
    sessionId: session.id,
    isCurrent,
  };
}

/** Строка процесса, запущенного без отладки или не попавшего в список сессий. */
function processEntry(process: ProcessCandidate, currentPid?: number): TargetEntry {
  return {
    kind: 'process',
    value: `pid:${process.pid}`,
    name: process.name.length > 0 ? process.name : translate('process'),
    detail: truncate(process.commandLine.trim(), COMMAND_LINE_LIMIT),
    pid: process.pid,
    isCurrent: process.pid === currentPid,
  };
}

/** Общее число целей: нужно, чтобы понять, есть ли из чего выбирать. */
export function targetCount(groups: TargetGroups): number {
  return groups.sessions.length + groups.processes.length;
}

/** Есть ли из чего выбирать (кроме текущей цели). */
export function hasAlternativeTargets(groups: TargetGroups, currentPid?: number): boolean {
  return targetCount(groups) > (currentPid === undefined ? 0 : 1);
}
