/**
 * Сквозная проверка запуска мониторинга из сессии отладки.
 *
 * Тест поднимает настоящие приложения так же, как это делает отладчик, эмулирует события
 * сессий отладки VS Code (типы `coreclr`, `dotnet` и `aspire`) и проверяет, что расширение
 * подключается именно к процессу приложения:
 *
 *  - ASP.NET Core через apphost — так запускает отладчик `coreclr`;
 *  - проект C# Dev Kit (`type: dotnet`, в конфигурации только `projectPath`);
 *  - Aspire: отлаживается проект AppHost, который запускает Aspire CLI.
 *
 * Проверка тяжёлая (сборка примеров, запуск Aspire с дашбордом), включается вручную:
 * `MONITOR_DOTNET_E2E=1 npm test`.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createVscodeStub, StubWebviewView, type VscodeStubOptions, type VscodeStubRegistry } from './vscodeStub.ts';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');
const samplesRoot = path.join(projectRoot, 'samples');
const webApiDirectory = path.join(samplesRoot, 'WebApi');
const webApiHost = path.join(webApiDirectory, 'bin', 'Debug', 'net10.0', 'WebApi');
const aspireDirectory = path.join(samplesRoot, 'AspireApp');
const aspireHost = path.join(aspireDirectory, 'AspireApp.AppHost', 'bin', 'Debug', 'net10.0', 'AspireApp.AppHost');
const aspireCli = path.join(process.env.HOME ?? '', '.dotnet', 'tools', 'aspire');

const enabled = process.env.MONITOR_DOTNET_E2E === '1';
/** Aspire поднимает дашборд и сервисы не сразу, поэтому запас по времени большой. */
const START_TIMEOUT_MS = 120_000;
/** Сколько ждать, пока расширение определит процесс и запустит мост. */
const MONITORING_TIMEOUT_MS = 60_000;

interface LoadedExtension {
  activate: (context: unknown) => void;
  deactivate: () => void;
  registry: VscodeStubRegistry;
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

/** Собирает пример, чтобы получить готовый apphost. */
function buildSample(project: string): void {
  const result = spawnSync('dotnet', ['build', project, '--nologo'], { encoding: 'utf8', timeout: 300_000 });
  assert.equal(result.status, 0, `сборка примера не удалась:\n${result.stdout}\n${result.stderr}`);
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

/** PID процессов, чей исполняемый файл совпадает с ожидаемым. */
async function findProcesses(executablePath: string): Promise<number[]> {
  const result: number[] = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue;
    }

    try {
      if ((await readlink(`/proc/${entry}/exe`)) === executablePath) {
        result.push(Number(entry));
      }
    } catch {
      // Процесс завершился или недоступен — для обхода /proc это нормально.
    }
  }

  return result;
}

/** Запускает приложение напрямую (как отладчик) и возвращает PID нового процесса. */
async function startApplication(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ child: ChildProcess; pid: number }> {
  const before = new Set(await findProcesses(executable));
  const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });

  let pid = 0;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && pid === 0) {
    pid = (await findProcesses(executable)).find(value => !before.has(value)) ?? 0;
    if (pid === 0) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  assert.notEqual(pid, 0, `процесс ${executable} не появился`);
  return { child, pid };
}

/** Общая установка: собранное расширение, русские тексты и созданная панель графиков. */
async function prepare(options: VscodeStubOptions = {}): Promise<LoadedExtension> {
  const bundlePath = await buildExtension();
  // Проверки читают строки журнала, поэтому интерфейс английский: русские тексты
  // проверяются отдельными тестами локализации.
  const extension = loadExtension(bundlePath, { language: 'en', ...options });
  extension.activate({
    extensionPath: projectRoot,
    extensionUri: { fsPath: projectRoot },
    subscriptions: [] as unknown[],
  });

  // Панель графиков создаётся на старте: без неё расширение не подключает вид.
  const provider = extension.registry.webviewViews.get('monitor-dotnet.performance') as
    | { resolveWebviewView(view: StubWebviewView): void }
    | undefined;
  provider?.resolveWebviewView(new StubWebviewView());

  return extension;
}

