/**
 * Сквозная проверка профилирования по требованию на реальном приложении.
 *
 * Проверяет главный сценарий из жизни: инструмент `dotnet-trace` установлен глобально,
 * и профиль должен записываться, а не приводить к сообщению «инструмент не установлен».
 *
 * Глобальные инструменты .NET — это отдельные исполняемые файлы в `<home>/.dotnet/tools`,
 * а не подкоманды `dotnet`. Раньше расширение запускало `dotnet dotnet-trace`, получало
 * «command or file was not found» и принимало это за отсутствие инструмента.
 *
 * Запускается вручную: `MONITOR_DOTNET_E2E=1 npm test`.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { resolveToolPath, TRACE_TOOL } from '../src/monitor/dotnetToolLocator.ts';
import { createVscodeStub, StubWebviewView, type VscodeStubRegistry } from './vscodeStub.ts';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');
const sampleDirectory = path.join(projectRoot, 'samples', 'SampleApp');
const sampleHost = path.join(sampleDirectory, 'bin', 'Debug', 'net10.0', 'SampleApp');

const enabled = process.env.MONITOR_DOTNET_E2E === '1';

interface LoadedExtension {
  activate: (context: unknown) => void;
  deactivate: () => void;
  registry: VscodeStubRegistry;
}

/** Собирает пример и расширение: тест проверяет именно свежий код, а не прошлую сборку. */
async function prepareBuild(): Promise<string> {
  const built = spawnSync('dotnet', ['build', path.join(sampleDirectory, 'SampleApp.csproj'), '--nologo'], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  assert.equal(built.status, 0, `сборка примера не удалась:\n${built.stdout}\n${built.stderr}`);

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

/** Запускает пример и ждёт его PID. */
async function startSample(): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(sampleHost, [], { cwd: sampleDirectory, stdio: ['ignore', 'pipe', 'pipe'] });
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
  });

  return { child, pid };
}

/**
 * Загружает расширение с подменённым модулем `vscode`.
 * В списке процессов выбираем именно запущенный пример: при совместном прогоне
 * тестов рядом работают другие приложения.
 */
function loadExtension(
  bundlePath: string,
  pid: number,
  workspaceFolder: string,
  extra: Partial<Parameters<typeof createVscodeStub>[0]> = {},
): LoadedExtension {
  const { vscode, registry } = createVscodeStub({
    language: 'en',
    workspaceFolder,
    quickPickSelector: items =>
      items.find(item => item.description === `PID ${pid}`) ?? items[0],
    ...extra,
  });
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

async function waitFor(description: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`не дождались: ${description}`);
}

