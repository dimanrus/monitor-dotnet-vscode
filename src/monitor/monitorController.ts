/**
 * Управление жизненным циклом мониторинга: поиск моста, запуск и остановка процесса,
 * передача собранных данных в состояние расширения.
 */

import * as vscode from 'vscode';
import { translate } from '../core/locale.ts';
import {
  isUsableSample,
  type BridgeErrorMessage,
  type BridgeMessage,
  type BridgeStatusMessage,
} from '../core/protocol.ts';
import type { MonitorState } from '../core/monitorState.ts';
import type { Logger } from '../logger.ts';
import { locateBridge } from './bridgeLocator.ts';
import { BridgeProcess } from './bridgeProcess.ts';
import type { MonitorSettings } from '../settings.ts';

/** Слушатель изменения признака «мониторинг запущен». */
export type RunningStateListener = (running: boolean) => void;

export class MonitorController implements vscode.Disposable {
  private bridge: BridgeProcess | undefined;
  private readonly listeners = new Set<RunningStateListener>();
  private currentPid: number | undefined;
  // Признак того, что мост останавливаем мы сами: обработчик выхода учитывает это,
  // чтобы не сообщать пользователю о «неожиданном» завершении.
  private stoppingIntentionally = false;

  private readonly state: MonitorState;
  private readonly logger: Logger;
  private readonly extensionPath: string;
  private readonly getSettings: () => MonitorSettings;

  constructor(
    state: MonitorState,
    logger: Logger,
    extensionPath: string,
    getSettings: () => MonitorSettings,
  ) {
    this.state = state;
    this.logger = logger;
    this.extensionPath = extensionPath;
    this.getSettings = getSettings;
  }

  /** PID мониторимого процесса. */
  get pid(): number | undefined {
    return this.currentPid;
  }

  /** Признак активного мониторинга. */
  get isRunning(): boolean {
    return this.bridge?.isRunning === true;
  }

  /** Подписка на изменение состояния мониторинга. */
  onDidChangeRunning(listener: RunningStateListener): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Запускает мониторинг процесса. Повторный вызов перезапускает мост на новом процессе. */
  async start(pid: number, label?: string): Promise<boolean> {
    const settings = this.getSettings();

    if (this.currentPid === pid && this.isRunning) {
      return true;
    }

    await this.stop();

    const location = await locateBridge(settings.bridgePath, this.extensionPath, this.logger);
    if (location === undefined) {
      const openSettings = translate('Open settings');
      const showLog = translate('Show log');
      const action = await vscode.window.showErrorMessage(
        translate('Monitor Dotnet: the bridge assembly was not found. Build bridge/MonitorDotnet.Bridge or set monitor-dotnet.bridgePath.'),
        openSettings,
        showLog,
      );
      if (action === openSettings) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'monitor-dotnet.bridgePath');
      } else if (action === showLog) {
        this.logger.show();
      }

