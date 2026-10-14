/**
 * Тексты панели графиков.
 *
 * Внутри webview недоступен API локализации VS Code, поэтому строки передаёт расширение:
 * оно переводит их через `vscode.l10n` и присылает панели вместе с данными.
 * Здесь же лежат английские тексты по умолчанию — их панель использует, пока перевод не пришёл.
 */

/** Набор текстов панели графиков. */
export interface WebviewStrings {
  chartCpuTitle: string;
  chartGcTitle: string;
  chartMemoryTitle: string;
  legendCpu: string;
  legendAllocation: string;
  legendPrivateMemory: string;
  legendManagedHeap: string;
  legendWorkingSet: string;
  legendGen0: string;
  legendGen1: string;
  legendGen2: string;
  buttonPause: string;
  buttonResume: string;
  buttonResetSelection: string;
  buttonBackToLive: string;
  archiveHint: string;
  processNotSelected: string;
  waitingForData: string;
  statusRunning: string;
  statusConnecting: string;
  statusStopped: string;
  statusFailed: string;
  statusIdle: string;
  statusArchive: string;
  hintStart: string;
  tileCpu: string;
  tilePrivateMemory: string;
  tileManagedHeap: string;
  tileAllocation: string;
  tileTimeInGc: string;
  tileThreads: string;
  tileGcCounts: string;
  summaryTitle: string;
  summaryRange: string;
  summaryPoints: string;
  summaryCpu: string;
  summaryPrivateMemory: string;
  summaryManagedHeap: string;
  summaryGcCount: string;
  summaryGcPause: string;
  tooltipGc: string;
  issuesTitle: string;
  issuesHint: string;
  targetLabel: string;
  targetSessions: string;
  targetProcesses: string;
  targetEmpty: string;
}

/**
 * Английские тексты. Они же служат ключами перевода:
 * строка попадает в словарь `l10n/bundle.l10n.<язык>.json` именно в таком виде.
 */
export const WEBVIEW_SOURCE_STRINGS: Record<keyof WebviewStrings, string> = {
  chartCpuTitle: 'CPU load',
  chartGcTitle: 'Garbage collection',
  chartMemoryTitle: 'Memory',
  legendCpu: 'CPU',
  legendAllocation: 'Allocation rate',
  legendPrivateMemory: 'Private memory',
  legendManagedHeap: 'Managed heap',
  legendWorkingSet: 'Working set',
  legendGen0: 'gen0',
  legendGen1: 'gen1',
  legendGen2: 'gen2',
  buttonPause: 'Pause',
  buttonResume: 'Resume',
  buttonResetSelection: 'Reset selection',
  buttonBackToLive: 'Back to live data',
  archiveHint: 'Archive: an interval of {0}; the live charts no longer show it.',
  processNotSelected: 'No process selected',
  waitingForData: 'Waiting for data…',
  statusRunning: 'monitoring is running',
  statusConnecting: 'connecting…',
  statusStopped: 'monitoring stopped',
  statusFailed: 'monitoring failed',
  statusIdle: 'monitoring is not running',
  statusArchive: 'showing a saved interval',
  hintStart: 'Start debugging a .NET application or run the "Monitor Dotnet: Start Monitoring" command.',
  tileCpu: 'CPU',
  tilePrivateMemory: 'Private memory',
  tileManagedHeap: 'Managed heap',
  tileAllocation: 'Allocation rate',
  tileTimeInGc: 'Time in GC',
  tileThreads: 'Threads',
  tileGcCounts: 'GC collections gen0/gen1/gen2',
  summaryTitle: 'Selected range',
  summaryRange: 'Range',
  summaryPoints: 'Points',
  summaryCpu: 'CPU: min / avg / max',
  summaryPrivateMemory: 'Private memory: min / avg / max',
  summaryManagedHeap: 'Managed heap: min / avg / max',
  summaryGcCount: 'GC collections',
  summaryGcPause: 'Average GC pause',
  tooltipGc: 'GC gen{0}: {1}',
  issuesTitle: 'Detected issues',
  issuesHint: 'Click an issue to select its time range on the charts.',
  targetLabel: 'Process',
  targetSessions: 'Debug sessions',
  targetProcesses: 'Other .NET processes',
  targetEmpty: 'No .NET processes found',
};

/** Тексты по умолчанию (английские). */
export const DEFAULT_WEBVIEW_STRINGS: WebviewStrings = { ...WEBVIEW_SOURCE_STRINGS };

/**
 * Собирает локализованный набор текстов.
 * Переводчиком служит `vscode.l10n.t` — он возвращает исходную строку,
 * если перевода для текущего языка нет.
 */
export function buildWebviewStrings(
  translate: (message: string) => string,
): WebviewStrings {
  const result = {} as WebviewStrings;
  for (const [key, source] of Object.entries(WEBVIEW_SOURCE_STRINGS) as Array<[keyof WebviewStrings, string]>) {
    result[key] = translate(source);
  }

  return result;
}
