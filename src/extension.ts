/**
 * Точка входа расширения Monitor Dotnet.
 *
 * Расширение следит за сессиями отладки .NET, находит целевой процесс, запускает мост
 * (отдельный процесс, собирающий данные через EventPipe) и показывает результат
 * в нативных панелях: Performance, Counters и Environment.
 */

import * as vscode from 'vscode';
import { selectDebuggeePid } from './core/debuggeeMatching.ts';
import { translate } from './core/locale.ts';
import { MonitorState } from './core/monitorState.ts';
import { Logger } from './logger.ts';
import { listDotnetProcesses } from './monitor/dotnetProcesses.ts';
import { MonitorController } from './monitor/monitorController.ts';
import { ProfilingTools } from './monitor/profilingTools.ts';
import { activateLocalization } from './localization.ts';
import { getSettings, onDidChangeSettings, openSettings, type MonitorSettings } from './settings.ts';
import { CountersTreeProvider } from './views/countersTreeProvider.ts';
import { EnvironmentTreeProvider } from './views/environmentTreeProvider.ts';
import { collectIssues } from './core/issueSource.ts';
import { IssuesTreeProvider } from './views/issuesTreeProvider.ts';
import { PerformanceChartPanel } from './views/performanceChartPanel.ts';
import { MonitorStatusBar } from './views/statusBar.ts';

/** Типы сессий отладки, которые относятся к .NET. */
const DOTNET_DEBUG_TYPES = new Set(['coreclr', 'clr', 'dotnet', 'dotnet-core']);

/** Как долго искать процесс отладки после старта сессии. */
const DEBUGGEE_SEARCH_TIMEOUT_MS = 20_000;

/** Интервал повторных попыток поиска процесса. */
const DEBUGGEE_SEARCH_INTERVAL_MS = 500;

