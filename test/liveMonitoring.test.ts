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

/** Запускает приложение и дожидается его PID из стандартного вывода. */
async function startSample(stress = true): Promise<{ child: ChildProcess; pid: number }> {
  const args = stress ? ['--stress'] : [];
  const child = spawn(sampleHost, args, { cwd: sampleDirectory, stdio: ['ignore', 'pipe', 'pipe'] });

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


/** Узел дерева проблем, как его видит тест. */
interface TreeNode {
  kind: string;
  entry?: {
    data: { id: string; label: string };
    processKey: string;
    processLabel: string;
    isCurrentProcess: boolean;
  };
  process?: { key: string; label: string; description: string; expanded: boolean };
}

/** Дерево проблем, как его видит тест. */
interface IssuesTree {
  getChildren(element?: TreeNode): TreeNode[];
  getTreeItem(node: TreeNode): { contextValue?: string; command?: { command: string; arguments?: unknown[] } };
}

/** Провайдер нативного дерева проблем. */
function issuesTree(extension: LoadedExtension): IssuesTree {
  const provider = extension.registry.treeProviders.get('monitor-dotnet.issues') as IssuesTree | undefined;
  assert.ok(provider !== undefined, 'провайдер дерева проблем не зарегистрирован');
  return provider;
}

/** Проблемы из дерева: и плоский список, и проблемы внутри групп процессов. */
function issueEntries(provider: IssuesTree): Array<{ node: TreeNode; entry: NonNullable<TreeNode['entry']> }> {
  const entries: Array<{ node: TreeNode; entry: NonNullable<TreeNode['entry']> }> = [];
  for (const node of provider.getChildren()) {
    if (node.entry !== undefined) {
      entries.push({ node, entry: node.entry });
      continue;
    }

    for (const child of provider.getChildren(node)) {
      if (child.entry !== undefined) {
        entries.push({ node: child, entry: child.entry });
      }
    }
  }

  return entries;
}

/** Ждёт в дереве проблем узел, удовлетворяющий условию. */
async function waitForEntry(
  provider: IssuesTree,
  description: string,
  predicate: (entry: NonNullable<TreeNode['entry']>) => boolean,
): Promise<{ node: TreeNode; entry: NonNullable<TreeNode['entry']> }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = issueEntries(provider).find(candidate => predicate(candidate.entry));
    if (found !== undefined) {
      return found;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  throw new Error(`не дождались: ${description}`);
}

/** Проверяет нативное дерево проблем и переход с него на графики. */
async function verifyIssuesTree(
  extension: LoadedExtension,
  view: StubWebviewView,
  expectedId: string,
): Promise<void> {
  const provider = issuesTree(extension);
  const found = await waitForEntry(provider, 'проблема текущего процесса в дереве', entry => entry.data.id === expectedId);
  assert.ok(found.entry.isCurrentProcess, 'проблема текущего процесса помечена как история');

  // Нажатие на узел должно отправить панели запрос на выделение того же интервала.
  const item = provider.getTreeItem(found.node);
  assert.match(String(item.contextValue), /^issue\./, 'у проблемы текущего процесса нет действия «показать на графиках»');
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

/**
 * Проверяет переключение на другой процесс: проблемы прошлого процесса остаются в дереве
 * как история, а вместе с ними и точки интервалов — иначе выделять на графиках было бы нечего.
 */
async function verifyProcessSwitch(
  extension: LoadedExtension,
  view: StubWebviewView,
  previousPid: number,
  nextPid: number,
): Promise<void> {
  view.webview.receive({ type: 'selectTarget', target: `pid:${nextPid}` });
  await waitFor(
    'переключение мониторинга на второй процесс',
    // Тексты журнала локализованы, поэтому ждём запуск моста по аргументам: они не переводятся.
    () => extension.registry.logLines.some(line => line.includes(`--pid ${nextPid}`)),
    COLLECTION_TIMEOUT_MS,
  );

  // Панель показывает данные нового процесса, поэтому список проблем у неё пуст.
  await waitFor('очистка списка проблем панели', () => {
    const snapshot = [...view.webview.messages].reverse().find(message => message.type === 'snapshot');
    const issues = snapshot?.issues as unknown[] | undefined;
    return Array.isArray(issues) && issues.length === 0;
  }, COLLECTION_TIMEOUT_MS);

  // В дереве проблема прошлого процесса осталась и лежит в группе своего процесса.
  const provider = issuesTree(extension);
  const history = await waitForEntry(provider, 'история прошлого процесса в дереве', entry => !entry.isCurrentProcess);
  assert.equal(history.entry.processKey, `pid:${previousPid}`, 'история относится не к прошлому процессу');
  assert.ok(
    history.entry.processLabel.endsWith(`(PID ${previousPid})`),
    `подпись процесса потеряла PID: «${history.entry.processLabel}», ожидался PID ${previousPid}`,
  );

  const groups = provider.getChildren().filter(node => node.kind === 'process');
  assert.equal(groups.length, 1, 'проблемы прошлого процесса не сгруппированы');
  assert.equal(groups[0].process?.expanded, false, 'группа прошлого процесса раскрыта как текущая');
  assert.ok(
    !String(groups[0].process?.description).includes('мониторится сейчас'),
    'прошлый процесс помечен как мониторимый',
  );

  // Нажатие на проблему другого процесса: на живых графиках его данных уже нет,
  // поэтому панель обязана получить сохранённые точки интервала.
  const item = provider.getTreeItem(history.node);
  assert.match(String(item.contextValue), /^issueHistory\./, 'у истории осталось действие «показать на графиках»');
  const command = item.command?.arguments?.[0] as { fromMs: number; toMs: number } | undefined;
  assert.ok(command !== undefined, 'у команды перехода нет интервала');

  const before = view.webview.messages.length;
  await extension.registry.commandHandlers.get('monitor-dotnet.selectIssueInterval')?.(item.command?.arguments?.[0]);

  const slice = [...view.webview.messages.slice(before)]
    .reverse()
    .find(message => message.type === 'issueSlice') as
    | { issue?: { id?: string }; points?: Array<{ t: number }>; gcEvents?: unknown[]; processLabel?: string; fromMs?: number; toMs?: number; viewFromMs?: number; viewToMs?: number }
    | undefined;
  assert.ok(slice !== undefined, 'панель не получила сохранённый интервал');
  assert.equal(
    view.webview.messages.slice(before).filter(message => message.type === 'selectRange').length,
    0,
    'панель попыталась выделить интервал чужого процесса на живых графиках',
  );

  const points = slice.points ?? [];
  assert.ok(points.length >= 2, `в сохранённом интервале нет точек: ${points.length}`);
  // Точки сохранены с запасом по краям, поэтому интервал проблемы должен быть покрыт целиком.
  assert.ok(
    points[0].t <= (slice.fromMs ?? 0) && points[points.length - 1].t >= (slice.toMs ?? 0),
    `точки не покрывают интервал проблемы: ${JSON.stringify(points.map(point => point.t))} при ${String(slice.fromMs)}—${String(slice.toMs)}`,
  );
  // Видимый диапазон включает интервал и целиком покрыт точками: иначе переход
  // к проблеме показал бы пустое место вместо линий.
  const viewFrom = slice.viewFromMs ?? 0;
  const viewTo = slice.viewToMs ?? 0;
  assert.ok(viewFrom <= (slice.fromMs ?? 0) && viewTo >= (slice.toMs ?? 0), 'интервал проблемы не попал в видимый диапазон');
  assert.ok(
    points[0].t <= viewFrom && points[points.length - 1].t >= viewTo,
    `видимый диапазон шире сохранённых точек: ${viewFrom}—${viewTo} при ${points[0].t}—${points[points.length - 1].t}`,
  );
  assert.equal(slice.issue?.id, history.entry.data.id, 'панели передан не тот интервал');
  assert.ok(String(slice.processLabel).includes(`PID ${previousPid}`), 'панель не знает, чей интервал показывать');
}

test(
  'живое приложение под нагрузкой: данные доходят, перегрузка CPU распознаётся',
  { skip: !enabled, timeout: 10 * 60_000 },
  async () => {
    buildSample();
    const bundlePath = await buildExtension();
    const { child, pid } = await startSample();
    // Второй экземпляр нужен для проверки переключения процесса: без нагрузки своих проблем он не даст.
    const second = await startSample(false);

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

      // Переключение на другой процесс: найденные проблемы остаются в дереве как история,
      // но с графиков уходят — там уже данные другого процесса.
      await verifyProcessSwitch(extension, view, pid, second.pid);
    } finally {
      extension?.deactivate();
      child.kill('SIGTERM');
      second.child.kill('SIGTERM');
    }
  },
);
