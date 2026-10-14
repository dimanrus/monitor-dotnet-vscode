/**
 * Реестр активных сессий отладки .NET.
 *
 * VS Code даёт список сессий через события, а панель дебага показывает их пользователю.
 * Мониторингу нужны те же данные: какие приложения сейчас запущены под отладкой и какой
 * процесс за каждой сессией стоит. PIP процесса определяется один раз при старте сессии,
 * а если сразу не получилось — при выборе сессии в списке целей.
 *
 * Модуль не зависит от API VS Code: он принимает снимок сессии, поэтому его проверяют тесты.
 */

/** Снимок сессии отладки: всё, что нужно для показа и повторного поиска процесса. */
export interface DebugSessionSnapshot {
  id: string;
  name: string;
  type: string;
  /** Конфигурация запуска: из неё берутся подсказки для поиска процесса. */
  configuration: Record<string, unknown>;
  /** Каталог рабочей области сессии, если он известен. */
  workspaceFolder?: string;
  /** Процесс сессии; undefined, пока его не удалось определить. */
  pid?: number;
}

/** Слушатель изменений списка сессий. */
export type DebugSessionsListener = () => void;

export class DebugSessionRegistry {
  private readonly sessions = new Map<string, DebugSessionSnapshot>();
  private readonly listeners = new Set<DebugSessionsListener>();

  /** Добавляет сессию или обновляет уже известную. */
  add(session: DebugSessionSnapshot): void {
    const previous = this.sessions.get(session.id);
    this.sessions.set(session.id, { ...previous, ...session });
    this.notify();
  }

  /** Забывает сессию: она завершилась. */
  remove(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      this.notify();
    }
  }

  /** Запоминает найденный процесс сессии, чтобы не искать его повторно. */
  setPid(sessionId: string, pid: number): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.pid === pid) {
      return;
    }

    this.sessions.set(sessionId, { ...session, pid });
    this.notify();
  }

  get(sessionId: string): DebugSessionSnapshot | undefined {
    return this.sessions.get(sessionId);
  }

  /** Сессии в порядке запуска: так же их показывает панель отладки VS Code. */
  list(): DebugSessionSnapshot[] {
    return [...this.sessions.values()];
  }

  /** Сколько сессий сейчас известно. */
  get size(): number {
    return this.sessions.size;
  }

  /** Сессии, для которых процесс уже определён. */
  withKnownPid(): DebugSessionSnapshot[] {
    return this.list().filter(session => session.pid !== undefined);
  }

  onDidChange(listener: DebugSessionsListener): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Освобождает подписки: реестр живёт столько же, сколько расширение. */
  dispose(): void {
    this.listeners.clear();
    this.sessions.clear();
  }

  clear(): void {
    if (this.sessions.size === 0) {
      return;
    }

    this.sessions.clear();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Снимок сессии из объекта VS Code. Поля берём по значению: сам объект живёт недолго. */
export function snapshotFromSession(session: {
  id: string;
  name: string;
  type: string;
  configuration?: Record<string, unknown>;
  workspaceFolder?: { uri?: { fsPath?: string } } | undefined;
}): DebugSessionSnapshot {
  const workspaceFolder = session.workspaceFolder?.uri?.fsPath;
  return {
    id: session.id,
    name: session.name,
    type: session.type,
    configuration: session.configuration ?? {},
    workspaceFolder: workspaceFolder !== undefined && workspaceFolder.length > 0 ? workspaceFolder : undefined,
  };
}
