/**
 * Заглушка API VS Code для автотестов.
 * Позволяет запустить собранное расширение в Node и проверить, что активация проходит без ошибок,
 * что все команды и панели зарегистрированы, а панель графиков отдаёт корректную разметку.
 *
 * Используется только в тестах: сам код расширения получает настоящий модуль `vscode`.
 */

/** Что было зарегистрировано расширением — для проверок в тестах. */
export interface VscodeStubRegistry {
  commands: string[];
  treeViews: string[];
  /** Провайдеры webview-панелей по идентификатору вида. */
  webviewViews: Map<string, unknown>;
  /** Провайдеры деревьев по идентификатору вида: тесты проверяют их содержимое. */
  treeProviders: Map<string, unknown>;
  outputChannels: string[];
  statusBarItems: number;
  disposables: number;
  /** Обработчики зарегистрированных команд: позволяют вызывать их из тестов. */
  commandHandlers: Map<string, (...args: unknown[]) => unknown>;
  /** Строки, записанные расширением в канал вывода. */
  logLines: string[];
  /** Тексты уведомлений, показанных через `window.showInformationMessage` и предупреждения. */
  notifications: string[];
  /** Команды, выполненные расширением: проверяются установка просмотрщика и открытие файла. */
  executedCommands: Array<{ id: string; args: unknown[] }>;
  /** Записанные изменения настроек: раздел, ключ и новое значение. */
  configurationUpdates: Array<{ section: string; key: string; value: unknown }>;
  /** Эмуляция событий отладки: с их помощью тесты запускают обработку сессии отладки. */
  debugSessions: {
    start: (session: unknown) => void;
    terminate: (session: unknown) => void;
  };
}

/** Сообщение, отправленное расширением в webview. */
export interface SentMessage {
  [key: string]: unknown;
}

/** Настройки заглушки: язык интерфейса и словарь переводов. */
export interface VscodeStubOptions {
  /** Код языка, который вернёт `vscode.env.language`. */
  language?: string;
  /** Переводы строк: ключ — английская строка. */
  translations?: Record<string, string>;
  /**
   * Выбор элемента в `window.showQuickPick`: нужен тестам, которые подключаются
   * к реальному процессу и поэтому должны указать его в списке.
   */
  quickPickSelector?: (items: readonly { label?: string; description?: string }[]) => unknown;
  /** Значения настроек: переопределяют значения по умолчанию в `getConfiguration().get`. */
  configuration?: Record<string, unknown>;
  /** Папка проекта: от неё зависит каталог результатов профилирования. */
  workspaceFolder?: string;
  /** Какие расширения считаются установленными. */
  installedExtensions?: readonly string[];
  /**
   * Ответ на уведомление с кнопками: возвращает выбранное действие или undefined.
   * Нужен тестам, которые проверяют предложения установить расширение или поменять настройку.
   */
  notificationResponder?: (message: string, actions: readonly string[]) => string | undefined;
}

/** Заглушка webview: хранит разметку и отправленные сообщения. */
export class StubWebview {
  options: Record<string, unknown> = {};
  html = '';
  readonly cspSource = 'vscode-webview://test-source';
  readonly messages: SentMessage[] = [];
  private receiveListener: ((message: unknown) => void) | undefined;

  asWebviewUri(uri: { path?: string; fsPath?: string }): { toString(): string; path?: string; fsPath?: string } {
    return { ...uri, toString: () => String(uri.fsPath ?? uri.path ?? '') };
  }

  async postMessage(message: SentMessage): Promise<boolean> {
    this.messages.push(message);
    return true;
  }

  onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void } {
    this.receiveListener = listener;
    return { dispose: () => this.receiveListener = undefined };
  }

  /** Эмулирует сообщение из webview в расширение. */
  receive(message: unknown): void {
    this.receiveListener?.(message);
  }
}

/** Заглушка webview-вида. */
export class StubWebviewView {
  readonly webview = new StubWebview();
  visible = true;

  onDidChangeVisibility(listener: () => void): { dispose(): void } {
    void listener;
    return { dispose: () => undefined };
  }

  onDidDispose(listener: () => void): { dispose(): void } {
    void listener;
    return { dispose: () => undefined };
  }
}

