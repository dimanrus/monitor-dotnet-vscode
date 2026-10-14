/**
 * Проверки выбора процесса для мониторинга.
 *
 * Тест запускает собранное расширение с заглушкой VS Code, эмулирует две сессии отладки
 * (как при запуске связки проектов) и проверяет, что:
 *
 *  - панель получает список целей: сессии отладки и процессы .NET;
 *  - выбор цели в панели переключает мониторинг на другой процесс;
 *  - команда выбора процесса предлагает те же цели и переключается по выбору пользователя;
 *  - запуск второй сессии не перехватывает мониторинг молча.
 *
 * Процессы не запускаются: PID берётся из конфигурации attach, поэтому проверка быстрая.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createVscodeStub, StubWebviewView, type SentMessage, type VscodeStubRegistry } from './vscodeStub.ts';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

/** Первый процесс: как будто отладка подключилась к Api-серверу. */
const API_PID = 4241;
/** Второй процесс: хост Aspire. */
const HOST_PID = 4242;

interface LoadedExtension {
  activate: (context: unknown) => void;
  deactivate: () => void;
  registry: VscodeStubRegistry;
}

async function buildExtension(): Promise<string> {
  const outfile = path.join(projectRoot, 'dist', 'extension.cjs');
  await build({
    entryPoints: [path.join(projectRoot, 'src', 'extension.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
    logLevel: 'silent',
  });

  return outfile;
}

function loadExtension(bundlePath: string, quickPickSelector?: (items: readonly unknown[]) => unknown): LoadedExtension {
  const { vscode, registry } = createVscodeStub({ quickPickSelector: quickPickSelector as never });
  const moduleAny = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleAny._load;

  moduleAny._load = (request: string, parent: unknown, isMain: boolean) =>
    request === 'vscode' ? vscode : originalLoad(request, parent, isMain);

  try {
    delete require.cache[require.resolve(bundlePath)];
    const extension = require(bundlePath) as LoadedExtension;
    return { ...extension, registry };
  } finally {
    moduleAny._load = originalLoad;
  }
}

/** Сессия отладки, которая сразу сообщает свой PID (как конфигурация attach). */
function session(id: string, name: string, pid: number): unknown {
  return {
    id,
    name,
    type: 'coreclr',
    configuration: { type: 'coreclr', request: 'attach', processId: pid },
    workspaceFolder: { uri: { fsPath: projectRoot } },
  };
}

/** Сообщение панели заданного типа: последнее из отправленных. */
function lastMessage(view: StubWebviewView, type: string): SentMessage | undefined {
  return [...view.webview.messages].reverse().find(message => message.type === type);
}

/** Ждёт появления условия: панель обменивается сообщениями асинхронно. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error('не дождались изменения состояния');
}

/** Поднимает расширение с открытой панелью графиков. */
async function prepare(quickPickSelector?: (items: readonly unknown[]) => unknown): Promise<{
  extension: LoadedExtension;
  view: StubWebviewView;
  startSession: (session: unknown) => void;
  terminateSession: (session: unknown) => void;
}> {
  const bundlePath = await buildExtension();
  const extension = loadExtension(bundlePath, quickPickSelector);
  extension.activate({
    extensionPath: projectRoot,
    extensionUri: { fsPath: projectRoot },
    subscriptions: [] as unknown[],
  });

  const provider = extension.registry.webviewViews.get('monitor-dotnet.performance') as
    | { resolveWebviewView(view: StubWebviewView): void }
    | undefined;
  assert.ok(provider !== undefined, 'панель графиков не зарегистрирована');

  const view = new StubWebviewView();
  provider.resolveWebviewView(view);

  return {
    extension,
    view,
    startSession: sessionInfo => extension.registry.debugSessions.start(sessionInfo),
    terminateSession: sessionInfo => extension.registry.debugSessions.terminate(sessionInfo),
  };
}

test('панель получает список целей с сессиями отладки', async () => {
  const { extension, view, startSession } = await prepare();
  try {
    view.webview.receive({ type: 'ready' });
    startSession(session('s1', 'Отладка WebApi', API_PID));
    startSession(session('s2', 'Aspire: AppHost', HOST_PID));

    await waitFor(() => {
      const message = lastMessage(view, 'targets');
      const groups = message?.groups as { sessions?: Array<{ pid?: number }> } | undefined;
      // Процесс второй сессии ищется в фоне: ждём, пока появятся оба PID.
      return groups?.sessions?.length === 2 && groups.sessions.every(entry => entry.pid !== undefined);
    });

    const groups = lastMessage(view, 'targets')?.groups as {
      sessions: Array<{ name: string; value: string; pid: number; isCurrent: boolean }>;
    };

    assert.deepEqual(groups.sessions.map(entry => entry.name), ['Отладка WebApi', 'Aspire: AppHost']);
    assert.deepEqual(groups.sessions.map(entry => entry.pid), [API_PID, HOST_PID]);
    assert.deepEqual(groups.sessions.map(entry => entry.value), ['session:s1', 'session:s2']);
    // Вторая сессия не перехватила мониторинг: в журнале есть строка об этом.
    assert.ok(
      extension.registry.logLines.some(line => line.includes('was not started automatically')),
      'вторая сессия перехватила мониторинг',
    );
  } finally {
    extension.deactivate();
  }
});

test('выбор цели в панели переключает мониторинг на другой процесс', async () => {
  const { extension, view, startSession } = await prepare();
  try {
    view.webview.receive({ type: 'ready' });
    startSession(session('s1', 'Отладка WebApi', API_PID));
    await waitFor(() => extension.registry.logLines.some(line => line.includes(`--pid ${API_PID}`)));
    startSession(session('s2', 'Aspire: AppHost', HOST_PID));

    // Так панель сообщает о выборе другой цели.
    view.webview.receive({ type: 'selectTarget', target: 'session:s2' });

    await waitFor(() => extension.registry.logLines.some(line =>
      line.includes('Starting the bridge:') && line.includes(`--pid ${HOST_PID}`)));
    assert.ok(
      extension.registry.logLines.some(line => line.includes(`Monitoring switched to process ${HOST_PID}`)),
      'нет строки о переключении мониторинга',
    );
  } finally {
    extension.deactivate();
  }
});

test('команда выбора процесса предлагает сессии и процессы и переключается', async () => {
  const chosen: string[] = [];
  const { extension, startSession } = await prepare(items => {
    // Берём вторую сессию из списка: первая уже мониторится.
    const found = (items as Array<{ value?: string }>).find(item => item.value === 'session:s2');
    chosen.push(found?.value ?? '—');
    return found;
  });

  try {
    startSession(session('s1', 'Отладка WebApi', API_PID));
    await waitFor(() => extension.registry.logLines.some(line => line.includes(`--pid ${API_PID}`)));
    startSession(session('s2', 'Aspire: AppHost', HOST_PID));

    await extension.registry.commandHandlers.get('monitor-dotnet.selectTarget')?.();

    assert.deepEqual(chosen, ['session:s2'], 'в списке не нашлось второй сессии');
    await waitFor(() => extension.registry.logLines.some(line => line.includes(`--pid ${HOST_PID}`)));
  } finally {
    extension.deactivate();
  }
});

test('завершение мониторимой сессии освобождает цель для другой сессии', async () => {
  const { extension, view, startSession, terminateSession } = await prepare();
  try {
    view.webview.receive({ type: 'ready' });
    startSession(session('s1', 'Отладка WebApi', API_PID));
    await waitFor(() => extension.registry.logLines.some(line => line.includes(`--pid ${API_PID}`)));
    startSession(session('s2', 'Aspire: AppHost', HOST_PID));
    // Ждём, пока процесс второй сессии будет найден: иначе после остановки первой
    // расширению нечего предложить пользователю.
    await waitFor(() => {
      const groups = lastMessage(view, 'targets')?.groups as { sessions: Array<{ pid?: number }> } | undefined;
      return groups?.sessions[1]?.pid === HOST_PID;
    });

    terminateSession(session('s1', 'Отладка WebApi', API_PID));

    // Остановка мониторинга асинхронная, поэтому сообщение об оставшихся сессиях ждём.
    await waitFor(() => extension.registry.logLines.some(line => line.includes('Remaining debug sessions: Aspire: AppHost.')));
    // Завершённая сессия исчезает из списка целей.
    await waitFor(() => {
      const groups = lastMessage(view, 'targets')?.groups as { sessions: Array<{ value: string }> } | undefined;
      return groups?.sessions.length === 1 && groups.sessions[0].value === 'session:s2';
    });

    // После переключения в панели мониторинг идёт на оставшейся сессии.
    view.webview.receive({ type: 'selectTarget', target: 'session:s2' });
    await waitFor(() => extension.registry.logLines.some(line => line.includes(`--pid ${HOST_PID}`)));
  } finally {
    extension.deactivate();
  }
});
