/**
 * Проверка активации расширения и панели графиков.
 *
 * Тест собирает расширение в CommonJS-бандл, подменяет модуль `vscode` заглушкой
 * и вызывает `activate`. Так мы ловим ошибки, которые не видны при проверке типов:
 * неправильный формат сборки, падение при активации, незарегистрированные команды и виды.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import {
  createVscodeStub,
  StubWebviewView,
  type SentMessage,
  type VscodeStubOptions,
  type VscodeStubRegistry,
} from './vscodeStub.ts';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

/** Провайдер webview-панели, как его видит наш тест. */
interface WebviewProvider {
  resolveWebviewView(view: StubWebviewView): void;
}

/** Собирает расширение во временный CommonJS-файл. */
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

/**
 * Загружает собранное расширение с подменённым модулем `vscode`.
 * Возвращает точки входа расширения и список зарегистрированных сущностей.
 */
function loadExtension(bundlePath: string, options: VscodeStubOptions = {}): {
  activate: (context: unknown) => void;
  deactivate: () => void;
  registry: VscodeStubRegistry;
} {
  const { vscode, registry } = createVscodeStub(options);
  const moduleAny = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleAny._load;

  moduleAny._load = (request: string, parent: unknown, isMain: boolean) =>
    request === 'vscode' ? vscode : originalLoad(request, parent, isMain);

  try {
    // Сбрасываем кэш: иначе расширение сохранит ссылку на заглушку из предыдущего теста.
    delete require.cache[require.resolve(bundlePath)];
    const extension = require(bundlePath) as { activate: (context: unknown) => void; deactivate: () => void };
    return { ...extension, registry };
  } finally {
    moduleAny._load = originalLoad;
  }
}

test('активация регистрирует команды, панели и индикатор состояния', async () => {
  const bundlePath = await buildExtension();
  const { activate, registry } = loadExtension(bundlePath);
  const context = { extensionPath: projectRoot, extensionUri: { fsPath: projectRoot }, subscriptions: [] as unknown[] };

  assert.doesNotThrow(() => activate(context));

  // Панели: счётчики и окружение — деревья, графики — webview.
  assert.deepEqual(registry.treeViews.sort(), [
    'monitor-dotnet.counters',
    'monitor-dotnet.environment',
    'monitor-dotnet.issues',
  ]);
  assert.ok(registry.webviewViews.has('monitor-dotnet.performance'), 'Панель графиков не зарегистрирована');

  // Ключевые команды.
  for (const command of [
    'monitor-dotnet.startMonitoring',
    'monitor-dotnet.stopMonitoring',
    'monitor-dotnet.attachToProcess',
    'monitor-dotnet.selectIssueInterval',
    'monitor-dotnet.focusPerformance',
    'monitor-dotnet.clearData',
    'monitor-dotnet.collectCallStack',
    'monitor-dotnet.collectMemorySnapshot',
    'monitor-dotnet.startProfiling',
    'monitor-dotnet.stopProfiling',
    'monitor-dotnet.openSettings',
    'monitor-dotnet.filterEnvironment',
  ]) {
    assert.ok(registry.commands.includes(command), `Не зарегистрирована команда ${command}`);
  }

  assert.equal(registry.outputChannels.length, 1);
  assert.equal(registry.statusBarItems, 1);
});

test('панель графиков отдаёт разметку с политикой безопасности и отвечает на готовность', async () => {
  const bundlePath = await buildExtension();
  const { activate, registry } = loadExtension(bundlePath);
  activate({ extensionPath: projectRoot, extensionUri: { fsPath: projectRoot }, subscriptions: [] });

  const provider = registry.webviewViews.get('monitor-dotnet.performance') as WebviewProvider | undefined;
  assert.ok(provider !== undefined);

  const view = new StubWebviewView();
  provider.resolveWebviewView(view);

  // Разметка должна разрешать только собственные скрипты и подключать бандл с nonce.
  assert.match(view.webview.html, /Content-Security-Policy/);
  assert.match(view.webview.html, /script-src 'nonce-[A-Za-z0-9]{32}'/);
  assert.match(view.webview.html, /charts\.js/);
  assert.match(view.webview.html, /charts\.css/);
  assert.match(view.webview.html, /id="charts"/);
  // Список найденных проблем: пока проблем нет — секция скрыта.
  assert.match(view.webview.html, /id="issues" hidden/);

  // Панель сообщает о готовности — расширение обязано ответить снимком данных.
  view.webview.receive({ type: 'ready' });

  const snapshot = view.webview.messages.find((message: SentMessage) => message.type === 'snapshot');
  assert.ok(snapshot !== undefined, 'Не отправлен снимок данных');
  assert.ok(Array.isArray(snapshot.points));
  assert.ok(Array.isArray(snapshot.gcEvents));
  // Список найденных проблем передаётся вместе с данными (пока пустой — данных ещё нет).
  assert.deepEqual(snapshot.issues, []);
  assert.equal(typeof snapshot.meta, 'object');
});