export function createVscodeStub(
  options: VscodeStubOptions = {},
): { vscode: Record<string, unknown>; registry: VscodeStubRegistry } {
  const registry: VscodeStubRegistry = {
    commands: [],
    treeViews: [],
    webviewViews: new Map(),
    treeProviders: new Map(),
    outputChannels: [],
    statusBarItems: 0,
    disposables: 0,
    commandHandlers: new Map(),
    logLines: [],
    notifications: [],
    executedCommands: [],
    configurationUpdates: [],
    debugSessions: {
      start: () => undefined,
      terminate: () => undefined,
    },
  };

  class Disposable {
    private readonly callback: () => void;

    // Параметры-свойства не поддерживаются в режиме удаления типов Node, поэтому пишем явно.
    constructor(callback: () => void = () => undefined) {
      this.callback = callback;
    }

    dispose(): void {
      this.callback();
    }
  }

  class EventEmitter<T> {
    private readonly listeners = new Set<(value: T) => void>();

    readonly event = (listener: (value: T) => void): Disposable => {
      this.listeners.add(listener);
      return new Disposable(() => this.listeners.delete(listener));
    };

    fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose(): void {
      this.listeners.clear();
    }
  }

  class TreeItem {
    readonly label: string;
    readonly collapsibleState: number;
    id?: string;
    description?: string;
    tooltip?: unknown;
    iconPath?: unknown;
    contextValue?: string;
    command?: unknown;

    constructor(label: string, collapsibleState = 0) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  }

  class MarkdownString {
    readonly value: string;

    constructor(value = '') {
      this.value = value;
    }
  }

  class ThemeIcon {
    readonly id: string;
    readonly color?: unknown;

    constructor(id: string, color?: unknown) {
      this.id = id;
      this.color = color;
    }
  }

  class ThemeColor {
    readonly id: string;

    constructor(id: string) {
      this.id = id;
    }
  }

  const disposable = (): Disposable => {
    registry.disposables++;
    return new Disposable();
  };

  /** Простейшая заглушка URI: хранит путь и умеет склеивать сегменты. */
  const createUri = (path: string): Record<string, unknown> => ({
    scheme: 'file',
    path,
    fsPath: path,
    toString: () => path,
  });

  const vscode: Record<string, unknown> = {
    Disposable,
    // Механизм локализации VS Code: переводит строки по словарю, как это делает редактор.
    l10n: {
      t: (message: string) => options.translations?.[message] ?? message,
    },
    EventEmitter,
    TreeItem,
    MarkdownString,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ViewColumn: { Active: -1, One: 1 },
    Uri: {
      file: (path: string) => createUri(path),
      parse: (value: string) => createUri(value),
      joinPath: (base: { fsPath?: string }, ...parts: string[]) =>
        createUri([base.fsPath ?? '', ...parts].join('/')),
    },
    commands: {
      registerCommand: (id: string, handler: (...args: unknown[]) => unknown = () => undefined) => {
        registry.commands.push(id);
        registry.commandHandlers.set(id, handler);
        return disposable();
      },
      executeCommand: async (id: string, ...args: unknown[]) => {
        registry.executedCommands.push({ id, args });
        return registry.commandHandlers.get(id)?.(...args);
      },
    },
    window: {
      createOutputChannel: (name: string) => {
        registry.outputChannels.push(name);
        return {
          appendLine: (line: string) => registry.logLines.push(line),
          append: (text: string) => registry.logLines.push(text),
          show: () => undefined,
          dispose: () => undefined,
        };
      },
      createStatusBarItem: () => {
        registry.statusBarItems++;
        return { show: () => undefined, hide: () => undefined, dispose: () => undefined, text: '', tooltip: undefined, command: undefined };
      },
      registerTreeDataProvider: (id: string, provider: unknown) => {
        registry.treeViews.push(id);
        registry.treeProviders.set(id, provider);
        return disposable();
      },
      registerWebviewViewProvider: (id: string, provider: unknown) => {
        registry.webviewViews.set(id, provider);
        return disposable();
      },
      showInformationMessage: async (message: string, ...actions: string[]) => {
        registry.notifications.push(message);
        return options.notificationResponder?.(message, actions);
      },
      showWarningMessage: async (message: string) => {
        registry.notifications.push(message);
        return undefined;
      },
      showErrorMessage: async (message: string) => {
        registry.notifications.push(message);
        return undefined;
      },
      showQuickPick: async (items: readonly { label?: string; description?: string }[]) =>
        options.quickPickSelector?.(items),
      showInputBox: async () => undefined,
      setStatusBarMessage: () => disposable(),
      createTerminal: () => ({ show: () => undefined, sendText: () => undefined, dispose: () => undefined }),
      withProgress: async (_options: unknown, task: () => Promise<unknown>) => task(),
    },
    workspace: {
      workspaceFolders: options.workspaceFolder === undefined
        ? []
        : [{ uri: createUri(options.workspaceFolder), name: 'workspace', index: 0 }],
      getConfiguration: (section?: string) => ({
        get: <T>(key: string, defaultValue: T): T =>
          (options.configuration?.[key] as T | undefined) ?? defaultValue,
        update: async (key: string, value: unknown) => {
          registry.configurationUpdates.push({ section: section ?? '', key, value });
        },
      }),
      onDidChangeConfiguration: () => disposable(),
      openTextDocument: async () => ({}),
    },
    debug: {
      activeDebugSession: undefined,
      onDidStartDebugSession: (listener: (session: unknown) => void) => {
        registry.debugSessions.start = listener;
        return disposable();
      },
      onDidTerminateDebugSession: (listener: (session: unknown) => void) => {
        registry.debugSessions.terminate = listener;
        return disposable();
      },
    },
    extensions: {
      getExtension: (id: string) =>
        (options.installedExtensions ?? []).includes(id) ? { id, isActive: false } : undefined,
    },
    env: {
      language: options.language ?? 'en',
      clipboard: { writeText: async () => undefined },
      openExternal: async () => true,
    },
  };

  return { vscode, registry };
}
