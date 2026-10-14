/**
 * Сквозная проверка на реальном приложении.
 *
 * Тест поднимает демонстрационное приложение в режиме нагрузки (`--stress`), запускает собранное
 * расширение с заглушкой VS Code, подключается к процессу через мост и проверяет, что до панели
 * графиков доходят живые точки, а автопоиск проблем отмечает перегрузку CPU.
 *
 * Проверка тяжёлая (сборка примера, ожидание данных), поэтому включается вручную:
 * `MONITOR_DOTNET_E2E=1 npm test`. Без переменной тест пропускается.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { createVscodeStub, StubWebviewView, type SentMessage, type VscodeStubOptions } from './vscodeStub.ts';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');
const sampleDirectory = path.join(projectRoot, 'samples', 'SampleApp');
const sampleHost = path.join(sampleDirectory, 'bin', 'Debug', 'net10.0', 'SampleApp');

const enabled = process.env.MONITOR_DOTNET_E2E === '1';
/** Сколько миллисекунд ждать данные: автопоиск опирается на серию точек подряд. */
const COLLECTION_TIMEOUT_MS = Number(process.env.MONITOR_DOTNET_E2E_TIMEOUT ?? 60_000);

interface LoadedExtension {
  activate: (context: unknown) => void;
  deactivate: () => void;
  registry: ReturnType<typeof createVscodeStub>['registry'];
}

/** Собирает расширение в CommonJS-бандл (как при обычной сборке). */
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

/** Собирает демонстрационное приложение, чтобы получить готовый apphost. */
function buildSample(): void {
  const result = spawnSync('dotnet', ['build', sampleDirectory, '-c', 'Debug', '--nologo'], {
    encoding: 'utf8',
    timeout: 300_000,
  });

  assert.equal(result.status, 0, `сборка примера не удалась:\n${result.stdout}\n${result.stderr}`);
}

/** Запускает приложение в режиме нагрузки и дожидается его PID из стандартного вывода. */
async function startSample(): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(sampleHost, ['--stress'], { cwd: sampleDirectory, stdio: ['ignore', 'pipe', 'pipe'] });

  const pid = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('приложение не сообщило PID за 20 с')), 20_000);
    let buffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const match = /PID:(\d+)/.exec(buffer);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });

    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`приложение завершилось раньше времени, код ${String(code)}`));
    });
  });

  return { child, pid };
}

/** Загружает расширение с подменённым модулем `vscode`. */
function loadExtension(bundlePath: string, options: VscodeStubOptions): LoadedExtension {
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
    const extension = require(bundlePath) as LoadedExtension;
    return { ...extension, registry };
  } finally {
    moduleAny._load = originalLoad;
  }
}

/** Ждёт выполнения условия или сообщает, чего не дождались. */
async function waitFor(description: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  throw new Error(`не дождались: ${description}`);
}

/** Точки и проблемы из сообщений панели: снимок и накопленные приращения. */
function dataFrom(messages: readonly SentMessage[]): {
  points: Record<string, number>[];
  issues: Record<string, unknown>[];
} {
  const points: Record<string, number>[] = [];
  let issues: Record<string, unknown>[] = [];

  for (const message of messages) {
    if (message.type === 'snapshot' && Array.isArray(message.points)) {
      points.length = 0;
      points.push(...(message.points as Record<string, number>[]));
    }

    if (message.type === 'append' && Array.isArray(message.points)) {
      points.push(...(message.points as Record<string, number>[]));
    }

    if (Array.isArray(message.issues)) {
      issues = message.issues as Record<string, unknown>[];
    }
  }

  return { points, issues };
}


