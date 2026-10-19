/**
 * Получение данных диагностики по требованию: стек вызовов, снимки памяти,
 * дампы, запись счётчиков и профилирование.
 * Используются официальные средства .NET: `dotnet-stack`, `dotnet-gcdump`, `dotnet-dump`,
 * `dotnet-counters`, `dotnet-trace` и `dotnet-symbol`.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { translate } from '../core/locale.ts';
import { describeError } from '../core/errors.ts';
import {
  CALL_STACK_TOOL,
  DUMP_TOOL,
  MEMORY_SNAPSHOT_TOOL,
  SYMBOL_TOOL,
  TRACE_TOOL,
  resolveToolPath,
  type DotnetTool,
} from './dotnetToolLocator.ts';
import {
  hasSpeedscopeAssociation,
  SPEEDSCOPE_FILE_PATTERN,
  SPEEDSCOPE_VIEWER_EXTENSION,
  withSpeedscopeAssociation,
} from './editorAssociations.ts';
import { listResultFiles, prepareOutputDirectory } from './outputDirectory.ts';
import { speedscopeFileFor } from './toolArguments.ts';
import type { Logger } from '../logger.ts';

const execFileAsync = promisify(execFile);

/** Обёртка над внешними инструментами диагностики. */
export class ProfilingTools {
  private traceProcess: ChildProcess | undefined;

  /**
   * Предложения про просмотрщик показываем один раз за сессию:
   * иначе они повторялись бы при каждом открытии профиля.
   */
  private speedscopeSetupOffered = false;

  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Признак активной записи профиля. */
  get isProfiling(): boolean {
    return this.traceProcess !== undefined;
  }