export function activate(context: vscode.ExtensionContext): void {
  // Язык интерфейса и перевод строк подключаем до создания любых сообщений.
  activateLocalization();

  const logger = new Logger();
  const state = new MonitorState();

  // Состояние хранит столько точек, сколько помещается в окно графиков.
  const applyWindow = (settings: MonitorSettings): void => {
    state.setMaxPoints(Math.ceil(settings.chartWindowSeconds / Math.max(0.2, settings.refreshIntervalSeconds)));
  };

  applyWindow(getSettings());

  let settings = getSettings();
  const controller = new MonitorController(state, logger, context.extensionPath, () => settings);
  const profiling = new ProfilingTools(logger);

  // Панель графиков: webview с настоящими графиками — CPU, сборка мусора и память.
  const performancePanel = new PerformanceChartPanel(
    context.extensionUri,
    state,
    () => settings.chartWindowSeconds,
    () => settings.refreshIntervalSeconds,
    () => settings.enableIssueDetection,
    logger,
  );
  // Дерево проблем: тот же список, что и в панели графиков, но в нативном виде.
  const issuesProvider = new IssuesTreeProvider({
    state,
    collect: () => collectIssues(state, settings.enableIssueDetection),
    isEnabled: () => settings.enableIssueDetection,
  });
  const countersProvider = new CountersTreeProvider(state);
  const environmentProvider = new EnvironmentTreeProvider(state);
  const statusBar = new MonitorStatusBar(state);

  // Исходные значения контекстных ключей: управляют кнопками в заголовках панелей.
  void vscode.commands.executeCommand('setContext', 'monitor-dotnet.isMonitoring', false);
  void vscode.commands.executeCommand('setContext', 'monitor-dotnet.isProfiling', false);

  // Сессия, для которой сейчас идёт мониторинг: нужна, чтобы остановиться при её завершении.
  let monitoredSessionId: string | undefined;

  context.subscriptions.push(
    logger,
    performancePanel,
    issuesProvider,
    countersProvider,
    environmentProvider,
    statusBar,
    controller,
    vscode.window.registerWebviewViewProvider(PerformanceChartPanel.viewType, performancePanel),
    vscode.window.registerTreeDataProvider('monitor-dotnet.issues', issuesProvider),
    vscode.window.registerTreeDataProvider('monitor-dotnet.counters', countersProvider),
    vscode.window.registerTreeDataProvider('monitor-dotnet.environment', environmentProvider),

    // Контекстные ключи управляют видимостью команд в заголовках панелей.
    controller.onDidChangeRunning(running => {
      void vscode.commands.executeCommand('setContext', 'monitor-dotnet.isMonitoring', running);
      if (!running) {
        void vscode.commands.executeCommand('setContext', 'monitor-dotnet.isProfiling', false);
      }
    }),

    onDidChangeSettings(() => {
      const previous = settings;
      settings = getSettings();
      applyWindow(settings);
      // Сообщаем панели новые параметры (окно графиков, период обновления).
      performancePanel.sync();
      // Настройка поиска проблем могла измениться: дерево перечитывает список.
      issuesProvider.refresh();

      // Изменение параметров сбора требует перезапуска моста.
      if (controller.isRunning &&
        (previous.refreshIntervalSeconds !== settings.refreshIntervalSeconds ||
          previous.counterProviders.join(',') !== settings.counterProviders.join(',') ||
          previous.metricProviders.join(',') !== settings.metricProviders.join(','))) {
        void controller.restart();
      }
    }),

    vscode.debug.onDidStartDebugSession(session => void handleDebugSessionStarted(session, controller, logger, () => settings, id => monitoredSessionId = id)),
    vscode.debug.onDidTerminateDebugSession(session => void handleDebugSessionTerminated(session, controller, () => monitoredSessionId)),

    vscode.commands.registerCommand('monitor-dotnet.startMonitoring', () => startMonitoringCommand(controller, state, logger)),
    vscode.commands.registerCommand('monitor-dotnet.stopMonitoring', () => controller.stop(translate('Monitoring stopped by the user.'))),
    vscode.commands.registerCommand('monitor-dotnet.attachToProcess', () => attachToProcessCommand(controller, state, logger)),
    vscode.commands.registerCommand('monitor-dotnet.focusPerformance', async () => {
      await vscode.commands.executeCommand('monitor-dotnet.performance.focus');
    }),
    vscode.commands.registerCommand('monitor-dotnet.clearData', () => state.clear()),
    // Переход к интервалу из дерева проблем: выделяем его на графиках.
    vscode.commands.registerCommand('monitor-dotnet.selectIssueInterval', async (range?: { fromMs?: number; toMs?: number }) => {
      if (typeof range?.fromMs !== 'number' || typeof range.toMs !== 'number') {
        return;
      }

      await performancePanel.selectInterval(range.fromMs, range.toMs);
    }),
    vscode.commands.registerCommand('monitor-dotnet.openSettings', () => openSettings()),
    vscode.commands.registerCommand('monitor-dotnet.copyEnvironmentValue', async (node: { description?: string }) => {
      if (typeof node?.description === 'string') {
        await vscode.env.clipboard.writeText(node.description);
        void vscode.window.setStatusBarMessage(translate('Value copied to clipboard'), 3000);
      }
    }),
    vscode.commands.registerCommand('monitor-dotnet.filterEnvironment', async () => {
      const filter = await vscode.window.showInputBox({
        prompt: translate('Filter by variable name or value (empty to reset)'),
        value: environmentProvider.currentFilter,
      });

      if (filter !== undefined) {
        environmentProvider.setFilter(filter);
      }
    }),
    vscode.commands.registerCommand('monitor-dotnet.collectCallStack', async () => {
      const pid = requirePid(controller);
      if (pid !== undefined) {
        await profiling.collectCallStack(pid, settings.dotnetPath);
      }
    }),
    vscode.commands.registerCommand('monitor-dotnet.collectMemorySnapshot', async () => {
      const pid = requirePid(controller);
      if (pid !== undefined) {
        await profiling.collectMemorySnapshot(pid, settings.dotnetPath, settings.profilingOutputDirectory);
      }
    }),
    vscode.commands.registerCommand('monitor-dotnet.startProfiling', async () => {
      const pid = requirePid(controller);
      if (pid === undefined) {
        return;
      }

      const target = await profiling.startProfiling(pid, settings.dotnetPath, settings.profilingOutputDirectory);
      if (target !== undefined) {
        await vscode.commands.executeCommand('setContext', 'monitor-dotnet.isProfiling', true);
        void vscode.window.showInformationMessage(translate('Monitor Dotnet: profiling started ({0}).', target));
      }
    }),
    vscode.commands.registerCommand('monitor-dotnet.stopProfiling', async () => {
      await profiling.stopProfiling();
      await vscode.commands.executeCommand('setContext', 'monitor-dotnet.isProfiling', false);
    }),
  );

  logger.info(translate('Monitor Dotnet extension activated.'));
}