/** PID, к которым расширение подключило мониторинг: берём их из строк журнала. */
function monitoredPids(extension: LoadedExtension): number[] {
  return extension.registry.logLines
    .map(line => /Debuggee process found: PID (\d+)/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map(match => Number(match[1]));
}

/** Проверяет, что расширение подключилось именно к этому процессу. */
async function expectMonitoring(extension: LoadedExtension, pid: number): Promise<void> {
  await waitFor(
    `определение процесса ${pid}`,
    () => monitoredPids(extension).includes(pid),
    MONITORING_TIMEOUT_MS,
  );

  await waitFor(
    `запуск моста для процесса ${pid}`,
    () => extension.registry.logLines.some(line =>
      line.includes('Starting the bridge:') && line.includes(`--pid ${pid}`)),
    30_000,
  );
}

/** Ждёт, пока панель получит список целей: он приходит после запроса снимка. */
async function targetsInPanel(view: StubWebviewView): Promise<void> {
  await waitFor(
    'список целей в панели',
    () => view.webview.messages.some(message => message.type === 'targets'),
    30_000,
  );
}

/** Сессии из последнего сообщения панели о целях. */
function listedSessions(view: StubWebviewView): Array<{ value: string; pid?: number; isCurrent: boolean }> {
  const message = [...view.webview.messages].reverse().find(item => item.type === 'targets');
  const groups = message?.groups as { sessions?: Array<{ value: string; pid?: number; isCurrent: boolean }> } | undefined;
  return groups?.sessions ?? [];
}

test('переключение между процессами связки: две сессии, выбор второй (регрессия)', { skip: !enabled, timeout: 15 * 60_000 }, async () => {
  buildSample(path.join(webApiDirectory, 'WebApi.csproj'));
  buildSample(path.join(samplesRoot, 'SampleApp', 'SampleApp.csproj'));

  // Две программы запущены одновременно — так выглядит запуск связки проектов.
  const api = await startApplication(webApiHost, ['--urls', 'http://127.0.0.1:5083'], webApiDirectory);
  const sample = await startApplication(
    path.join(samplesRoot, 'SampleApp', 'bin', 'Debug', 'net10.0', 'SampleApp'),
    ['--exit-after', '600'],
    path.join(samplesRoot, 'SampleApp'),
  );

  const extension = await prepare();
  try {
    const sessions = extension.registry.debugSessions;
    sessions.start({
      id: 'session-api',
      name: 'Отладка WebApi',
      type: 'coreclr',
      configuration: {
        type: 'coreclr',
        request: 'launch',
        program: path.join(webApiDirectory, 'bin', 'Debug', 'net10.0', 'WebApi.dll'),
        cwd: webApiDirectory,
      },
      workspaceFolder: { uri: { fsPath: webApiDirectory } },
    });

    await expectMonitoring(extension, api.pid);
    sessions.start({
      id: 'session-sample',
      name: 'Отладка SampleApp',
      type: 'coreclr',
      configuration: {
        type: 'coreclr',
        request: 'launch',
        program: path.join(samplesRoot, 'SampleApp', 'bin', 'Debug', 'net10.0', 'SampleApp.dll'),
        cwd: path.join(samplesRoot, 'SampleApp'),
      },
      workspaceFolder: { uri: { fsPath: path.join(samplesRoot, 'SampleApp') } },
    });

    // Вторая сессия не должна перехватывать мониторинг сама.
    await waitFor(
      'вторая сессия осталась без мониторинга',
      () => !monitoredPids(extension).includes(sample.pid),
      10_000,
    );

    const panel = extension.registry.webviewViews.get('monitor-dotnet.performance') as
      | { resolveWebviewView(view: StubWebviewView): void }
      | undefined;
    assert.ok(panel !== undefined);
    const view = new StubWebviewView();
    panel.resolveWebviewView(view);
    view.webview.receive({ type: 'ready' });

    await targetsInPanel(view);

    await waitFor(
      'процесс второй сессии найден',
      () => listedSessions(view).some(entry => entry.value === 'session:session-sample' && entry.pid === sample.pid),
      60_000,
    );

    const apiEntry = listedSessions(view).find(entry => entry.value === 'session:session-api');
    assert.equal(apiEntry?.pid, api.pid, 'в списке целей нет процесса первой сессии');
    assert.equal(apiEntry?.isCurrent, true, 'текущая цель не отмечена в списке');

    // Выбираем вторую цель так, как это делает выпадающий список панели.
    view.webview.receive({ type: 'selectTarget', target: 'session:session-sample' });

    await waitFor(
      'мониторинг переключился на второй процесс',
      () => extension.registry.logLines.some(line =>
        line.includes('Starting the bridge:') && line.includes(`--pid ${sample.pid}`)),
      30_000,
    );

    await waitFor(
      'отметка текущей цели переехала',
      () => listedSessions(view).find(entry => entry.value === 'session:session-sample')?.isCurrent === true,
      30_000,
    );
  } finally {
    extension.deactivate();
    api.child.kill('SIGTERM');
    sample.child.kill('SIGTERM');
  }
});

test('ASP.NET Core: сессия coreclr подключается к процессу приложения', { skip: !enabled, timeout: 15 * 60_000 }, async () => {
  buildSample(path.join(webApiDirectory, 'WebApi.csproj'));
  const { child, pid } = await startApplication(webApiHost, ['--urls', 'http://127.0.0.1:5081'], webApiDirectory);
  const extension = await prepare();

  try {
    // Так выглядит конфигурация запуска, когда отладчик указывает сборку приложения.
    extension.registry.debugSessions.start({
      id: 'session-coreclr',
      name: 'Отладка WebApi',
      type: 'coreclr',
      configuration: {
        type: 'coreclr',
        request: 'launch',
        program: path.join(webApiDirectory, 'bin', 'Debug', 'net10.0', 'WebApi.dll'),
        cwd: webApiDirectory,
      },
      workspaceFolder: { uri: { fsPath: webApiDirectory } },
    });

    await expectMonitoring(extension, pid);
    assert.deepEqual(monitoredPids(extension), [pid], 'мониторинг подключился не только к процессу приложения');
  } finally {
    extension.deactivate();
    child.kill('SIGTERM');
  }
});

test('C# Dev Kit: сессия dotnet находит приложение по projectPath', { skip: !enabled, timeout: 15 * 60_000 }, async () => {
  buildSample(path.join(webApiDirectory, 'WebApi.csproj'));
  const { child, pid } = await startApplication(webApiHost, ['--urls', 'http://127.0.0.1:5082'], webApiDirectory);
  const extension = await prepare();

  try {
    // Динамическая конфигурация C# Dev Kit: сборка не указана, задан только проект.
    extension.registry.debugSessions.start({
      id: 'session-dotnet',
      name: 'C#: WebApi',
      type: 'dotnet',
      configuration: { type: 'dotnet', request: 'launch', projectPath: path.join(webApiDirectory, 'WebApi.csproj') },
      workspaceFolder: { uri: { fsPath: webApiDirectory } },
    });

    await expectMonitoring(extension, pid);
  } finally {
    extension.deactivate();
    child.kill('SIGTERM');
  }
});

test('Aspire: сессия aspire подключается к процессу AppHost (регрессия)', { skip: !enabled, timeout: 15 * 60_000 }, async () => {
  buildSample(path.join(aspireDirectory, 'AspireApp.AppHost', 'AspireApp.AppHost.csproj'));

  // Проект AppHost запускает Aspire CLI — так же, как расширение Aspire при отладке.
  const before = new Set(await findProcesses(aspireHost));
  const cli = spawn(aspireCli, ['run', '--non-interactive', '--isolated', '--nologo'], {
    cwd: aspireDirectory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let appHostPid = 0;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && appHostPid === 0) {
    appHostPid = (await findProcesses(aspireHost)).find(value => !before.has(value)) ?? 0;
    if (appHostPid === 0) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }

  assert.notEqual(appHostPid, 0, 'процесс AppHost не появился');
  const extension = await prepare();

  try {
    // Расширение Aspire передаёт каталог проекта AppHost, а не сборку.
    extension.registry.debugSessions.start({
      id: 'session-aspire',
      name: 'Aspire: AspireApp.AppHost',
      type: 'aspire',
      configuration: { type: 'aspire', request: 'launch', program: path.join(aspireDirectory, 'AspireApp.AppHost') },
      workspaceFolder: { uri: { fsPath: aspireDirectory } },
    });

    await expectMonitoring(extension, appHostPid);
    // Раньше здесь выбирался запущенный хостом сервис: проверяем, что этого не происходит.
    assert.deepEqual(
      monitoredPids(extension),
      [appHostPid],
      `выбрана не цель отладки, а другой процесс: ${monitoredPids(extension).join(', ')}`,
    );
  } finally {
    extension.deactivate();
    cli.kill('SIGTERM');
  }
});
