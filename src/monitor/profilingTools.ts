/**
 * Получение данных профилирования по требованию:
 * стек вызовов, снимок памяти и запуск профилирования.
 * Используются официальные средства .NET (`dotnet-stack`, `dotnet-gcdump`, `dotnet-trace`).
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { translate } from '../core/locale.ts';
import { describeError } from '../core/errors.ts';
import {
  CALL_STACK_TOOL,
  MEMORY_SNAPSHOT_TOOL,
  TRACE_TOOL,
  resolveToolPath,
  type DotnetTool,
} from './dotnetToolLocator.ts';
import type { Logger } from '../logger.ts';

const execFileAsync = promisify(execFile);

/** Обёртка над внешними инструментами диагностики. */
export class ProfilingTools {
  private traceProcess: ChildProcess | undefined;

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
      this.logger.info(translate('Profiling finished (code {0}). File: {1}', code ?? 'n/a', target));
      void vscode.window.showInformationMessage(translate('Profile saved: {0}', target));
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

  /** Каталог для файлов дампа и профилей. */
  private async resolveOutputDirectory(configured: string): Promise<string> {
    const directory = configured.length > 0
      ? path.resolve(configured)
      : path.join(os.tmpdir(), 'monitor-dotnet');

    await mkdir(directory, { recursive: true });
    return directory;
  }
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