test('установленный dotnet-trace находится без обращения к `dotnet`', { skip: !enabled }, () => {
  const executable = resolveToolPath(TRACE_TOOL);
  assert.ok(executable !== undefined, 'dotnet-trace не найден: установите его командой dotnet tool install --global dotnet-trace');

  // Прямой запуск работает, а прежний способ через `dotnet` — нет.
  const direct = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(direct.status, 0, `прямой запуск не удался: ${direct.stderr}`);

  const viaDotnet = spawnSync('dotnet', [TRACE_TOOL.command, '--version'], { encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(viaDotnet.status, 0, 'поведение dotnet изменилось: проверку через `dotnet` можно упростить');
});

test('запись профиля через расширение проходит без ложного «не установлен»', { skip: !enabled, timeout: 5 * 60_000 }, async () => {
  const bundlePath = await prepareBuild();
  const { child, pid } = await startSample();
  const project = mkdtempSync(path.join(os.tmpdir(), 'monitor-dotnet-project-'));
  const extension = loadExtension(bundlePath, pid, project);

  try {
    extension.activate({
      extensionPath: projectRoot,
      extensionUri: { fsPath: projectRoot },
      subscriptions: [] as unknown[],
    });

    const provider = extension.registry.webviewViews.get('monitor-dotnet.performance') as
      | { resolveWebviewView(view: StubWebviewView): void }
      | undefined;
    assert.ok(provider !== undefined);
    provider.resolveWebviewView(new StubWebviewView());

    // Подключаемся к запущенному примеру: список целей в быстром выборе отдаёт заглушка.
    await extension.registry.commandHandlers.get('monitor-dotnet.attachToProcess')?.();
    await waitFor(
      'мониторинг запущен',
      () => extension.registry.logLines.some(line => line.includes(`--pid ${pid}`)),
      60_000,
    );

    await extension.registry.commandHandlers.get('monitor-dotnet.startProfiling')?.();
    await waitFor(
      'инструмент найден',
      () => extension.registry.logLines.some(line => line.includes('found:')),
      30_000,
    );

    assert.ok(
      !extension.registry.notifications.some(text => text.includes('is not installed')),
      `показано ложное сообщение: ${extension.registry.notifications.join(' | ')}`,
    );

    await waitFor(
      'запись профиля началась',
      () => extension.registry.logLines.some(line => line.includes('Starting profiling')),
      30_000,
    );

    // Даём инструменту накопить данные, затем останавливаем запись.
    await new Promise(resolve => setTimeout(resolve, 4_000));
    await extension.registry.commandHandlers.get('monitor-dotnet.stopProfiling')?.();

    await waitFor(
      'профиль сохранён',
      () => extension.registry.notifications.some(text => text.startsWith('Profile saved')),
      90_000,
    );

    // В уведомлении показано имя файла, а лежит он в каталоге проекта.
    const saved = extension.registry.notifications.find(text => text.startsWith('Profile saved')) ?? '';
    const directory = path.join(project, '.monitor-dotnet');
    const file = path.join(directory, saved.slice(saved.indexOf(':') + 1).trim());
    assert.ok(existsSync(file), `файл профиля не создан: ${file}`);
    assert.ok(file.endsWith('.nettrace'), `неожиданное расширение профиля: ${file}`);
    assert.ok(path.basename(file).includes(`-${pid}-`), `профиль записан не для этого процесса: ${file}`);

    // Рядом должен быть готовый Speedscope-файл.
    const speedscope = file.replace(/\.nettrace$/i, '.speedscope.json');
    assert.ok(existsSync(speedscope), `нет Speedscope-файла: ${speedscope}`);

    // Каталог закрыт от git, чтобы артефакты не попали в репозиторий.
    assert.ok(existsSync(path.join(directory, '.gitignore')), 'нет .gitignore в каталоге результатов');

    // Кнопка «Open Speedscope Profile» находит последний профиль без ручного поиска.
    await extension.registry.commandHandlers.get('monitor-dotnet.openSpeedscopeProfile')?.();
    await waitFor(
      'профиль Speedscope открыт',
      () => extension.registry.logLines.some(line => line.includes('Opening Speedscope profile:')),
      15_000,
    );
    assert.ok(
      extension.registry.logLines.some(line => line.includes(speedscope)),
      'открыт не тот профиль Speedscope',
    );
  } finally {
    extension.deactivate();
    child.kill('SIGTERM');
    rmSync(project, { recursive: true, force: true });
  }
});

test('дамп памяти создаётся в каталоге проекта', { skip: !enabled, timeout: 10 * 60_000 }, async () => {
  const bundlePath = await prepareBuild();
  const { child, pid } = await startSample();
  const project = mkdtempSync(path.join(os.tmpdir(), 'monitor-dotnet-project-'));
  const extension = loadExtension(bundlePath, pid, project);

  try {
    extension.activate({
      extensionPath: projectRoot,
      extensionUri: { fsPath: projectRoot },
      subscriptions: [] as unknown[],
    });

    const provider = extension.registry.webviewViews.get('monitor-dotnet.performance') as
      | { resolveWebviewView(view: StubWebviewView): void }
      | undefined;
    assert.ok(provider !== undefined);
    provider.resolveWebviewView(new StubWebviewView());

    await extension.registry.commandHandlers.get('monitor-dotnet.attachToProcess')?.();
    await waitFor(
      'мониторинг запущен',
      () => extension.registry.logLines.some(line => line.includes(`--pid ${pid}`)),
      60_000,
    );

    const directory = path.join(project, '.monitor-dotnet');

    // Дамп памяти: dotnet-dump collect.
    await extension.registry.commandHandlers.get('monitor-dotnet.collectMemoryDump')?.();
    await waitFor(
      'дамп памяти сохранён',
      () => extension.registry.notifications.some(text => text.startsWith('Memory dump saved')),
      180_000,
    );

    const dump = extension.registry.notifications
      .find(text => text.startsWith('Memory dump saved'))?.slice('Memory dump saved: '.length);
    assert.ok(dump !== undefined && existsSync(path.join(directory, dump)), `дамп не создан: ${dump}`);
    assert.ok(dump.endsWith('.dmp'), `неожиданное расширение дампа: ${dump}`);

    // Ложного сообщения об отсутствии инструмента не было.
    assert.ok(
      !extension.registry.notifications.some(item => item.includes('is not installed')),
      `показано ложное сообщение: ${extension.registry.notifications.join(' | ')}`,
    );
  } finally {
    extension.deactivate();
    child.kill('SIGTERM');
    rmSync(project, { recursive: true, force: true });
  }
});

test('при открытии профиля предлагается просмотрщик Speedscope и ассоциация файлов', { skip: !enabled, timeout: 5 * 60_000 }, async () => {
  const bundlePath = await prepareBuild();
  const { child, pid } = await startSample();
  const project = mkdtempSync(path.join(os.tmpdir(), 'monitor-dotnet-project-'));

  // Пользователь соглашается и на установку расширения, и на ассоциацию файлов.
  const answered: string[] = [];
  const extension = loadExtension(bundlePath, pid, project, {
    notificationResponder: message => {
      if (message.includes('Speedscope viewer shows')) {
        answered.push('install');
        return 'Install';
      }

      if (message.includes('editor association')) {
        answered.push('associate');
        return 'Associate .speedscope.json files';
      }

      return undefined;
    },
  });

  try {
    extension.activate({
      extensionPath: projectRoot,
      extensionUri: { fsPath: projectRoot },
      subscriptions: [] as unknown[],
    });

    const provider = extension.registry.webviewViews.get('monitor-dotnet.performance') as
      | { resolveWebviewView(view: StubWebviewView): void }
      | undefined;
    assert.ok(provider !== undefined);
    provider.resolveWebviewView(new StubWebviewView());

    await extension.registry.commandHandlers.get('monitor-dotnet.attachToProcess')?.();
    await waitFor(
      'мониторинг запущен',
      () => extension.registry.logLines.some(line => line.includes(`--pid ${pid}`)),
      60_000,
    );

    // Записываем короткий профиль, чтобы появился файл Speedscope.
    await extension.registry.commandHandlers.get('monitor-dotnet.startProfiling')?.();
    await new Promise(resolve => setTimeout(resolve, 3_000));
    await extension.registry.commandHandlers.get('monitor-dotnet.stopProfiling')?.();
    await waitFor(
      'профиль сохранён',
      () => extension.registry.notifications.some(text => text.startsWith('Profile saved')),
      90_000,
    );

    await extension.registry.commandHandlers.get('monitor-dotnet.openSpeedscopeProfile')?.();
    await waitFor('профиль открыт', () => extension.registry.executedCommands.some(c => c.id === 'vscode.open'), 20_000);

    assert.deepEqual(answered, ['install', 'associate'], 'предложения не были показаны');

    // Второе открытие не должно повторять те же предложения в той же сессии.
    await extension.registry.commandHandlers.get('monitor-dotnet.openSpeedscopeProfile')?.();
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.deepEqual(answered, ['install', 'associate'], 'предложения повторились при повторном открытии');

    // Установка просмотрщика запрошена у VS Code.
    const install = extension.registry.executedCommands.find(c => c.id === 'workbench.extensions.installExtension');
    assert.ok(install !== undefined, 'установка просмотрщика не запрошена');
    assert.deepEqual(install.args, ['sransara.speedscope-in-vscode']);

    // Ассоциация записана в настройки рабочей области.
    const update = extension.registry.configurationUpdates.find(item => item.key === 'editorAssociations');
    assert.ok(update !== undefined, 'настройка ассоциаций не изменена');
    assert.equal(update.section, 'workbench');
    assert.deepEqual(update.value, { '*.speedscope.json': 'speedscope-in-vscode.speedscope' });
  } finally {
    extension.deactivate();
    child.kill('SIGTERM');
    rmSync(project, { recursive: true, force: true });
  }
});