export function deactivate(): void {
  // Все ресурсы освобождаются через подписки контекста расширения.
}

/**
 * Обработка старта сессии отладки: если это .NET и настройки разрешают,
 * находим процесс и запускаем мониторинг.
 */
async function handleDebugSessionStarted(
  session: vscode.DebugSession,
  controller: MonitorController,
  logger: Logger,
  getCurrentSettings: () => MonitorSettings,
  onMonitoringStarted: (sessionId: string) => void,
): Promise<void> {
  if (!DOTNET_DEBUG_TYPES.has(session.type)) {
    logger.info(translate('Debug session "{0}" has type "{1}" — monitoring is not required.', session.name, session.type));
    return;
  }

  const settings = getCurrentSettings();
  if (settings.enableMonitoring === 'never') {
    logger.info(translate('Automatic monitoring is disabled by monitor-dotnet.enableMonitoring.'));
    return;
  }

  // Запуск без отладки (noDebug) относится к режиму «при отладке или запуске».
  if (settings.enableMonitoring === 'onDebug' && session.configuration?.noDebug === true) {
    logger.info(translate('The session runs without debugging, but the monitoring mode is "on debug only".'));
    return;
  }

  const pid = await resolveDebuggeePid(session, settings, logger);
  if (pid === undefined) {
    logger.warn(translate('Could not determine the process for session "{0}". Monitoring is not started.', session.name));
    void vscode.window.showWarningMessage(
      translate('Monitor Dotnet: could not determine the process being debugged. Use the "Attach to .NET Process…" command or set monitor-dotnet.processNameFilter.'),
    );
    return;
  }

  if (settings.autoReveal) {
    await vscode.commands.executeCommand('monitor-dotnet.performance.focus');
  }

  const started = await controller.start(pid, session.name);
  if (started) {
    onMonitoringStarted(session.id);
  }
}

/** Обработка завершения сессии: останавливаем мониторинг, если он следил за её процессом. */
async function handleDebugSessionTerminated(
  session: vscode.DebugSession,
  controller: MonitorController,
  getMonitoredSessionId: () => string | undefined,
): Promise<void> {
  if (getMonitoredSessionId() === session.id) {
    await controller.stop(translate('Session "{0}" finished.', session.name));
  }
}