test('деактивация не выбрасывает исключений', async () => {
  const bundlePath = await buildExtension();
  const { activate, deactivate } = loadExtension(bundlePath);

  activate({ extensionPath: projectRoot, extensionUri: { fsPath: projectRoot }, subscriptions: [] });
  assert.doesNotThrow(() => deactivate());
});

test('при русском языке панель графиков получает русские тексты', async () => {
  // Словарь переводов тот самый, что поставляется с расширением.
  const translations = JSON.parse(
    await readFile(path.join(projectRoot, 'l10n', 'bundle.l10n.ru.json'), 'utf8'),
  ) as Record<string, string>;

  const bundlePath = await buildExtension();
  const { activate, registry } = loadExtension(bundlePath, { translations, language: 'ru' });
  activate({ extensionPath: projectRoot, extensionUri: { fsPath: projectRoot }, subscriptions: [] });

  const provider = registry.webviewViews.get('monitor-dotnet.performance') as WebviewProvider | undefined;
  assert.ok(provider !== undefined);

  const view = new StubWebviewView();
  provider.resolveWebviewView(view);

  // Разметка панели переведена.
  assert.match(view.webview.html, /Пауза/);
  assert.match(view.webview.html, /Сбросить выделение/);
  assert.match(view.webview.html, /Процесс не выбран/);

  view.webview.receive({ type: 'ready' });
  const snapshot = view.webview.messages.find((message: SentMessage) => message.type === 'snapshot');
  assert.ok(snapshot !== undefined);

  // Тексты для графиков тоже приходят переведёнными, вместе с кодом языка.
  const strings = snapshot.strings as Record<string, string>;
  assert.equal(strings.chartCpuTitle, 'Загрузка CPU');
  assert.equal(strings.buttonPause, 'Пауза');
  assert.equal(strings.summaryTitle, 'Выделенный диапазон');
  // Подписи списка найденных проблем тоже локализованы.
  assert.equal(strings.issuesTitle, 'Найденные проблемы');
  assert.equal(snapshot.locale, 'ru');
});

test('без перевода панель получает английские тексты', async () => {
  const bundlePath = await buildExtension();
  const { activate, registry } = loadExtension(bundlePath);
  activate({ extensionPath: projectRoot, extensionUri: { fsPath: projectRoot }, subscriptions: [] });

  const provider = registry.webviewViews.get('monitor-dotnet.performance') as WebviewProvider | undefined;
  assert.ok(provider !== undefined);

  const view = new StubWebviewView();
  provider.resolveWebviewView(view);
  view.webview.receive({ type: 'ready' });

  const snapshot = view.webview.messages.find((message: SentMessage) => message.type === 'snapshot');
  assert.ok(snapshot !== undefined);

  const strings = snapshot.strings as Record<string, string>;
  assert.equal(strings.chartCpuTitle, 'CPU load');
  assert.equal(snapshot.locale, 'en');
});

test('дерево проблем показывает пояснение, пока данных нет', async () => {
  const bundlePath = await buildExtension();
  const { activate, registry } = loadExtension(bundlePath);
  activate({ extensionPath: projectRoot, extensionUri: { fsPath: projectRoot }, subscriptions: [] as unknown[] });

  const provider = registry.treeProviders.get('monitor-dotnet.issues') as
    | { getChildren(): unknown[]; getTreeItem(node: unknown): unknown }
    | undefined;
  assert.ok(provider !== undefined, 'провайдер дерева проблем не зарегистрирован');

  const nodes = provider.getChildren() as Array<{ kind: string; label: string; hint: string }>;
  assert.equal(nodes.length, 1, 'пока данных нет, должна быть одна строка-пояснение');
  assert.equal(nodes[0].kind, 'empty');
  assert.equal(nodes[0].label, 'No issues detected yet');
  assert.ok(nodes[0].hint.length > 0, 'у пояснения нет текста');
});

test('при выключенном поиске дерево проблем объясняет причину', async () => {
  const bundlePath = await buildExtension();
  const { activate, registry } = loadExtension(bundlePath, { configuration: { enableIssueDetection: false } });
  activate({ extensionPath: projectRoot, extensionUri: { fsPath: projectRoot }, subscriptions: [] as unknown[] });

  const provider = registry.treeProviders.get('monitor-dotnet.issues') as
    | { getChildren(): unknown[] }
    | undefined;
  assert.ok(provider !== undefined);

  const nodes = provider.getChildren() as Array<{ kind: string; label: string }>;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].label, 'Issue detection is off');
});
