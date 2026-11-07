/**
 * Тексты графической панели разбора дампа.
 *
 * Внутри webview нет API локализации VS Code, поэтому строки переводит расширение
 * и присылает панели вместе с данными. Английские тексты служат ключами словаря
 * `l10n/bundle.l10n.<язык>.json`.
 */

/** Набор текстов панели дампа. */
export interface DumpWebviewStrings {
  title: string;
  taken: string;
  generated: string;
  sectionOverview: string;
  findingsTitle: string;
  findingsSubtitle: string;
  findingWarning: string;
  findingInfo: string;
  metricBySize: string;
  metricByCount: string;
  tileManagedHeap: string;
  tileObjects: string;
  tileTypes: string;
  tileGcCommitted: string;
  tileThreads: string;
  tileThreadPool: string;
  tileAsync: string;
  tileExceptions: string;
  tileSyncBlocks: string;
  tileFinalizable: string;
  chartHeapTitle: string;
  chartAsyncTitle: string;
  chartEmpty: string;
  heapSubtitle: string;
  filterHeap: string;
  noMatches: string;
  showingLargest: string;
  distributionTitle: string;
  otherTypes: string;
  type: string;
  count: string;
  size: string;
  share: string;
  allocated: string;
  committed: string;
  gcUsage: string;
  total: string;
  backgroundThreads: string;
  unstartedThreads: string;
  pendingThreads: string;
  deadThreads: string;
  cpuUtilization: string;
  workersBusy: string;
  workersIdle: string;
  workerMax: string;
  queue: string;
  asyncSubtitle: string;
  exceptionsSubtitle: string;
  generation: string;
  comparisonTitle: string;
  beforeLabel: string;
  afterLabel: string;
  typeChangesTitle: string;
  typeChangesSubtitle: string;
  changeSize: string;
  changeCount: string;
  detailsTitle: string;
  noOutput: string;
  filterRows: string;
  pageOf: string;
  previousPage: string;
  nextPage: string;
  collapseSection: string;
  expandSection: string;
  filterStacks: string;
  showRuntimeFrames: string;
  expandAll: string;
  collapseAll: string;
  threadFrames: string;
  noFrames: string;
  noStacks: string;
  exceptionType: string;
  exceptionInner: string;
  exceptionMessage: string;
  exceptionHresult: string;
  exceptionStack: string;
  openTextReport: string;
  truncated: string;
}

/** Английские тексты — они же ключи перевода. */
export const DUMP_WEBVIEW_SOURCE_STRINGS: Record<keyof DumpWebviewStrings, string> = {
  title: 'Memory dump analysis',
  taken: 'Dump taken: {0}',
  generated: 'Report created: {0}',
  sectionOverview: 'Overview',
  findingsTitle: 'What stands out',
  findingsSubtitle: 'Automatic checks over the parsed dump data.',
  findingWarning: 'Warning',
  findingInfo: 'Note',
  metricBySize: 'By size',
  metricByCount: 'By count',
  tileManagedHeap: 'Managed heap',
  tileObjects: 'Objects',
  tileTypes: 'Types',
  tileGcCommitted: 'GC committed',
  tileThreads: 'Threads',
  tileThreadPool: 'Thread pool',
  tileAsync: 'Async state machines',
  tileExceptions: 'Exceptions',
  tileSyncBlocks: 'Sync blocks',
  tileFinalizable: 'Finalization queue',
  chartHeapTitle: 'Heap by type',
  chartAsyncTitle: 'Async state machines by type',
  chartEmpty: 'No data for the chart',
  heapSubtitle: 'Objects: {0} · size: {1} · types: {2}',
  filterHeap: 'Filter types',
  noMatches: 'No matching types.',
  showingLargest: 'Showing the {0} largest types from dumpheap -stat.',
  distributionTitle: 'Heap composition',
  otherTypes: 'Other types',
  type: 'Type',
  count: 'Count',
  size: 'Size',
  share: 'Share',
  allocated: 'Allocated',
  committed: 'Committed',
  gcUsage: 'GC usage',
  total: 'Total',
  backgroundThreads: 'Background',
  unstartedThreads: 'Not started',
  pendingThreads: 'Pending',
  deadThreads: 'Dead',
  cpuUtilization: 'CPU utilization',
  workersBusy: 'Workers busy',
  workersIdle: 'Workers idle',
  workerMax: 'Max workers',
  queue: 'Queued work items',
  asyncSubtitle: '{0} async state machines on the heap.',
  exceptionsSubtitle: '{0} exception objects, {1} in total.',
  generation: 'Gen {0}',
  comparisonTitle: 'Dump comparison',
  beforeLabel: 'Before',
  afterLabel: 'After',
  typeChangesTitle: 'Type changes',
  typeChangesSubtitle: 'Types with the largest size change.',
  changeSize: 'Δ size',
  changeCount: 'Δ count',
  detailsTitle: 'Details',
  noOutput: 'No output for this command.',
  filterRows: 'Filter rows',
  pageOf: 'Page {0} of {1}',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  collapseSection: 'Collapse section',
  expandSection: 'Expand section',
  filterStacks: 'Filter threads or methods',
  showRuntimeFrames: 'Show runtime frames',
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  threadFrames: '{0} frames',
  noFrames: 'No managed frames.',
  noStacks: 'No managed stacks in the dump.',
  exceptionType: 'Exception type',
  exceptionInner: 'Inner exception',
  exceptionMessage: 'Message',
  exceptionHresult: 'HRESULT',
  exceptionStack: 'Stack',
  openTextReport: 'Open text report',
  truncated: 'Output shortened. Open the text report to see everything.',
};

/** Тексты по умолчанию: панель использует их, пока перевод не пришёл. */
export const DEFAULT_DUMP_WEBVIEW_STRINGS: DumpWebviewStrings = { ...DUMP_WEBVIEW_SOURCE_STRINGS };

/** Собирает локализованный набор текстов панели. */
export function buildDumpWebviewStrings(
  translate: (message: string) => string,
): DumpWebviewStrings {
  const result = {} as DumpWebviewStrings;
  for (const [key, source] of Object.entries(DUMP_WEBVIEW_SOURCE_STRINGS) as Array<
    [keyof DumpWebviewStrings, string]
  >) {
    result[key] = translate(source);
  }

  return result;
}