/** Проверяет нативное дерево проблем и переход с него на графики. */
async function verifyIssuesTree(
  extension: LoadedExtension,
  view: StubWebviewView,
  expectedId: string,
): Promise<void> {
  const provider = extension.registry.treeProviders.get('monitor-dotnet.issues') as
    | { getChildren(): unknown[]; getTreeItem(node: unknown): { command?: { command: string; arguments?: unknown[] } } }
    | undefined;
  assert.ok(provider !== undefined, 'провайдер дерева проблем не зарегистрирован');

  // Дерево пересчитывается по таймеру и по изменению состояния: даём ему минуту на уверенный результат.
  const deadline = Date.now() + 60_000;
  let nodes: Array<{ kind: string; data?: { id: string } }> = [];
  while (Date.now() < deadline) {
    nodes = provider.getChildren() as Array<{ kind: string; data?: { id: string } }>;
    if (nodes.some(node => node.kind === 'issue')) {
      break;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  const issueNode = nodes.find(node => node.kind === 'issue');
  assert.ok(issueNode !== undefined, 'в дереве проблем нет ни одного узла с проблемой');
  assert.equal(issueNode.data?.id, expectedId, 'дерево показывает другую проблему');

  // Нажатие на узел должно отправить панели запрос на выделение того же интервала.
  const item = provider.getTreeItem(issueNode);
  assert.equal(item.command?.command, 'monitor-dotnet.selectIssueInterval');
  const range = item.command?.arguments?.[0] as { fromMs: number; toMs: number } | undefined;
  assert.ok(range !== undefined, 'у команды перехода нет интервала');

  const before = view.webview.messages.length;
  await extension.registry.commandHandlers.get('monitor-dotnet.selectIssueInterval')?.(range);

  const selection = view.webview.messages
    .slice(before)
    .find(message => message.type === 'selectRange') as { fromMs: number; toMs: number } | undefined;
  assert.ok(selection !== undefined, 'панель не получила запрос на выделение интервала');
  assert.deepEqual(
    { fromMs: selection.fromMs, toMs: selection.toMs },
    { fromMs: range.fromMs, toMs: range.toMs },
    'панель получила другой интервал',
  );
}

test(
  'живое приложение под нагрузкой: данные доходят, перегрузка CPU распознаётся',
  { skip: !enabled, timeout: 10 * 60_000 },
  async () => {
    buildSample();
    const bundlePath = await buildExtension();
    const { child, pid } = await startSample();

    let extension: LoadedExtension | undefined;

    try {
      // Русский словарь берём из поставки: так проверяется и локализация найденных проблем.
      const translations = JSON.parse(
        await readFile(path.join(projectRoot, 'l10n', 'bundle.l10n.ru.json'), 'utf8'),
      ) as Record<string, string>;

      // Подключаемся именно к запущенному процессу: в списке целей есть и служебные процессы.
      extension = loadExtension(bundlePath, {
        language: 'ru',
        translations,
        quickPickSelector: items => items.find(item => item.description === `PID ${pid}`) ?? items[0],
      });

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
      view.webview.receive({ type: 'ready' });

      await extension.registry.commandHandlers.get('monitor-dotnet.startMonitoring')?.();

      const received = (): ReturnType<typeof dataFrom> => dataFrom(view.webview.messages);

      await waitFor(
        'первые точки на графиках',
        () => received().points.length >= 3,
        COLLECTION_TIMEOUT_MS,
      );

      // Нагрузочный режим занимает все ядра, поэтому правило перегрузки CPU обязано сработать.
      await waitFor(
        'проблема перегрузки CPU',
        () => received().issues.some(issue => issue.kind === 'cpu-saturation'),
        COLLECTION_TIMEOUT_MS,
      );

      const { points, issues } = received();
      const cpuPeak = Math.max(...points.map(point => point.cpu));
      assert.ok(cpuPeak >= 90, `загрузка CPU не достигла порога: пик ${cpuPeak.toFixed(1)} %`);
      assert.ok(
        points.every(point => Number.isFinite(point.priv) && point.priv > 0),
        'приватная память не собирается',
      );

      const saturation = issues.find(issue => issue.kind === 'cpu-saturation');
      assert.ok(saturation !== undefined, 'проблема перегрузки CPU не появилась');
      assert.equal(saturation.chart, 'cpu', 'проблема отнесена не к тому графику');
      assert.equal(saturation.severity, 'warning', 'перегрузка CPU должна быть предупреждением');
      assert.ok(String(saturation.title ?? '').length > 0, 'у проблемы нет заголовка');
      assert.ok(
        Number(saturation.toMs) > Number(saturation.fromMs),
        'интервал проблемы пустой',
      );

      // Тексты панели локализованы, поэтому заголовок проблемы должен быть на русском.
      assert.equal(saturation.title, 'Процессор загружен полностью', 'заголовок проблемы не локализован');

      await verifyIssuesTree(extension, view, String(saturation.id));
    } finally {
      extension?.deactivate();
      child.kill('SIGTERM');
    }
  },
);
