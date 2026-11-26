/**
 * Тексты графической панели снимка CPU.
 *
 * Внутри webview нет API локализации VS Code, поэтому строки переводит расширение
 * и присылает панели вместе с данными. Английские тексты служат ключами словаря
 * `l10n/bundle.l10n.<язык>.json`.
 */

/** Набор текстов панели снимка CPU. */
export interface CpuWebviewStrings {
  title: string;
  eyebrow: string;
  taken: string;
  source: string;
  metaSummary: string;
  tileDuration: string;
  tileSamples: string;
  tileMethods: string;
  tileTopMethod: string;
  tileBlocked: string;
  blockedHint: string;
  tileTotalDelta: string;
  sectionMethods: string;
  sectionMethodsSubtitle: string;
  sortExclusive: string;
  sortInclusive: string;
  columnMethod: string;
  columnStatus: string;
  columnExclusive: string;
  columnInclusive: string;
  columnSamples: string;
  filterMethods: string;
  noMatches: string;
  showingMethods: string;
  sectionTree: string;
  sectionTreeSubtitle: string;
  sectionFlame: string;
  sectionFlameSubtitle: string;
  flameAll: string;
  flameZoomHint: string;
  flameDepthLimit: string;
  frameSelf: string;
  comparisonTitle: string;
  comparisonSubtitle: string;
  before: string;
  after: string;
  columnBefore: string;
  columnAfter: string;
  columnDelta: string;
  columnDeltaInclusive: string;
  statusAdded: string;
  statusRemoved: string;
  statusChanged: string;
  noChanges: string;
  showingChanges: string;
  comparisonHint: string;
  openSpeedscope: string;
  revealFile: string;
  truncated: string;
  emptyProfile: string;
  samplesCount: string;
  selfLabel: string;
  inclusiveLabel: string;
  noFile: string;
  largerMethod: string;
  smallerMethod: string;
  showMore: string;
}

/** Английские тексты — они же ключи перевода. */
export const CPU_WEBVIEW_SOURCE_STRINGS: Record<keyof CpuWebviewStrings, string> = {
  title: 'CPU profile',
  eyebrow: 'CPU snapshot',
  taken: 'Snapshot taken: {0}',
  source: 'Source: {0}',
  metaSummary: '{0} samples · {1} methods',
  tileDuration: 'Sampled time',
  tileSamples: 'Samples',
  tileMethods: 'Methods',
  tileTopMethod: 'Hottest method',
  tileBlocked: 'Blocked (excluded)',
  blockedHint: 'Waiting and native time are left out of the CPU profile.',
  tileTotalDelta: 'Sampled time change',
  sectionMethods: 'Top methods',
  sectionMethodsSubtitle: 'Sorted by {0} CPU time. Exclusive time is the method itself; inclusive time includes the calls it makes.',
  sortExclusive: 'exclusive',
  sortInclusive: 'inclusive',
  columnMethod: 'Method',
  columnStatus: 'Change',
  columnExclusive: 'Exclusive',
  columnInclusive: 'Inclusive',
  columnSamples: 'Samples',
  filterMethods: 'Filter methods',
  noMatches: 'No matching methods.',
  showingMethods: 'Showing the first {0} of {1} methods.',
  sectionTree: 'Call tree',
  sectionTreeSubtitle: 'Hierarchy of the sampled stacks. The percentage is the share of all sampled CPU time.',
  sectionFlame: 'Flame graph',
  sectionFlameSubtitle: 'Bar width is inclusive CPU time. Click a frame to zoom into it.',
  flameAll: 'All samples',
  flameZoomHint: 'Click a frame to zoom. Use the breadcrumb to go back.',
  flameDepthLimit: 'The chart shows the first {0} levels.',
  frameSelf: 'self {0}',
  comparisonTitle: 'CPU snapshot comparison',
  comparisonSubtitle: 'Change in the share of CPU time between two snapshots, in percentage points.',
  before: 'Before',
  after: 'After',
  columnBefore: 'Before',
  columnAfter: 'After',
  columnDelta: 'Δ exclusive',
  columnDeltaInclusive: 'Δ inclusive',
  statusAdded: 'added',
  statusRemoved: 'removed',
  statusChanged: 'changed',
  noChanges: 'The snapshots have no differences.',
  showingChanges: 'Showing the first {0} of {1} changes.',
  comparisonHint: 'Positive values mean the method takes more CPU time in the newer snapshot.',
  openSpeedscope: 'Open in Speedscope',
  revealFile: 'Reveal file',
  truncated: 'Part of the call tree was cut off because the profile is very large.',
  emptyProfile: 'No CPU samples in this profile. Record a longer snapshot while the process is under load.',
  samplesCount: '{0} samples',
  selfLabel: 'self',
  inclusiveLabel: 'inclusive',
  noFile: 'No source file',
  largerMethod: 'Takes more CPU time',
  smallerMethod: 'Takes less CPU time',
  showMore: 'Show more',
};

/** Тексты по умолчанию: панель использует их, пока перевод не пришёл. */
export const DEFAULT_CPU_WEBVIEW_STRINGS: CpuWebviewStrings = { ...CPU_WEBVIEW_SOURCE_STRINGS };

/** Собирает локализованный набор текстов панели. */
export function buildCpuWebviewStrings(
  translate: (message: string) => string,
): CpuWebviewStrings {
  const result = {} as CpuWebviewStrings;
  for (const [key, source] of Object.entries(CPU_WEBVIEW_SOURCE_STRINGS) as Array<
    [keyof CpuWebviewStrings, string]
  >) {
    result[key] = translate(source);
  }

  return result;
}
