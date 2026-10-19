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
import { buildTargets, targetCount, type TargetGroups } from './core/targetChoices.ts';
import { listDotnetProcesses } from './monitor/dotnetProcesses.ts';
import { DebugSessionRegistry, snapshotFromSession, type DebugSessionSnapshot } from './monitor/debugSessions.ts';
import { MonitorController } from './monitor/monitorController.ts';
import { ProfilingTools } from './monitor/profilingTools.ts';
import { activateLocalization } from './localization.ts';
import { getSettings, onDidChangeSettings, openSettings, type MonitorSettings } from './settings.ts';
import { CountersTreeProvider } from './views/countersTreeProvider.ts';
import { EnvironmentTreeProvider } from './views/environmentTreeProvider.ts';
import { collectIssues } from './core/issueSource.ts';
import { IssueStore } from './core/issueStore.ts';
import { IssuesTreeProvider } from './views/issuesTreeProvider.ts';
import { PerformanceChartPanel } from './views/performanceChartPanel.ts';
import { MonitorStatusBar } from './views/statusBar.ts';

/**
 * Типы сессий отладки, которые относятся к .NET.
 * `aspire` — тип расширения Aspire: под отладкой находится проект AppHost,
 * приложение запускает Aspire CLI, а не сам отладчик.
 */
