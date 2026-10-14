/**
 * Работа с процессом моста: запуск, чтение потока сообщений NDJSON и остановка.
 * Мост — отдельный процесс .NET; общение идёт через stdout (протокол) и stderr (диагностика).
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createInterface, type Interface } from 'node:readline';
import { parseBridgeMessage, type BridgeMessage } from '../core/protocol.ts';
import type { Logger } from '../logger.ts';
import { describeError } from '../core/errors.ts';
import { translate } from '../core/locale.ts';

/** Параметры запуска моста. */
export interface BridgeLaunchOptions {
  /** Путь к `dotnet` (или к исполняемому файлу моста). */
  dotnetPath: string;
  /** Путь к сборке моста: `MonitorDotnet.Bridge.dll` или готовый исполняемый файл. */
  bridgePath: string;
  /** Идентификатор мониторимого процесса. */
  pid: number;
  /** Интервал выдачи данных в секундах. */
  refreshIntervalSeconds: number;
  /** Провайдеры счётчиков (см. настройки расширения). */
  counterProviders: readonly string[];
  /** Фильтры метров. */
  metricProviders: readonly string[];
  /** Собирать ли переменные окружения. */
  collectEnvironment: boolean;
}

/** События моста. */
export interface BridgeProcessHandlers {
  onMessage(message: BridgeMessage): void;
  onStderr(line: string): void;
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
}

/**
 * Процесс моста: stdin отключён (мост не читает ввод), stdout и stderr доступны.
 */
type BridgeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export class BridgeProcess {
  private child: BridgeChildProcess | undefined;
  private stdoutReader: Interface | undefined;
  private stderrReader: Interface | undefined;

  private readonly options: BridgeLaunchOptions;
  private readonly logger: Logger;
  private readonly handlers: BridgeProcessHandlers;

  // Параметры-свойства не используем: исходники запускаются в Node при тестах,
  // а удаление типов такую запись не поддерживает.
  constructor(options: BridgeLaunchOptions, logger: Logger, handlers: BridgeProcessHandlers) {
    this.options = options;
    this.logger = logger;
    this.handlers = handlers;
  }

  /** Запускает мост. */
  start(): void {
    const args = buildBridgeArguments(this.options);
    this.logger.info(translate('Starting the bridge: {0} {1}', this.options.dotnetPath, args.join(' ')));

    let child: BridgeChildProcess;
    try {
      child = spawn(this.options.dotnetPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(translate('Could not start the bridge: {0}', describeError(error)));
    }

    this.child = child;
    child.on('error', error => {
      this.handlers.onStderr(translate('Bridge start error: {0}', describeError(error)));
    });

    this.stdoutReader = createInterface({ input: child.stdout });
    this.stdoutReader.on('line', line => {
      const message = parseBridgeMessage(line);
      if (message === null) {
        if (line.trim().length > 0) {
          this.logger.warn(translate('Skipped an unknown bridge message: {0}', line.slice(0, 200)));
        }

        return;
      }

      this.handlers.onMessage(message);
    });

    this.stderrReader = createInterface({ input: child.stderr });
    this.stderrReader.on('line', line => {
      if (line.trim().length > 0) {
        this.handlers.onStderr(line);
      }
    });

    child.on('exit', (code, signal) => {
      this.disposeReaders();
      this.child = undefined;
      this.handlers.onExit(code, signal);
    });
  }

  /** Признак того, что процесс моста запущен. */
  get isRunning(): boolean {
    return this.child !== undefined;
  }

  /** Останавливает мост (SIGTERM, при необходимости — принудительно). */
  async stop(timeoutMs = 2000): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }

    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');

    const timer = new Promise<void>(resolve => setTimeout(resolve, timeoutMs));
    await Promise.race([exited, timer]);

    if (this.child !== undefined) {
      this.child.kill('SIGKILL');
      await exited;
    }
  }

  private disposeReaders(): void {
    this.stdoutReader?.close();
    this.stderrReader?.close();
    this.stdoutReader = undefined;
    this.stderrReader = undefined;
  }
}

/**
 * Формирует аргументы запуска моста.
 * Если путь указывает на исполняемый файл, запускаем его напрямую, иначе — через `dotnet <dll>`.
 */
export function buildBridgeArguments(options: BridgeLaunchOptions): string[] {
  const args: string[] = [];

  const isNativeExecutable = !options.bridgePath.toLowerCase().endsWith('.dll');
  if (isNativeExecutable) {
    // Аргументы передаются напрямую: путь уже является исполняемым файлом.
    args.push('--pid', options.pid.toString());
  } else {
    args.push(options.bridgePath, '--pid', options.pid.toString());
  }

  args.push('--refresh-interval', options.refreshIntervalSeconds.toString());

  const counters = options.counterProviders.join(',');
  if (counters.length > 0) {
    args.push('--counters', counters);
  }

  const metrics = options.metricProviders.join(',');
  if (metrics.length > 0) {
    args.push('--metrics', metrics);
  }

  if (!options.collectEnvironment) {
    args.push('--no-environment');
  }

  return args;
}