/** Ищет PID процесса отладки перебором признаков. */
async function resolveDebuggeePid(
  session: vscode.DebugSession,
  settings: MonitorSettings,
  logger: Logger,
): Promise<number | undefined> {
  const configuration = session.configuration ?? {};
  const explicitPid = pidFromSessionConfiguration(session);
  const sessionStartMs = Date.now();

  const hints = {
    processId: explicitPid,
    program: typeof configuration.program === 'string' ? configuration.program : undefined,
    cwd: typeof configuration.cwd === 'string' ? configuration.cwd : undefined,
    processNameFilter: settings.processNameFilter.length > 0 ? settings.processNameFilter : undefined,
    sessionStartMs,
    excludePids: [],
  };

  const deadline = sessionStartMs + DEBUGGEE_SEARCH_TIMEOUT_MS;
  let candidates = await listDotnetProcesses();
  while (Date.now() < deadline) {
    const found = selectDebuggeePid(candidates, hints);
    if (found !== undefined) {
      logger.info(translate('Debuggee process found: PID {0}.', found));
      return found;
    }

    // Процесс отладки мог ещё не появиться — ждём и пробуем снова.
    await delay(DEBUGGEE_SEARCH_INTERVAL_MS);
    candidates = await listDotnetProcesses();
  }

  // Точную цель найти не удалось: берём самый поздний подходящий процесс,
  // чтобы мониторинг всё же заработал.
  const fallback = selectDebuggeePid(candidates, { ...hints, allowFallback: true });
  if (fallback !== undefined) {
    logger.warn(translate('Exact match not found; monitoring attaches to process {0}.', fallback));
    return fallback;
  }

  // Подробности помогают понять причину: какие процессы есть и по каким признакам искали.
  logger.warn(translate(
    'The debuggee process was not determined within {0} s. .NET processes found: {1}. Hints: program={2}, cwd={3}.',
    DEBUGGEE_SEARCH_TIMEOUT_MS / 1000,
    candidates.length,
    hints.program ?? '—',
    hints.cwd ?? '—',
  ));
  for (const candidate of candidates.slice(0, 10)) {
    const started = candidate.startTimeMs > 0
      ? new Date(candidate.startTimeMs).toISOString()
      : translate('start time unknown');
    logger.info(translate('candidate PID {0} ({1}): {2}', candidate.pid, started, candidate.commandLine.slice(0, 160)));
  }

  return undefined;
}

/** PID из конфигурации: используется при подключении к уже запущенному процессу. */
function pidFromSessionConfiguration(session: vscode.DebugSession): number | undefined {
  const value = session.configuration?.processId;
  if (typeof value === 'number' && value > 0) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value)) {
    return Number(value);
  }

  return undefined;
}

/** Команда ручного запуска мониторинга: выбираем активную сессию или процесс из списка. */
async function startMonitoringCommand(
  controller: MonitorController,
  state: MonitorState,
  logger: Logger,
): Promise<void> {
  const activeSession = vscode.debug.activeDebugSession;
  if (activeSession !== undefined && DOTNET_DEBUG_TYPES.has(activeSession.type)) {
    const pid = await resolveDebuggeePid(activeSession, getSettings(), logger);
    if (pid !== undefined) {
      await controller.start(pid, activeSession.name);
      return;
    }
  }

  await attachToProcessCommand(controller, state, logger);
}

/** Команда подключения к выбранному процессу .NET. */
async function attachToProcessCommand(
  controller: MonitorController,
  state: MonitorState,
  logger: Logger,
): Promise<void> {
  state.reset();
  const processes = await listDotnetProcesses();

  if (processes.length === 0) {
    void vscode.window.showWarningMessage(translate('Monitor Dotnet: no .NET processes found.'));
    return;
  }

  const picked = await vscode.window.showQuickPick(
    processes.map(candidate => ({
      label: `$(server-process) ${candidate.name || translate('process')}`,
      description: `PID ${candidate.pid}`,
      detail: candidate.commandLine,
      pid: candidate.pid,
    })),
    {
      title: translate('Monitor Dotnet: choose a .NET process'),
      placeHolder: translate('Start typing a process name or id'),
      matchOnDetail: true,
    },
  );

  if (picked === undefined) {
    return;
  }

  logger.info(translate('Attaching to process {0} on user request.', picked.pid));
  await controller.start(picked.pid);
}

/** Возвращает PID активного мониторинга или показывает предупреждение. */
function requirePid(controller: MonitorController): number | undefined {
  const pid = controller.pid;
  if (pid === undefined) {
    void vscode.window.showWarningMessage(translate('Monitor Dotnet: monitoring is not running.'));
  }

  return pid;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