const DOTNET_DEBUG_TYPES = new Set(['coreclr', 'clr', 'dotnet', 'dotnet-core', 'aspire']);

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

  // Проблемы копятся по процессам: данные монитора очищаются при смене процесса,
  // а найденные интервалы должны оставаться видимыми — в дереве, сгруппированные по процессу.
  const issues = new IssueStore(
    () => collectIssues(state, settings.enableIssueDetection),
    () => settings.enableIssueDetection,
    () => {
      const hello = state.hello;
      if (hello === undefined) {
        return undefined;
      }

      return {
        key: `pid:${hello.pid}`,
        label: hello.processName.length > 0 ? `${hello.processName} (PID ${hello.pid})` : `PID ${hello.pid}`,
      };
    },
    // Точки интервалов сохраняются, пока они ещё есть у монитора: иначе выделить
    // найденное место на графиках будет нечем, когда ряд уйдёт вперёд.
    () => ({ points: state.series, gcEvents: state.gcEvents }),
  );

  // Панель графиков: webview с настоящими графиками — CPU, сборка мусора и память.
  let performancePanel: PerformanceChartPanel | undefined;
  performancePanel = new PerformanceChartPanel(
    context.extensionUri,
    state,
    () => settings.chartWindowSeconds,
    () => settings.refreshIntervalSeconds,
    // Полосы на графиках и список над ними относятся к процессу, чьи данные показаны.
    () => issues.current(),
    logger,
    {
      listTargets: () => collectTargets(sessions, controller),
      selectTarget: value => switchTarget(value, controller, sessions, getSettings, logger, id => monitoredSessionId = id),
      // Нажатие на проблему в списке панели: панель уже создана к моменту вызова.
      revealIssue: issue => {
        if (performancePanel !== undefined) {
          return revealIssueInterval(issue, state, issues, performancePanel);
        }

        return undefined;
      },
    },
  );
  // Реестр запущенных сессий отладки: из него собирается список целей мониторинга.
  const sessions = new DebugSessionRegistry();

  // Дерево проблем: тот же список, что и в панели графиков, но в нативном виде и по процессам.
  const issuesProvider = new IssuesTreeProvider({
    state,
    listGroups: () => issues.groups(),
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

    sessions,
    vscode.debug.onDidStartDebugSession(session => void handleDebugSessionStarted(
      session,
      controller,
      sessions,
      logger,
      () => settings,
      () => monitoredSessionId,
      id => monitoredSessionId = id,
      () => monitoredSessionId = undefined,
      () => void performancePanel.refreshTargets(),
      () => issues.clear(),
    )),
    vscode.debug.onDidTerminateDebugSession(session => void handleDebugSessionTerminated(
      session,
      controller,
      sessions,
      logger,
      () => monitoredSessionId,
      () => monitoredSessionId = undefined,
      () => void performancePanel.refreshTargets(),
    )),

    vscode.commands.registerCommand('monitor-dotnet.startMonitoring', () => startMonitoringCommand(controller, state, logger)),
    vscode.commands.registerCommand('monitor-dotnet.stopMonitoring', () => controller.stop(translate('Monitoring stopped by the user.'))),
    vscode.commands.registerCommand('monitor-dotnet.attachToProcess', () => attachToProcessCommand(controller, state, logger)),
    vscode.commands.registerCommand('monitor-dotnet.selectTarget', () =>
      selectTargetCommand(controller, sessions, logger, () => settings, (id) => monitoredSessionId = id, () => monitoredSessionId)),
    vscode.commands.registerCommand('monitor-dotnet.focusPerformance', async () => {
      await vscode.commands.executeCommand('monitor-dotnet.performance.focus');
    }),
    vscode.commands.registerCommand('monitor-dotnet.clearData', () => {
      // Вместе с собранными данными забываем и найденные по ним проблемы.
      state.clear();
      issues.clear();
    }),
    // Переход к интервалу из дерева проблем: выделяем его на графиках.
    vscode.commands.registerCommand('monitor-dotnet.selectIssueInterval', async (range?: Partial<IssueIntervalRequest>) => {
      if (typeof range?.fromMs !== 'number' || typeof range.toMs !== 'number' || performancePanel === undefined) {
        return;
      }

      await revealIssueInterval(
        { ...range, fromMs: range.fromMs, toMs: range.toMs },
        state,
        issues,
        performancePanel,
      );
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
    // Полный дамп памяти: нужен, когда приложение зависло или падает.
    vscode.commands.registerCommand('monitor-dotnet.collectMemoryDump', async () => {
      const pid = requirePid(controller);
      if (pid === undefined) {
        return;
      }

      await profiling.collectMemoryDump(pid, settings.dotnetPath, settings.profilingOutputDirectory);
    }),
    // Открыть последний профиль Speedscope: файл лежит в каталоге результатов.
    vscode.commands.registerCommand('monitor-dotnet.openSpeedscopeProfile', async () => {
      await profiling.openSpeedscopeProfile(settings.profilingOutputDirectory);
    }),
    // Символы к дампу: без них в дампе не видно имён функций.
    vscode.commands.registerCommand('monitor-dotnet.downloadSymbols', async () => {
      await profiling.downloadSymbols(settings.dotnetPath, settings.profilingOutputDirectory);
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
  sessions: DebugSessionRegistry,
  logger: Logger,
  getCurrentSettings: () => MonitorSettings,
  getMonitoredSessionId: () => string | undefined,
  onMonitoringStarted: (sessionId: string) => void,
  onMonitoringReleased: () => void,
  onSessionsChanged: () => void,
  /** Новый прогон отладки: найденные ранее проблемы относятся к прошлому запуску. */
  onNewDebugRun: () => void,
): Promise<void> {
  if (!DOTNET_DEBUG_TYPES.has(session.type)) {
    logger.info(translate('Debug session "{0}" has type "{1}" — monitoring is not required.', session.name, session.type));
    return;
  }

  // Сессию запоминаем всегда: она нужна в списке целей, даже если мониторинг выключен.
  const snapshot = snapshotFromSession(session);
  sessions.add(snapshot);
  onSessionsChanged();

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

  // Цель уже выбрана: в связке запускается несколько сессий, и переключаться между ними
  // молча нельзя — иначе мониторинг будет перескакивать на последнюю запущенную.
  if (getMonitoredSessionId() !== undefined) {
    logger.info(translate('Monitoring is already running for another session; session "{0}" was not started automatically.', session.name));
    void notifyAboutAlternativeTargets(sessions, controller);
    // Процесс этой сессии всё равно ищем: он нужен в списке целей, чтобы можно было переключиться.
    void resolveSessionPidInBackground(snapshot, settings, sessions, logger, onSessionsChanged);
    return;
  }

  // Владение сессией захватываем до поиска процесса: поиск асинхронный, и за это время
  // может стартовать вторая сессия связки — она не должна перехватить мониторинг.
  onMonitoringStarted(session.id);

  const pid = await resolveDebuggeePid(snapshot, settings, logger);
  if (pid === undefined) {
    logger.warn(translate('Could not determine the process for session "{0}". Monitoring is not started.', session.name));
    onMonitoringReleased();
    void vscode.window.showWarningMessage(
      translate('Monitor Dotnet: could not determine the process being debugged. Use the "Select Process" command or set monitor-dotnet.processNameFilter.'),
    );
    return;
  }

  sessions.setPid(session.id, pid);
  onSessionsChanged();

  if (settings.autoReveal) {
    await vscode.commands.executeCommand('monitor-dotnet.performance.focus');
  }

  const started = await controller.start(pid, session.name);
  if (!started) {
    onMonitoringReleased();
    return;
  }

  // Мониторинг новой сессии начался: список проблем начинаем с чистого листа,
  // чтобы прошлые интервалы не выдавались за найденные в этом прогоне.
  onNewDebugRun();
}

/**
 * Ищет процесс сессии, которая не стала целью мониторинга.
 * Работает в фоне: без этого в списке целей такая сессия осталась бы без PID.
 */
async function resolveSessionPidInBackground(
  session: DebugSessionSnapshot,
  settings: MonitorSettings,
  sessions: DebugSessionRegistry,
  logger: Logger,
  onSessionsChanged: () => void,
): Promise<void> {
  const pid = await resolveDebuggeePid(session, settings, logger);
  if (pid === undefined) {
    return;
  }

  sessions.setPid(session.id, pid);
  onSessionsChanged();
}

/**
 * Подсказывает, что рядом запущена ещё одна цель.
 * Показываем один раз на набор сессий: при запуске связки проектов уведомление иначе повторялось бы.
 */
async function notifyAboutAlternativeTargets(
  sessions: DebugSessionRegistry,
  controller: MonitorController,
): Promise<void> {
  const known = sessions.withKnownPid();
  if (known.length < 2) {
    return;
  }

  const selection = translate('Select process');
  const action = await vscode.window.showInformationMessage(
    translate(
      'Monitor Dotnet: {0} .NET processes are running under the debugger, monitoring process {1}.',
      known.length,
      controller.pid ?? 0,
    ),
    selection,
  );

  if (action === selection) {
    await vscode.commands.executeCommand('monitor-dotnet.selectTarget');
  }
}

/** Обработка завершения сессии: останавливаем мониторинг, если он следил за её процессом. */
async function handleDebugSessionTerminated(
  session: vscode.DebugSession,
  controller: MonitorController,
  sessions: DebugSessionRegistry,
  logger: Logger,
  getMonitoredSessionId: () => string | undefined,
  onMonitoringStopped: () => void,
  onSessionsChanged: () => void,
): Promise<void> {
  sessions.remove(session.id);
  onSessionsChanged();

  if (getMonitoredSessionId() !== session.id) {
    return;
  }

  await controller.stop(translate('Session "{0}" finished.', session.name));
  onMonitoringStopped();

  // В связке могли остаться другие приложения: предлагаем переключиться на них.
  const remaining = sessions.withKnownPid();
  if (remaining.length === 0) {
    return;
  }

  const selection = translate('Select process');
  const action = await vscode.window.showInformationMessage(
    translate('Monitor Dotnet: session "{0}" finished. Other .NET processes are still running.', session.name),
    selection,
  );

  if (action === selection) {
    await vscode.commands.executeCommand('monitor-dotnet.selectTarget');
  }

  logger.info(translate('Remaining debug sessions: {0}.', remaining.map(item => item.name).join(', ')));
}

/**
 * Собирает список целей мониторинга: активные сессии отладки и процессы .NET.
 * Используется и панелью графиков, и командой выбора процесса.
 */
async function collectTargets(
  sessions: DebugSessionRegistry,
  controller: MonitorController,
): Promise<TargetGroups> {
  const known = sessions.list().map(session => ({
    id: session.id,
    name: session.name,
    type: session.type,
    pid: session.pid,
  }));

  let processes: Awaited<ReturnType<typeof listDotnetProcesses>> = [];
  try {
    processes = await listDotnetProcesses();
  } catch {
    // Список процессов недоступен: показываем хотя бы сессии отладки.
  }

  return buildTargets(known, processes, controller.pid);
}

/**
 * Переключает мониторинг на выбранную цель.
 * Значение приходит из панели или команды: `session:<id>` либо `pid:<pid>`.
 */
async function switchTarget(
  value: string,
  controller: MonitorController,
  sessions: DebugSessionRegistry,
  getCurrentSettings: () => MonitorSettings,
  logger: Logger,
  onMonitoringStarted: (sessionId: string | undefined) => void,
): Promise<void> {
  if (value.startsWith('pid:')) {
    const pid = Number(value.slice('pid:'.length));
    if (!Number.isInteger(pid) || pid <= 0) {
      logger.warn(translate('Could not switch monitoring: invalid target {0}.', value));
      return;
    }

    await startOnPid(pid, undefined, controller, sessions, logger, onMonitoringStarted);
    return;
  }

  if (!value.startsWith('session:')) {
    logger.warn(translate('Could not switch monitoring: unknown target {0}.', value));
    return;
  }

  const sessionId = value.slice('session:'.length);
  const session = sessions.get(sessionId);
  if (session === undefined) {
    logger.warn(translate('Could not switch monitoring: session {0} is no longer running.', sessionId));
    return;
  }

  // Процесс сессии обычно известен: он ищется при её старте.
  let pid = session.pid;
  if (pid === undefined) {
    pid = await resolveDebuggeePid(session, getCurrentSettings(), logger);
    if (pid === undefined) {
      logger.warn(translate('Could not determine the process for session "{0}".', session.name));
      void vscode.window.showWarningMessage(
        translate('Monitor Dotnet: could not determine the process of session "{0}".', session.name),
      );
      return;
    }

    sessions.setPid(sessionId, pid);
  }

  await startOnPid(pid, sessionId, controller, sessions, logger, onMonitoringStarted);
}

/**
 * Запускает мониторинг процесса и запоминает сессию, к которой он относится.
 * Подпись цели нужна только для журнала: в панели имя процесса приходит от моста.
 */
async function startOnPid(
  pid: number,
  sessionId: string | undefined,
  controller: MonitorController,
  sessions: DebugSessionRegistry,
  logger: Logger,
  onMonitoringStarted: (sessionId: string | undefined) => void,
): Promise<void> {
  const label = sessionId === undefined ? undefined : sessions.get(sessionId)?.name;
  const started = await controller.start(pid, label);
  if (started) {
    onMonitoringStarted(sessionId);
    logger.info(translate('Monitoring switched to process {0}.', pid));
  }
}

/** Команда выбора процесса: список целей доступен и без панели графиков. */
async function selectTargetCommand(
  controller: MonitorController,
  sessions: DebugSessionRegistry,
  logger: Logger,
  getCurrentSettings: () => MonitorSettings,
  onMonitoringStarted: (sessionId: string | undefined) => void,
  getMonitoredSessionId: () => string | undefined,
): Promise<void> {
  const groups = await collectTargets(sessions, controller);
  if (targetCount(groups) === 0) {
    void vscode.window.showWarningMessage(translate('Monitor Dotnet: no .NET processes or debug sessions found.'));
    return;
  }

  const items: TargetQuickPickItem[] = [];
  const pushGroup = (label: string, entries: readonly TargetGroups['sessions'][number][]): void => {
    if (entries.length === 0) {
      return;
    }

    if (items.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }

    items.push({ label, kind: vscode.QuickPickItemKind.Separator });
    for (const entry of entries) {
      items.push({
        label: `$(${entry.kind === 'session' ? 'debug-alt' : 'server-process'}) ${entry.name}`,
        description: entry.pid === undefined
          ? translate('process is detected when selected')
          : `PID ${entry.pid}${entry.isCurrent ? ` · ${translate('monitoring now')}` : ''}`,
        detail: entry.detail,
        value: entry.value,
      });
    }
  };

  pushGroup(translate('Debug sessions'), groups.sessions);
  pushGroup(translate('Other .NET processes'), groups.processes);

  const picked = await vscode.window.showQuickPick(items, {
    title: translate('Select process to monitor'),
    placeHolder: getMonitoredSessionId() === undefined
      ? translate('Monitoring is not running — pick a process')
      : translate('Current process is marked with a check mark'),
    matchOnDetail: true,
  });

  if (picked === undefined || picked.value === undefined) {
    return;
  }

  await switchTarget(picked.value, controller, sessions, getCurrentSettings, logger, onMonitoringStarted);
}

/** Строка списка выбора процесса. */
interface TargetQuickPickItem extends vscode.QuickPickItem {
  /** Значение цели: `session:<id>` или `pid:<pid>`. */
  value?: string;
}

/** Ищет PID процесса отладки перебором признаков. */
async function resolveDebuggeePid(
  session: DebugSessionSnapshot,
  settings: MonitorSettings,
  logger: Logger,
): Promise<number | undefined> {
  const configuration = session.configuration ?? {};
  const explicitPid = pidFromSessionConfiguration(session);
  const sessionStartMs = Date.now();

  // Подсказки берём из всех полей, которыми разные отладчики задают цель:
  // coreclr указывает сборку в `program`, C# Dev Kit — проект в `projectPath`,
  // расширение Aspire — каталог или файл проекта AppHost в `program`.
  const hints = {
    processId: explicitPid,
    program: stringField(configuration, 'program'),
    projectPath: stringField(configuration, 'projectPath'),
    // Рабочий каталог: из конфигурации, а если его нет — из папки рабочей области.
    cwd: stringField(configuration, 'cwd') ?? session.workspaceFolder,
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

/** Строковое поле из конфигурации запуска: другие типы (числа, объекты) не подходят. */
function stringField(configuration: Record<string, unknown>, name: string): string | undefined {
  const value = configuration[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** PID из конфигурации: используется при подключении к уже запущенному процессу. */
function pidFromSessionConfiguration(session: DebugSessionSnapshot): number | undefined {
  const value = session.configuration.processId;
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
    const pid = await resolveDebuggeePid(snapshotFromSession(activeSession), getSettings(), logger);
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

/** Интервал проблемы, запрошенный из дерева проблем или из списка панели. */
export interface IssueIntervalRequest {
  fromMs: number;
  toMs: number;
  /** Идентификатор проблемы: по нему находится сохранённый интервал. */
  issueId?: string;
  /** Процесс, в котором проблема найдена. Без него берётся мониторимый сейчас. */
  processKey?: string;
  processLabel?: string;
}

/**
 * Показывает интервал найденной проблемы.
 *
 * Пока данные интервала есть у монитора, он выделяется на живых графиках. Если ряд уже
 * ушёл вперёд или мониторится другой процесс, показывается сохранённый интервал: без него
 * выделение пришлось бы на пустое место.
 */
async function revealIssueInterval(
  request: IssueIntervalRequest,
  state: MonitorState,
  issues: IssueStore,
  panel: PerformanceChartPanel,
): Promise<void> {
  const { fromMs, toMs } = request;
  const processKey = request.processKey ?? currentProcessKey(state);
  const liveRange = state.range;
  const coveredByLive = processKey !== undefined &&
    issues.isCurrentProcess(processKey) &&
    liveRange !== undefined &&
    liveRange.fromMs <= fromMs &&
    liveRange.toMs >= toMs;

  if (coveredByLive) {
    await panel.selectInterval(fromMs, toMs);
    return;
  }

  const slice = processKey !== undefined && request.issueId !== undefined
    ? issues.slice(processKey, request.issueId)
    : undefined;
  if (slice === undefined || slice.points.length === 0) {
    // Показывать нечего: без точек графики остались бы пустыми.
    void vscode.window.showInformationMessage(translate(
      'Monitor Dotnet: the points of this interval are no longer available — run monitoring again to analyse it.',
    ));
    return;
  }

  const label = request.processLabel ?? (processKey === undefined ? '' : issues.label(processKey) ?? processKey);
  await panel.showIssueSlice(label, slice);
}

/** Ключ процесса, данные которого сейчас на графиках. */
function currentProcessKey(state: MonitorState): string | undefined {
  const hello = state.hello;
  return hello === undefined ? undefined : `pid:${hello.pid}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