      return false;
    }

    this.logger.info(translate('Bridge found ({0}): {1}', location.source, location.bridgePath));
    this.state.reset();

    const bridge = new BridgeProcess(
      {
        dotnetPath: settings.dotnetPath,
        bridgePath: location.bridgePath,
        pid,
        refreshIntervalSeconds: settings.refreshIntervalSeconds,
        counterProviders: settings.counterProviders,
        metricProviders: settings.metricProviders,
        collectEnvironment: true,
      },
      this.logger,
      {
        onMessage: message => this.handleMessage(message, pid, label),
        onStderr: line => this.logger.info(`[bridge] ${line}`),
        onExit: (code, signal) => this.handleExit(code, signal, pid),
      },
    );

    this.bridge = bridge;
    this.currentPid = pid;
    this.state.applyStatus({
      type: 'status',
      state: 'connecting',
      message: translate('Connecting to process {0}…', pid),
    });

    try {
      bridge.start();
    } catch (error) {
      this.logger.error(translate('Could not start the bridge'), error);
      this.bridge = undefined;
      this.currentPid = undefined;
      this.state.applyError(String(error), true);
      return false;
    }

    this.notifyRunning(true);
    return true;
  }

  /** Останавливает мониторинг. Данные остаются в панелях до очистки. */
  async stop(message?: string): Promise<void> {
    const bridge = this.bridge;
    if (bridge === undefined) {
      return;
    }

    this.stoppingIntentionally = true;
    this.bridge = undefined;
    this.currentPid = undefined;

    try {
      await bridge.stop();
    } finally {
      this.stoppingIntentionally = false;
    }

    this.state.markStopped(message);
    this.notifyRunning(false);
  }

  /** Признак того, что мониторится указанный процесс. */
  isMonitoring(pid: number): boolean {
    return this.currentPid === pid && this.isRunning;
  }

  /** Перезапускает мост с текущими настройками (например, после их изменения). */
  async restart(): Promise<void> {
    const pid = this.currentPid;
    if (pid === undefined) {
      return;
    }

    await this.stop();
    await this.start(pid);
  }

  dispose(): void {
    void this.stop();
  }

  private handleMessage(message: BridgeMessage, pid: number, label: string | undefined): void {
    switch (message.type) {
      case 'hello':
        this.logger.info(translate('Monitoring of process {0} ({1}) started.', pid, label ?? message.processName));
        this.state.applyHello(message);
        return;

      case 'sample':
        if (!isUsableSample(message)) {
          // Повреждённый срез не должен портить графики.
          this.logger.warn(translate('A sample without numeric process counters was skipped.'));
          return;
        }

        this.state.applySample(message);
        return;

      case 'environment':
        this.state.applyEnvironment(message);
        return;

      case 'status':
        this.state.applyStatus({ ...message, message: localizeStatusHint(message) ?? null });
        return;

      case 'error': {
        const text = localizeBridgeError(message, pid);
        this.logger.error(translate('The bridge reported an error: {0}', text));
        this.state.applyError(text, message.fatal);
        if (message.fatal) {
          void vscode.window.showErrorMessage(text);
        }

        return;
      }

      case 'log':
        this.logger.info(`[bridge] ${message.message}`);
        return;
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, pid: number): void {
    const intentional = this.stoppingIntentionally;
    this.logger.info(translate('The bridge exited (code {0}, signal {1}).', code ?? 'n/a', signal ?? 'none'));
    this.bridge = undefined;
    this.currentPid = undefined;
    this.notifyRunning(false);

    if (intentional) {
      this.state.markStopped();
      return;
    }

    if (code === 0) {
      this.state.markStopped(translate('Process {0} finished.', pid));
      return;
    }

    this.state.markStopped(translate('Monitoring of process {0} stopped (code {1}).', pid, code ?? 'n/a'));
  }

  private notifyRunning(running: boolean): void {
    for (const listener of this.listeners) {
      listener(running);
    }
  }
}

/**
 * Переводит причину остановки, пришедшую от моста.
 * Если код неизвестен, показываем текст моста — он английский, но это лучше, чем ничего.
 */
function localizeStatusHint(status: BridgeStatusMessage): string | undefined {
  switch (status.reason) {
    case 'targetExited':
      return translate('The target process has exited.');
    default:
      return status.message ?? undefined;
  }
}

/**
 * Собирает сообщение об ошибке моста на языке пользователя.
 * Мост присылает код и подробность, поэтому фразу формирует расширение.
 */
function localizeBridgeError(error: BridgeErrorMessage, pid: number): string {
  switch (error.code) {
    case 'processNotFound':
      return translate('Monitor Dotnet: process {0} was not found.', pid);
    case 'connectFailed':
      return translate('Monitor Dotnet: could not connect to process {0} through EventPipe: {1}', pid, error.message);
    default:
      return translate('Monitor Dotnet: {0}', error.message);
  }
}