  /**
   * Собирает стек вызовов и показывает его в редакторе.
   * Полезно при зависаниях интерфейса и подозрениях на блокировки.
   */
  async collectCallStack(pid: number, dotnetPath: string): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: collecting the call stack…') },
      async () => {
        const output = await this.runTool(CALL_STACK_TOOL, dotnetPath, ['report', '-p', pid.toString()]);
        if (output === undefined) {
          return;
        }

        const document = await vscode.workspace.openTextDocument({ content: output, language: 'plaintext' });
        await vscode.window.showTextDocument(document, { preview: false });
      },
    );
  }

  /** Снимает дамп памяти (GCDump) и предлагает открыть каталог с файлом. */
  async collectMemorySnapshot(pid: number, dotnetPath: string, outputDirectory: string): Promise<void> {
    const target = path.join(await this.resolveOutputDirectory(outputDirectory), `memory-${pid}-${timestamp()}.gcdump`);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: taking a memory snapshot…') },
      async () => {
        const output = await this.runTool(MEMORY_SNAPSHOT_TOOL, dotnetPath, ['collect', '-p', pid.toString(), '-o', target]);
        if (output === undefined) {
          return;
        }

        this.logger.info(translate('Memory snapshot saved: {0}', target));
        const reveal = translate('Reveal in Explorer');
        const action = await vscode.window.showInformationMessage(
          translate('Memory snapshot saved: {0}', path.basename(target)),
          reveal,
        );
        if (action) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
        }
      },
    );
  }

  /**
   * Открывает последний записанный профиль в формате Speedscope.
   * Кнопка нужна, чтобы не искать файл вручную: `dotnet-trace` кладёт `.speedscope.json`
   * рядом с трассировкой, и открыть его можно в любой момент после записи.
   */
  async openSpeedscopeProfile(outputDirectory: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    const profiles = await listResultFiles(directory, '.speedscope.json');

    if (profiles.length === 0) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: no Speedscope profile found in {0}. Run performance profiling first.',
        directory,
      ));
      return;
    }

    // Обычно нужен последний профиль, но выбор остаётся за пользователем.
    const picked = profiles.length === 1
      ? profiles[0]
      : await vscode.window.showQuickPick(
        profiles.map(profile => ({ label: path.basename(profile), profile })),
        { title: translate('Open Speedscope profile'), placeHolder: translate('Newest profiles first') },
      ).then(item => item?.profile);

    if (picked === undefined) {
      return;
    }

    // Перед открытием предлагаем просмотрщик: без него файл откроется как обычный JSON.
    await this.ensureSpeedscopeViewer();

    this.logger.info(translate('Opening Speedscope profile: {0}', picked));
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(picked));
  }

  /**
   * Предлагает установить просмотрщик Speedscope и связать с ним файлы профилей.
   * Оба шага необязательные: если пользователь откажется, профиль откроется как JSON.
   */
  private async ensureSpeedscopeViewer(): Promise<void> {
    if (this.speedscopeSetupOffered) {
      return;
    }

    this.speedscopeSetupOffered = true;
    const installed = vscode.extensions.getExtension(SPEEDSCOPE_VIEWER_EXTENSION) !== undefined;
    if (!installed) {
      const install = translate('Install');
      const action = await vscode.window.showInformationMessage(
        translate(
          'Monitor Dotnet: the Speedscope viewer shows .speedscope.json profiles inside VS Code. Install the extension?',
        ),
        install,
      );

      if (action === install) {
        this.logger.info(translate('Installing the Speedscope viewer: {0}', SPEEDSCOPE_VIEWER_EXTENSION));
        await vscode.commands.executeCommand('workbench.extensions.installExtension', SPEEDSCOPE_VIEWER_EXTENSION);
      }
    }

    await this.ensureSpeedscopeAssociation();
  }

  /** Записывает ассоциацию `*.speedscope.json` в настройки рабочей области. */
  private async ensureSpeedscopeAssociation(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('workbench');
    const current = configuration.get<unknown>('editorAssociations');
    if (hasSpeedscopeAssociation(current)) {
      return;
    }

    const associate = translate('Associate .speedscope.json files');
    const action = await vscode.window.showInformationMessage(
      translate(
        'Monitor Dotnet: open .speedscope.json profiles with the Speedscope viewer by default? This adds an editor association to the workspace settings.',
      ),
      associate,
    );

    if (action !== associate) {
      return;
    }

    try {
      await configuration.update('editorAssociations', withSpeedscopeAssociation(current));
      this.logger.info(translate('Editor association added for {0}.', SPEEDSCOPE_FILE_PATTERN));
    } catch (error) {
      // Настройку могли запретить политикой — тогда подсказываем, что вписать вручную.
      this.logger.warn(translate('Could not update editor associations: {0}', describeError(error)));
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: could not update the settings. Add "workbench.editorAssociations": { "*.speedscope.json": "speedscope-in-vscode.speedscope" } to your settings.json.',
      ));
    }
  }

  /**
   * Снимает полный дамп памяти через `dotnet-dump`.
   * Дамп нужен, когда приложение зависло или падает: его можно открыть в `dotnet-dump analyze`
   * и посмотреть стеки, объекты и исключения.
   */
  async collectMemoryDump(pid: number, dotnetPath: string, outputDirectory: string): Promise<void> {
    const target = path.join(await this.resolveOutputDirectory(outputDirectory), `dump-${pid}-${timestamp()}.dmp`);

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: taking a memory dump…') },
      async () => {
        // Тип Heap: меньше полного дампа, но содержит стеки и управляемую память.
        const output = await this.runTool(DUMP_TOOL, dotnetPath, [
          'collect',
          '-p', pid.toString(),
          '-o', target,
          '--type', 'Heap',
        ]);
        if (output === undefined) {
          return;
        }

        this.logger.info(translate('Memory dump saved: {0}', target));
        await this.reportSavedFile(target, 'Memory dump saved: {0}');
      },
    );
  }

  /**
   * Скачивает символы к дампу через `dotnet-symbol`.
   * Без символов в дампе не видно имён функций, поэтому это обычный следующий шаг.
   */
  async downloadSymbols(dotnetPath: string, outputDirectory: string, dumpFile?: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    if (this.dumpFilesIn(directory).length === 0 && dumpFile === undefined) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: no memory dump found in {0}. Take a memory dump first.',
        directory,
      ));
      return;
    }

    const files = dumpFile !== undefined ? [dumpFile] : this.dumpFilesIn(directory);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: downloading symbols…') },
      async () => {
        for (const file of files) {
          // `-o` складывает символы рядом с дампом, не засоряя каталог проекта.
          const output = await this.runTool(SYMBOL_TOOL, dotnetPath, ['--symbols', '--modules', '-o', path.dirname(file), file]);
          if (output === undefined) {
            return;
          }
        }

        this.logger.info(translate('Symbols downloaded for {0} file(s).', files.length));
        void vscode.window.showInformationMessage(
          translate('Monitor Dotnet: symbols downloaded for {0} dump(s).', files.length),
        );
      },
    );
  }

  /** Дампы памяти в каталоге результатов: по ним ищутся файлы для скачивания символов. */
  private dumpFilesIn(directory: string): string[] {
    try {
      return readdirSync(directory)
        .filter(name => name.endsWith('.dmp'))
        .map(name => path.join(directory, name));
    } catch {
      return [];
    }
  }

  /** Сообщает о сохранённом файле и предлагает показать его в проводнике. */
  private async reportSavedFile(target: string, template: string): Promise<void> {
    const reveal = translate('Reveal in Explorer');
    const action = await vscode.window.showInformationMessage(translate(template, path.basename(target)), reveal);
    if (action === reveal) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
    }
  }

  /**
   * Запускает запись профиля производительности.
   * Запись идёт до команды остановки — процесс `dotnet-trace` остаётся запущенным.
   */
  async startProfiling(pid: number, dotnetPath: string, outputDirectory: string): Promise<string | undefined> {
    if (this.traceProcess !== undefined) {
      void vscode.window.showWarningMessage(translate('Monitor Dotnet: profiling is already running.'));
      return undefined;
    }

    const target = path.join(await this.resolveOutputDirectory(outputDirectory), `trace-${pid}-${timestamp()}.nettrace`);
    const available = await this.runTool(TRACE_TOOL, dotnetPath, ['--version']);
    if (available === undefined) {
      return undefined;
    }

    const executable = await this.locateTool(TRACE_TOOL, dotnetPath);
    if (executable === undefined) {
      return undefined;
    }

    this.logger.info(translate('Starting profiling: dotnet-trace collect -p {0} -o {1}', pid, target));
    const child = spawn(executable, [
      'collect',
      '-p', pid.toString(),
      '-o', target,
      // Формат speedscope открывается в браузере и в VS Code без дополнительных инструментов.
      '--format', 'Speedscope',
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    this.traceProcess = child;
    child.stdout?.on('data', data => this.logger.raw(String(data).trimEnd()));
    child.stderr?.on('data', data => this.logger.raw(String(data).trimEnd()));
    child.on('exit', code => {
      this.traceProcess = undefined;
      // `--format Speedscope` кладёт рядом готовый для speedscope.app файл.
      const speedscope = speedscopeFileFor(target);
      this.logger.info(translate(
        'Profiling finished (code {0}). Trace: {1}. Speedscope: {2}',
        code ?? 'n/a',
        target,
        speedscope,
      ));

      const open = translate('Open Speedscope profile');
      const reveal = translate('Reveal in Explorer');
      void vscode.window.showInformationMessage(
        translate('Profile saved: {0}', path.basename(target)),
        open,
        reveal,
      ).then(async action => {
        if (action === open) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(speedscope));
        } else if (action === reveal) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
        }
      });
    });

    return target;
  }

  /** Останавливает запись профиля. */
  async stopProfiling(): Promise<void> {
    const child = this.traceProcess;
    if (child === undefined) {
      return;
    }

    this.logger.info(translate('Stopping profiling…'));
    child.kill('SIGINT');

    // Даём инструменту время записать файл, затем завершаем принудительно.
    const finished = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const timer = new Promise<void>(resolve => setTimeout(resolve, 5000));
    await Promise.race([finished, timer]);

    if (this.traceProcess !== undefined) {
      this.traceProcess.kill('SIGKILL');
    }
  }

  /**
   * Запускает внешний инструмент и возвращает его вывод.
   * Если инструмент не установлен, предлагает установить его одной командой.
   */
  private async runTool(
    tool: DotnetTool,
    dotnetPath: string,
    args: readonly string[],
  ): Promise<string | undefined> {
    const executable = await this.locateTool(tool, dotnetPath);
    if (executable === undefined) {
      return undefined;
    }

    try {
      // Глобальные инструменты — отдельные исполняемые файлы, а не подкоманды `dotnet`.
      const { stdout, stderr } = await execFileAsync(executable, args, { maxBuffer: 32 * 1024 * 1024 });
      return [stdout, stderr].filter(part => part.trim().length > 0).join('\n');
    } catch (error) {
      const text = describeError(error);
      this.logger.error(translate('Tool {0} failed', tool.command), error);
      void vscode.window.showErrorMessage(translate('Monitor Dotnet: {0} failed — {1}', tool.purpose, text));
      return undefined;
    }
  }

  /**
   * Ищет исполняемый файл инструмента и предлагает установку, если его нет.
   * Путь ищется в PATH и в каталоге глобальных инструментов: расширение VS Code
   * не наследует PATH терминала, поэтому полагаться только на него нельзя.
   */
  private async locateTool(tool: DotnetTool, dotnetPath: string): Promise<string | undefined> {
    const executable = resolveToolPath(tool);
    if (executable !== undefined) {
      this.logger.info(translate('Tool {0} found: {1}', tool.command, executable));
      return executable;
    }

    this.logger.warn(translate(
      'Tool {0} was not found in PATH or in the dotnet tools directory.',
      tool.command,
    ));
    await this.suggestInstall(tool, dotnetPath);
    return undefined;
  }

  /** Предлагает установить отсутствующий инструмент. */
  private async suggestInstall(tool: DotnetTool, dotnetPath: string): Promise<void> {
    const install = translate('Install');
    const learnMore = translate('Learn more');
    const action = await vscode.window.showWarningMessage(
      translate('Monitor Dotnet: tool {0} is not installed (needed for {1}).', tool.command, tool.purpose),
      install,
      learnMore,
    );

    if (action === install) {
      const terminal = vscode.window.createTerminal(translate('Monitor Dotnet: installing {0}', tool.command));
      terminal.show();
      // Кавычки нужны, если путь к dotnet содержит пробелы.
      terminal.sendText(`"${dotnetPath}" tool install --global ${tool.packageName}`);
    } else if (action === learnMore) {
      await vscode.env.openExternal(vscode.Uri.parse('https://learn.microsoft.com/dotnet/core/diagnostics/'));
    }
  }

  /** Каталог для файлов дампа и профилей: по умолчанию `.monitor-dotnet` в папке проекта. */
  private async resolveOutputDirectory(configured: string): Promise<string> {
    const directory = await prepareOutputDirectory(configured, currentWorkspaceFolder());
    this.logger.info(translate('Profiling output directory: {0}', directory));
    return directory;
  }
}

/** Папка проекта: в неё по умолчанию складываются результаты. */
function currentWorkspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Метка времени для имени файла: 2026-10-14-08-30-00. */
function timestamp(): string {
  const now = new Date();
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('-');
}
