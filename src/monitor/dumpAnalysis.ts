/**
 * Анализ дампов памяти SOS-командами `dotnet-dump analyze`.
 *
 * `dotnet-dump analyze <дамп> -c "<команда>" -c "exit"` выполняет команды без
 * интерактивной сессии, поэтому результат можно показать прямо в редакторе.
 * Наборы ниже закрывают типовые вопросы при разборе зависаний и утечек памяти:
 * потоки, куча, асинхронные операции, исключения, блокировки и финализацию.
 *
 * Модуль не зависит от API VS Code: его проверяют тесты.
 */

import { translate } from '../core/locale.ts';
import { formatBytes, formatPercent } from '../core/formatting.ts';

/** Набор SOS-команд для одного сценария анализа. */
export interface SosAnalysis {
  /** Стабильный идентификатор набора. */
  id: string;
  /** SOS-команды в порядке выполнения. */
  commands: readonly string[];
}

/** Наборы, которые предлагаются в списке выбора. */
export const SOS_ANALYSES: readonly SosAnalysis[] = [
  {
    id: 'overview',
    commands: ['clrthreads', 'eeheap -gc', 'dumpheap -stat', 'syncblk'],
  },
  {
    id: 'threads',
    commands: ['clrstack -all'],
  },
  {
    id: 'memory',
    commands: ['dumpheap -stat'],
  },
  {
    id: 'async',
    commands: ['dumpasync --stats', 'threadpool'],
  },
  {
    id: 'exceptions',
    commands: ['pe -nested', 'dumpheap -stat -type Exception'],
  },
  {
    id: 'locks',
    commands: ['syncblk'],
  },
  {
    id: 'finalizers',
    commands: ['finalizequeue', 'dumpheap -stat'],
  },
];

/** Название и подсказка набора для списка выбора. */
export interface SosAnalysisText {
  title: string;
  description: string;
}

/**
 * Тексты наборов. Каждая запись — функция: строки переводятся в момент показа,
 * когда язык интерфейса уже известен, а не при загрузке модуля.
 */
const ANALYSIS_TEXT: Record<string, () => SosAnalysisText> = {
  overview: () => ({
    title: translate('Overview'),
    description: translate('Threads, GC heap size, object statistics and locks'),
  }),
  threads: () => ({
    title: translate('Thread stacks'),
    description: translate('Managed call stacks of all threads'),
  }),
  memory: () => ({
    title: translate('Heap by type'),
    description: translate('Object count and size per type: look for leaks'),
  }),
  async: () => ({
    title: translate('Async and thread pool'),
    description: translate('Pending async operations and thread pool queues'),
  }),
  exceptions: () => ({
    title: translate('Exceptions'),
    description: translate('Last exception on each thread and exception objects in the heap'),
  }),
  locks: () => ({
    title: translate('Locks'),
    description: translate('Monitor sync blocks and threads waiting on locks'),
  }),
  finalizers: () => ({
    title: translate('Finalization queue'),
    description: translate('Objects waiting for the finalizer and the queue state'),
  }),
  custom: () => ({
    title: translate('Custom commands'),
    description: translate('Commands typed for this run'),
  }),
};

/** Название и подсказка набора: `undefined` для неизвестного идентификатора. */
export function analysisText(id: string): SosAnalysisText | undefined {
  return ANALYSIS_TEXT[id]?.();
}

/** Наборы, отмеченные в списке по умолчанию. */
export const DEFAULT_ANALYSIS_IDS: readonly string[] = ['overview'];

/** Сколько типов показывать в текстовой сводке. */
const HEAP_SUMMARY_LIMIT = 10;

/** Сколько крупнейших типов передавать графической панели. */
const REPORT_ENTRY_LIMIT = 20;

/** Находит набор по идентификатору. */
export function findAnalysis(id: string): SosAnalysis | undefined {
  return SOS_ANALYSES.find(analysis => analysis.id === id);
}

/**
 * Аргументы `dotnet-dump`: дамп, команды через `-c` и закрытие сессии.
 * Без `exit` инструмент ждёт ввода и не завершается, поэтому команда анализа
 * в неинтерактивном режиме всегда заканчивается ею.
 */
export function buildAnalyzeArgs(dumpFile: string, commands: readonly string[]): string[] {
  const args = ['analyze', dumpFile];
  for (const command of commands) {
    for (const line of commandsFromInput(command)) {
      args.push('-c', line);
    }
  }

  args.push('-c', 'exit');
  return args;
}

/**
 * Готовит команды из ручного ввода: по одной на строку.
 * Приглашение `>` убирается, чтобы команду можно было скопировать из вывода SOS.
 */
export function commandsFromInput(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map(normalizeSosCommand)
    .filter((command): command is string => command !== undefined);
}

/** Одна команда без пробелов по краям и без приглашения `>`. */
export function normalizeSosCommand(input: string): string | undefined {
  const trimmed = input.trim().replace(/^>\s*/, '').trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** Запись сводки кучи: тип, количество объектов и суммарный размер. */
export interface HeapStatEntry {
  typeName: string;
  count: number;
  size: number;
}

/** Сводка по выводу `dumpheap -stat`. */
export interface HeapStatSummary {
  totalCount: number;
  totalSize: number;
  entries: HeapStatEntry[];
}

/**
 * Разбирает строки `dumpheap -stat` вида `MT Count TotalSize Class Name`.
 * Запись `Free` пропускается: это свободное место в сегментах, а не объекты.
 */
export function parseHeapStatistics(output: string): HeapStatSummary | undefined {
  const byType = new Map<string, HeapStatEntry>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[0-9a-fA-F]{6,}\s+(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (match === null) {
      continue;
    }

    const typeName = match[3].trim();
    if (typeName.toLowerCase() === 'free') {
      continue;
    }

    const count = Number(match[1]);
    const size = Number(match[2]);
    const existing = byType.get(typeName);
    if (existing === undefined) {
      byType.set(typeName, { typeName, count, size });
    } else {
      // Один тип может встретиться в нескольких строках: складываем значения.
      existing.count += count;
      existing.size += size;
    }
  }

  if (byType.size === 0) {
    return undefined;
  }

  const entries = [...byType.values()].sort((left, right) => right.size - left.size);
  return {
    entries,
    totalCount: entries.reduce((sum, entry) => sum + entry.count, 0),
    totalSize: entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}

/**
 * Собирает отчёт: что запускали и что получили.
 * Если среди команд был `dumpheap -stat`, сверху добавляется сводка по типам:
 * по ней сразу видно, что занимает память, без чтения всего вывода.
 */
export function formatAnalysisReport(
  dumpFile: string,
  analyses: readonly SosAnalysis[],
  output: string | readonly string[],
  generatedAt: Date,
  options: DumpReportOptions = {},
): string {
  const outputs = typeof output === 'string' ? undefined : output;
  const combined = typeof output === 'string' ? output : output.join('\n');
  const commands = analyses.flatMap(analysis => analysis.commands);
  const lines = [
    translate('Memory dump analysis'),
    translate('Dump: {0}', dumpFile),
    ...(options.takenAt === undefined
      ? []
      : [translate('Dump taken: {0}', formatTimestamp(options.takenAt))]),
    translate('Report created: {0}', formatTimestamp(generatedAt)),
    '',
    translate('Commands:'),
    ...commands.map(command => `  ${command}`),
  ];

  if (commands.some(isHeapStatisticsCommand)) {
    // В общем выводе сессии ищем именно раздел `dumpheap -stat`: строки других
    // команд (например, `syncblk`) тоже содержат числа и адреса.
    const heapOutput = outputs === undefined
      ? extractCommandOutput(combined, /^>\s*dumpheap\b(?!.*-type\b).*-stat\b/i) ?? combined
      : outputs[analyses.findIndex(analysis => analysis.commands.some(isOverallHeapCommand))] ?? combined;
    const summary = parseHeapStatistics(heapOutput);
    if (summary !== undefined) {
      lines.push('', ...formatHeapSummary(summary));
    }
  }

  if (outputs === undefined) {
    lines.push('', translate('Output:'));
    lines.push(combined.trim().length > 0 ? combined.trimEnd() : translate('(no output)'));
  } else {
    for (const [index, analysis] of analyses.entries()) {
      const text = outputs[index] ?? '';
      const title = analysisText(analysis.id)?.title ?? analysis.id;
      lines.push('', `=== ${title} (${analysis.commands.join('; ')}) ===`);
      lines.push(text.trim().length > 0 ? text.trimEnd() : translate('(no output)'));
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Команда, по выводу которой строится сводка кучи. */
function isHeapStatisticsCommand(command: string): boolean {
  return /^dumpheap\b/i.test(command.trim()) && /(^|\s)-stat\b/i.test(command);
}

/**
 * Вывод одной команды из общего вывода сессии.
 * `dotnet-dump analyze` печатает приглашение `> команда` перед результатом,
 * поэтому раздел заканчивается на следующем приглашении.
 * `undefined` означает, что приглашений в выводе нет: разбирать придётся всё.
 */
export function extractCommandOutput(output: string, commandPattern: RegExp): string | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex(line => /^>/.test(line.trim()) && commandPattern.test(line.trim()));
  if (start === -1) {
    return undefined;
  }

  const rest = lines.slice(start + 1);
  const next = rest.findIndex(line => /^>/.test(line.trim()));
  return (next === -1 ? rest : rest.slice(0, next)).join('\n');
}

/** Один набор анализа в отчёте: команды и их суммарный вывод. */
export interface DumpReportSection {
  id: string;
  title: string;
  commands: readonly string[];
  output: string;
}

/** Метрика интерактивного блока: подписи уже переведены. */
export interface DumpMetricItem {
  label: string;
  value: string;
}

/** Колонка таблицы интерактивного блока. */
export interface DumpTableColumn {
  label: string;
  /** Числовая колонка: выравнивание вправо и табличные цифры. */
  numeric?: boolean;
  /** Как показывать числа: байты или количество. */
  format?: 'bytes' | 'count';
  /** Широкая колонка с именем типа. */
  wide?: boolean;
}

/** Строка таблицы интерактивного блока. */
export interface DumpTableRow {
  /** Текст или число: числа панель форматирует по локали. */
  cells: Array<string | number>;
  /** Доля для полосы в дополнительной колонке, проценты. */
  share?: number;
}

/** Таблица интерактивного блока. */
export interface DumpTableBlock {
  kind: 'table';
  columns: DumpTableColumn[];
  rows: DumpTableRow[];
  /** Показывать колонку с полосой доли. */
  showShare?: boolean;
  /** Текст, если строк нет. */
  empty?: string;
  /** Пояснение под таблицей. */
  note?: string;
  /** Подсказка фильтра: если задана, над таблицей есть поле поиска. */
  filterPlaceholder?: string;
}

/** Кадр управляемого стека. */
export interface DumpStackFrame {
  method: string;
  /** Файл и строка, если они есть в выводе. */
  location?: string;
  /** Кадр рантайма: System.*, Microsoft.* и служебные фреймы. */
  system: boolean;
}

/** Управляемый стек одного потока из `clrstack -all`. */
export interface DumpThreadStack {
  osId: string;
  /** Идентификатор управляемого потока, если инструмент его печатает. */
  id?: number;
  frames: DumpStackFrame[];
}

/** Строка таблицы потоков из `clrthreads`. */
export interface DumpThreadRow {
  debugId: number;
  id: number;
  osId: string;
  state: string;
  gcMode: string;
  lockCount: number;
  kind?: string;
}

/** Занятый SyncBlock из `syncblk`. */
export interface DumpSyncBlock {
  index: number;
  monitorHeld: number;
  recursion: number;
  osId?: string;
  typeName?: string;
}

/** Итоги таблицы `syncblk`. */
export interface DumpSyncBlockTotals {
  total?: number;
  free?: number;
}

/** Сегмент кучи из `eeheap -gc`: поколение, LOH, POH или NonGC. */
export interface DumpGcSegment {
  /** Подпись: «Gen 0», «Large object heap» и т.п. */
  label: string;
  allocated: number;
  committed: number;
}

/** Разобранное исключение из `pe`. */
export interface DumpExceptionInfo {
  address?: string;
  typeName?: string;
  message?: string;
  inner?: string;
  hresult?: string;
  frames: DumpStackFrame[];
}

/** Объекты очереди финализации, сгруппированные по методу-таблице. */
export interface DumpFinalizableType {
  methodTable: string;
  /** Имя типа из `dumpheap -stat`, если тот был в том же запуске. */
  typeName?: string;
  count: number;
  size: number;
}

/** Сегмент полосы состава. */
export interface DumpBarSegment {
  label: string;
  value: number;
}

/** Интерактивное представление набора команд. */
export type DumpSectionBlock =
  | { kind: 'metrics'; items: DumpMetricItem[] }
  | { kind: 'meter'; label: string; value: string; fraction: number }
  | DumpTableBlock
  | { kind: 'heapTypes'; heap: HeapStatSummary; typeCount: number }
  | { kind: 'stacks'; threads: DumpThreadStack[] }
  | { kind: 'bar'; segments: DumpBarSegment[]; unit: 'bytes' | 'count'; note?: string }
  | { kind: 'exceptions'; entries: DumpExceptionInfo[]; empty?: string };

/**
 * Интерактивный вид по одной команде. Одна команда — одна панель наверху:
 * поэтому при выборе нескольких наборов одинаковые команды не повторяются.
 */
export interface DumpView {
  command: string;
  /** Заголовок панели (уже переведён). */
  title: string;
  blocks: DumpSectionBlock[];
}

/** Асинхронные state machine одного типа. */
export interface AsyncStatEntry {
  typeName: string;
  count: number;
}

/** Сводка по выводу `dumpasync --stats`. */
export interface AsyncStatSummary {
  total: number;
  entries: AsyncStatEntry[];
}

/** Сводка управляемых потоков из `clrthreads`. */
export interface ThreadSummary {
  total: number;
  background?: number;
  unstarted?: number;
  pending?: number;
  dead?: number;
}

/** Сводка пула потоков из `threadpool`. */
export interface ThreadPoolSummary {
  cpuUtilization?: number;
  workersTotal?: number;
  workersRunning?: number;
  workersIdle?: number;
  workerMaxLimit?: number;
  workItems?: number;
}

/** Размер кучи GC из `eeheap -gc`. */
export interface GcHeapSummary {
  allocated?: number;
  committed?: number;
}

/** Очередь финализации по поколениям из `finalizequeue`. */
export interface FinalizableSummary {
  total: number;
  byGeneration: number[];
}

/** Важность наблюдения: подсказка или предупреждение. */
export type DumpFindingLevel = 'info' | 'warning';

/** Автоматическое наблюдение по разобранным данным дампа. */
export interface DumpFinding {
  level: DumpFindingLevel;
  title: string;
  detail: string;
}

/** Разобранные факты дампа: основа и для панели, и для наблюдений. */
export interface DumpFacts {
  heap?: HeapStatSummary;
  gcHeap?: GcHeapSummary;
  async?: AsyncStatSummary;
  exceptions?: HeapStatSummary;
  threads?: ThreadSummary;
  threadPool?: ThreadPoolSummary;
  syncBlockCount?: number;
  finalizable?: FinalizableSummary;
}

/**
 * Готовые данные для графической панели.
 * В `heap` и `async` попадают только крупнейшие записи, а итоги считаются по всем.
 */
export interface DumpReport {
  /** Заголовок отчёта: у снимка памяти он свой, у дампа — общий. */
  title?: string;
  /** Что разбирали: дамп памяти или снимок GCDump. */
  source?: 'dump' | 'gcdump';
  dumpFile: string;
  /** Когда создан отчёт (а не когда снят дамп). */
  generatedAt: string;
  /** Когда снят дамп: время изменения файла, точнее из файла узнать нельзя. */
  takenAt?: string;
  /** Размер файла дампа в байтах. */
  dumpBytes?: number;
  sections: DumpReportSection[];
  /** Интерактивные панели: по одной на уникальную команду выбранных наборов. */
  views?: DumpView[];
  heap?: HeapStatSummary;
  /** Сколько всего типов в куче: `heap.entries` содержит только крупнейшие. */
  typeCount?: number;
  gcHeap?: GcHeapSummary;
  async?: AsyncStatSummary;
  exceptions?: HeapStatSummary;
  threads?: ThreadSummary;
  threadPool?: ThreadPoolSummary;
  syncBlockCount?: number;
  finalizable?: FinalizableSummary;
  /** Наблюдения, на которые стоит обратить внимание при разборе. */
  findings: DumpFinding[];
}

/** Раздел вывода сессии: команда и её результат. */
export interface SessionSection {
  command: string;
  output: string;
}

/**
 * Делит вывод сессии `dotnet-dump analyze` на разделы по приглашениям `> команда`.
 * Пустой список означает, что приглашений в выводе нет.
 */
export function splitSessionOutput(output: string): SessionSection[] {
  const sections: Array<{ command: string; lines: string[] }> = [];
  let current: { command: string; lines: string[] } | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (/^>/.test(line.trim())) {
      current = { command: line.trim().replace(/^>\s*/, ''), lines: [] };
      sections.push(current);
      continue;
    }

    if (current !== undefined) {
      current.lines.push(line);
    }
  }

  return sections
    .map(section => ({ command: section.command, output: section.lines.join('\n').trim() }))
    .filter(section => section.command.length > 0);
}

/** Число из первой подходящей строки вывода. */
function readNumber(output: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(output);
  return match === null ? undefined : Number(match[1].replaceAll(',', ''));
}

/** Управляемые потоки из вывода `clrthreads`. */
export function parseThreadCount(output: string): number | undefined {
  return readNumber(output, /^\s*ThreadCount:\s+([\d,]+)/m);
}

/** Подробная сводка потоков: всего, фоновые, незапущенные, мёртвые. */
export function parseThreadSummary(output: string): ThreadSummary | undefined {
  const total = parseThreadCount(output);
  if (total === undefined) {
    return undefined;
  }

  return {
    total,
    background: readNumber(output, /^\s*BackgroundThread:\s+([\d,]+)/m),
    unstarted: readNumber(output, /^\s*UnstartedThread:\s+([\d,]+)/m),
    pending: readNumber(output, /^\s*PendingThread:\s+([\d,]+)/m),
    dead: readNumber(output, /^\s*DeadThread:\s+([\d,]+)/m),
  };
}

/** Сводка пула потоков из `threadpool`. */
export function parseThreadPoolSummary(output: string): ThreadPoolSummary | undefined {
  const summary: ThreadPoolSummary = {
    cpuUtilization: readNumber(output, /^CPU utilization:\s*([\d,.]+)\s*%/m),
    workersTotal: readNumber(output, /^Workers Total:\s*([\d,]+)/m),
    workersRunning: readNumber(output, /^Workers Running:\s*([\d,]+)/m),
    workersIdle: readNumber(output, /^Workers Idle:\s*([\d,]+)/m),
    workerMaxLimit: readNumber(output, /^Worker Max Limit:\s*([\d,]+)/m),
    workItems: readNumber(output, /^Work Request in Queue:\s*([\d,]+)/m),
  };

  return Object.values(summary).some(value => value !== undefined) ? summary : undefined;
}

/** Занятая и зарезервированная память кучи GC из `eeheap -gc`. */
export function parseGcHeapSummary(output: string): GcHeapSummary | undefined {
  const summary: GcHeapSummary = {
    allocated: readNumber(output, /^GC Allocated Heap Size:\s+Size:\s+0x[0-9a-fA-F]+\s+\((\d+)\)/m),
    committed: readNumber(output, /^GC Committed Heap Size:\s+Size:\s+0x[0-9a-fA-F]+\s+\((\d+)\)/m),
  };

  return summary.allocated === undefined && summary.committed === undefined ? undefined : summary;
}

/**
 * Асинхронные state machine из вывода `dumpasync --stats`.
 * Строки таблицы имеют вид «MT Count Type»; Count может быть с разделителями разрядов.
 */
export function parseAsyncStatistics(output: string): AsyncStatSummary | undefined {
  const entries: AsyncStatEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[0-9a-fA-F]{6,16}\s+([\d,]+)\s+(\S.*)$/.exec(line);
    if (match === null) {
      continue;
    }

    entries.push({ typeName: match[2].trim(), count: Number(match[1].replaceAll(',', '')) });
  }

  if (entries.length === 0) {
    return undefined;
  }

  return {
    entries: [...entries].sort((left, right) => right.count - left.count),
    total: entries.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/** Очередь финализации по поколениям из вывода `finalizequeue`. */
export function parseFinalizableSummary(output: string): FinalizableSummary | undefined {
  const byGeneration: number[] = [];
  // В разных версиях SOS строка выглядит как «generation 0 has 62 objects»
  // или «generation 0 has 3 finalizable objects».
  for (const match of output.matchAll(/generation\s+(\d+)\s+has\s+([\d,]+)\s+(?:finalizable\s+)?objects/gi)) {
    const generation = Number(match[1]);
    byGeneration[generation] = Number(match[2].replaceAll(',', ''));
  }

  if (byGeneration.length === 0) {
    return undefined;
  }

  const filled = Array.from({ length: byGeneration.length }, (_, index) => byGeneration[index] ?? 0);
  return {
    total: filled.reduce((sum, count) => sum + count, 0),
    byGeneration: filled,
  };
}

/** Число SyncBlock из вывода `syncblk`: строка «Total N» внизу таблицы. */
export function parseSyncBlockCount(output: string): number | undefined {
  return readNumber(output, /^\s*Total\s+([\d,]+)\s*$/m);
}

/**
 * Строки таблицы потоков `clrthreads`.
 * Формат: DBG ID OSID ThreadOBJ State GC-Mode GC-Alloc-Context Domain Lock-Count Apt [Kind].
 */
export function parseThreadRows(output: string): DumpThreadRow[] {
  const rows: DumpThreadRow[] = [];
  const pattern = /^\s*(\d+)\s+(\d+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+(\S+)\s+([0-9a-fA-F]+:[0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+(-?\d+)\s+(\S+)(?:\s+(.*))?$/;
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match === null) {
      continue;
    }

    const kind = match[11]?.trim();
    rows.push({
      debugId: Number(match[1]),
      id: Number(match[2]),
      osId: `0x${match[3]}`,
      state: match[5],
      gcMode: match[6],
      lockCount: Number(match[9]),
      ...(kind === undefined || kind.length === 0 ? {} : { kind }),
    });
  }

  return rows;
}

/** Разбирает текст кадра: метод, файл со строкой и признак кадра рантайма. */
function parseFrameText(text: string): DumpStackFrame | undefined {
  let rest = text.trim();
  if (rest.length === 0) {
    return undefined;
  }

  // Служебные кадры печатаются в квадратных скобках, иногда с методом после них.
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end >= 0) {
      const helper = rest.slice(0, end + 1);
      const after = rest.slice(end + 1).trim();
      if (after.length === 0) {
        return { method: helper, system: true };
      }

      rest = after;
    }
  }

  const located = /^(.*?)\s+\[(.*)\]$/.exec(rest);
  const method = (located?.[1] ?? rest).trim();
  const location = located?.[2]?.trim();
  if (method.length === 0) {
    return undefined;
  }

  return {
    method,
    ...(location === undefined || location.length === 0 ? {} : { location }),
    system: isRuntimeMethod(method),
  };
}

/** Кадр относится к рантайму, а не к коду приложения. */
function isRuntimeMethod(method: string): boolean {
  return method.startsWith('[')
    || /^(System|Microsoft|Internal\.Runtime|Interop|WinRT|netstandard)\./.test(method);
}

/** Стеки всех потоков из `clrstack -all`. */
export function parseThreadStacks(output: string): DumpThreadStack[] {
  const threads: DumpThreadStack[] = [];
  let current: DumpThreadStack | undefined;

  for (const line of output.split(/\r?\n/)) {
    const header = /^OS Thread Id:\s*0x([0-9a-fA-F]+)(?:\s+\((\d+)\))?/.exec(line);
    if (header !== null) {
      current = {
        osId: `0x${header[1]}`,
        ...(header[2] === undefined ? {} : { id: Number(header[2]) }),
        frames: [],
      };
      threads.push(current);
      continue;
    }

    if (current === undefined || /^\s*Child SP\s+IP\s+Call Site/.test(line)) {
      continue;
    }

    const frame = /^\s*[0-9a-fA-F]{8,}\s+[0-9a-fA-F]{8,}\s*(.*)$/.exec(line);
    if (frame === null) {
      continue;
    }

    const parsed = parseFrameText(frame[1]);
    if (parsed !== undefined) {
      current.frames.push(parsed);
    }
  }

  return threads;
}

/** Занятые SyncBlock и итоги из `syncblk`. */
export function parseSyncBlocks(output: string): { rows: DumpSyncBlock[]; totals: DumpSyncBlockTotals } {
  const rows: DumpSyncBlock[] = [];
  const pattern = /^\s*(\d+)\s+([0-9a-fA-F`]+)\s+(\d+)\s+(\d+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+(\d+)\s+([0-9a-fA-F]+)\s+(.+)$/;
  let inTable = false;

  for (const line of output.split(/\r?\n/)) {
    if (/SyncBlock\s+MonitorHeld/.test(line)) {
      inTable = true;
      continue;
    }

    if (!inTable || /^\s*Free\b/i.test(line)) {
      continue;
    }

    if (/^\s*-{5,}/.test(line) || /^\s*Total\b/i.test(line)) {
      inTable = false;
      continue;
    }

    const match = pattern.exec(line);
    if (match === null) {
      continue;
    }

    const osId = `0x${match[6]}`;
    const typeName = match[9].trim();
    rows.push({
      index: Number(match[1]),
      monitorHeld: Number(match[3]),
      recursion: Number(match[4]),
      osId,
      ...(typeName.length === 0 ? {} : { typeName }),
    });
  }

  return {
    rows,
    totals: {
      total: readNumber(output, /^\s*Total\s+([\d,]+)\s*$/m),
      free: readNumber(output, /^\s*Free\s+([\d,]+)\s*$/m),
    },
  };
}

/** Сегменты кучи из `eeheap -gc`: поколения, LOH, POH и NonGC. */
export function parseGcSegments(output: string): { segments: DumpGcSegment[]; heapCount?: number } {
  const sums = new Map<string, { allocated: number; committed: number }>();
  let section: 'soh' | 'loh' | 'poh' | 'nonGc' | undefined;
  let generation: number | undefined;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^Small object heap/i.test(trimmed)) {
      section = 'soh';
      generation = undefined;
      continue;
    }

    if (/^Large object heap/i.test(trimmed)) {
      section = 'loh';
      generation = undefined;
      continue;
    }

    if (/^Pinned object heap/i.test(trimmed)) {
      section = 'poh';
      generation = undefined;
      continue;
    }

    if (/^NonGC heap/i.test(trimmed)) {
      section = 'nonGc';
      generation = undefined;
      continue;
    }

    const generationLine = /^generation\s+(\d+):/i.exec(trimmed);
    if (generationLine !== null) {
      generation = Number(generationLine[1]);
      continue;
    }

    // Строка сегмента: четыре адреса и две пары «0x… (размер)».
    const data = /^\s*(?:[0-9a-fA-F]{4,}\s+){4}(.*)$/.exec(line);
    if (data === null) {
      continue;
    }

    const sizes = [...data[1].matchAll(/\((\d+)\)/g)].map(match => Number(match[1]));
    if (sizes.length === 0) {
      continue;
    }

    let key: string | undefined;
    if (section === 'soh' && generation !== undefined) {
      key = `gen${generation}`;
    } else if (section === 'loh' || section === 'poh' || section === 'nonGc') {
      key = section;
    }

    if (key === undefined) {
      continue;
    }

    // У поколения 2 занятая часть может отсутствовать: тогда есть только committed.
    const allocated = sizes.length >= 2 ? sizes[0] : 0;
    const committed = sizes[sizes.length - 1];
    const current = sums.get(key) ?? { allocated: 0, committed: 0 };
    current.allocated += allocated;
    current.committed += committed;
    sums.set(key, current);
    generation = undefined;
  }

  const labels: Array<[string, string]> = [
    ['gen0', translate('Gen {0}', 0)],
    ['gen1', translate('Gen {0}', 1)],
    ['gen2', translate('Gen {0}', 2)],
    ['loh', translate('Large object heap')],
    ['poh', translate('Pinned object heap')],
    ['nonGc', translate('Non-GC heap')],
  ];

  const segments: DumpGcSegment[] = [];
  for (const [key, label] of labels) {
    const sum = sums.get(key);
    if (sum !== undefined && (sum.allocated > 0 || sum.committed > 0)) {
      segments.push({ label, ...sum });
    }
  }

  return {
    segments,
    heapCount: readNumber(output, /Number of GC Heaps:\s+(\d+)/),
  };
}

/** Разобранные исключения из `pe`: объект, тип, сообщение, HRESULT и стек. */
export function parseExceptionInfo(output: string): DumpExceptionInfo[] {
  const entries: DumpExceptionInfo[] = [];
  let current: DumpExceptionInfo | undefined;
  let messageLines: string[] = [];
  let inStack = false;

  const flushMessage = (): void => {
    if (current !== undefined && current.message === undefined && messageLines.length > 0) {
      current.message = messageLines.join('\n').trim();
    }

    messageLines = [];
  };

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const objectMatch = /^\s*Exception object:\s*(\S+)/.exec(line);
    if (objectMatch !== null) {
      flushMessage();
      current = { address: objectMatch[1], frames: [] };
      entries.push(current);
      inStack = false;
      continue;
    }

    const typeMatch = /^\s*Exception type:\s*(.+)$/.exec(line);
    if (typeMatch !== null) {
      flushMessage();
      if (current === undefined) {
        current = { frames: [] };
        entries.push(current);
      }

      current.typeName = typeMatch[1].trim();
      inStack = false;
      continue;
    }

    if (current === undefined) {
      continue;
    }

    const messageMatch = /^\s*Message:\s?(.*)$/.exec(line);
    if (messageMatch !== null) {
      flushMessage();
      messageLines = [messageMatch[1]];
      inStack = false;
      continue;
    }

    const innerMatch = /^\s*InnerException:\s*(.*)$/.exec(line);
    if (innerMatch !== null) {
      flushMessage();
      current.inner = innerMatch[1].trim();
      inStack = false;
      continue;
    }

    const hresultMatch = /^\s*HResult:\s*(\S+)/.exec(line);
    if (hresultMatch !== null) {
      flushMessage();
      current.hresult = hresultMatch[1];
      inStack = false;
      continue;
    }

    if (/^\s*StackTrace (?:\(generated\))?:/.test(line) || /^\s*StackTraceString:/.test(line)) {
      flushMessage();
      inStack = true;
      continue;
    }

    if (inStack) {
      if (line.trim().length === 0) {
        inStack = false;
        continue;
      }

      const frame = /^\s*[0-9a-fA-F]{8,}\s+[0-9a-fA-F]{8,}\s*(.*)$/.exec(line);
      if (frame !== null) {
        const parsed = parseFrameText(frame[1]);
        if (parsed !== undefined) {
          current.frames.push(parsed);
        }
      }

      continue;
    }

    if (messageLines.length > 0) {
      messageLines.push(line);
    }
  }

  flushMessage();
  return entries;
}

/** Сколько объектов уже готово к финализации. */
export function parseFinalizableReady(output: string): number | undefined {
  return readNumber(output, /Ready for finalization\s+([\d,]+)\s+objects/i);
}

/**
 * Объекты финализации, сгруппированные по методу-таблице.
 * SOS печатает их списком «адрес MT размер», поэтому без `dumpheap -stat`
 * тип определить нельзя: в этом случае в таблице остаётся только MT.
 */
export function parseFinalizableTypes(
  output: string,
  typeNames?: ReadonlyMap<string, string>,
): DumpFinalizableType[] {
  const byMethodTable = new Map<string, DumpFinalizableType>();
  let inStatistics = false;

  for (const line of output.split(/\r?\n/)) {
    if (/Statistics for all finalizable objects/i.test(line)) {
      inStatistics = true;
      continue;
    }

    if (!inStatistics) {
      continue;
    }

    const match = /^\s*[0-9a-fA-F]{8,}\s+([0-9a-fA-F]{8,})\s+(\d+)\s*$/.exec(line);
    if (match === null) {
      // Таблица закончилась на непустой строке, которая не является её продолжением.
      if (line.trim().length > 0 && /^\S/.test(line)) {
        inStatistics = false;
      }

      continue;
    }

    const methodTable = match[1].toLowerCase();
    const size = Number(match[2]);
    const typeName = typeNames?.get(methodTable);
    const existing = byMethodTable.get(methodTable);
    if (existing === undefined) {
      byMethodTable.set(methodTable, {
        methodTable,
        ...(typeName === undefined ? {} : { typeName }),
        count: 1,
        size,
      });
    } else {
      existing.count += 1;
      existing.size += size;
    }
  }

  return [...byMethodTable.values()].sort((left, right) => right.size - left.size);
}

/** Таблица «MT → имя типа» из вывода `dumpheap -stat`. */
export function parseHeapTypeMap(output: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*([0-9a-fA-F]{6,16})\s+(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (match === null) {
      continue;
    }

    const typeName = match[4].trim();
    if (typeName.toLowerCase() !== 'free') {
      names.set(match[1].toLowerCase(), typeName);
    }
  }

  return names;
}

/** Общая статистика кучи: `dumpheap -stat` без фильтра по типу. */
function isOverallHeapCommand(command: string): boolean {
  const trimmed = command.trim();
  return isHeapStatisticsCommand(trimmed) && !/(^|\s)-type\b/i.test(trimmed);
}

/**
 * Наблюдения по разобранным данным: что в дампе выглядит подозрительно.
 * Пороги намеренно простые — это подсказки, а не приговор.
 */
export function buildFindings(facts: DumpFacts): DumpFinding[] {
  const findings: DumpFinding[] = [];
  const heap = facts.heap;

  if (heap !== undefined && heap.totalSize > 0 && heap.entries.length > 0) {
    const top = heap.entries[0];
    const share = (size: number): string => formatPercent((size / heap.totalSize) * 100);

    if (top.size / heap.totalSize >= 0.5) {
      findings.push({
        level: 'info',
        title: translate('One type dominates the heap'),
        detail: translate('{0} takes {1} of the managed heap.', top.typeName, share(top.size)),
      });
    }

    const bytes = heap.entries.find(entry => entry.typeName === 'System.Byte[]');
    if (bytes !== undefined && bytes.size / heap.totalSize >= 0.3) {
      findings.push({
        level: 'warning',
        title: translate('Large byte arrays'),
        detail: translate('System.Byte[] takes {0} of the managed heap.', share(bytes.size)),
      });
    }

    const strings = heap.entries.find(entry => entry.typeName === 'System.String');
    if (strings !== undefined && strings.size / heap.totalSize >= 0.4) {
      findings.push({
        level: 'info',
        title: translate('Many strings on the heap'),
        detail: translate('System.String takes {0} of the managed heap.', share(strings.size)),
      });
    }
  }

  const gcHeap = facts.gcHeap;
  if (gcHeap?.allocated !== undefined && gcHeap.committed !== undefined && gcHeap.committed > 0) {
    const unused = gcHeap.committed - gcHeap.allocated;
    if (unused > 0 && unused / gcHeap.committed >= 0.25 && gcHeap.committed >= 32 * 1024 * 1024) {
      findings.push({
        level: 'info',
        title: translate('GC heap reserves more memory than it uses'),
        detail: translate('Committed {0}, live objects {1}.', formatBytes(gcHeap.committed), formatBytes(gcHeap.allocated)),
      });
    }
  }

  if (facts.threads !== undefined && facts.threads.total >= 100) {
    findings.push({
      level: 'info',
      title: translate('Many managed threads'),
      detail: translate('{0} managed threads in the dump.', facts.threads.total),
    });
  }

  if (facts.threadPool?.workItems !== undefined && facts.threadPool.workItems >= 100) {
    findings.push({
      level: 'warning',
      title: translate('Thread pool queue is growing'),
      detail: translate('{0} work items are waiting in the thread pool queue.', facts.threadPool.workItems),
    });
  }

  if (facts.async !== undefined && facts.async.total >= 1000) {
    findings.push({
      level: 'warning',
      title: translate('Many pending async state machines'),
      detail: translate('{0} async state machines are alive — possible async leak.', facts.async.total),
    });
  }

  if (facts.exceptions !== undefined && facts.exceptions.totalCount >= 1000) {
    findings.push({
      level: 'warning',
      title: translate('Many exception objects'),
      detail: translate('{0} objects derived from Exception are on the heap.', facts.exceptions.totalCount),
    });
  }

  if (facts.syncBlockCount !== undefined && facts.syncBlockCount >= 100) {
    findings.push({
      level: 'info',
      title: translate('Lock contention'),
      detail: translate('{0} sync blocks are in use — check threads waiting on locks.', facts.syncBlockCount),
    });
  }

  if (facts.finalizable !== undefined && facts.finalizable.total >= 1000) {
    findings.push({
      level: 'warning',
      title: translate('Large finalization queue'),
      detail: translate('{0} objects are waiting for finalization.', facts.finalizable.total),
    });
  }

  return findings;
}

/** Дополнительные сведения о файле дампа. */
export interface DumpReportOptions {
  takenAt?: Date;
  dumpBytes?: number;
}

/** Разобранная сессия: разделы вывода и факты. */
interface SessionAnalysis {
  sections: DumpReportSection[];
  facts: DumpFacts;
}

/** Делит вывод на разделы и разбирает факты. */
function analyzeSession(analyses: readonly SosAnalysis[], output: string): SessionAnalysis {
  const session = splitSessionOutput(output);
  const used = new Set<number>();

  const sections: DumpReportSection[] = analyses.map(analysis => {
    const parts: string[] = [];
    for (const command of analysis.commands) {
      const index = session.findIndex((section, position) =>
        !used.has(position) && section.command === command.trim());
      if (index >= 0) {
        used.add(index);
        parts.push(session[index].output);
      }
    }

    return {
      id: analysis.id,
      title: analysisText(analysis.id)?.title ?? analysis.id,
      commands: analysis.commands,
      output: parts.join('\n').trim(),
    };
  });

  // Другая версия инструмента может не печатать приглашения: отдаём весь вывод первому набору.
  if (used.size === 0 && sections.length > 0) {
    sections[0] = { ...sections[0], output: output.trim() };
  }

  const find = (predicate: (command: string) => boolean): SessionSection | undefined =>
    session.find(section => predicate(section.command));

  // Без приглашений в выводе (другая версия инструмента) разбираем весь вывод.
  const outputOf = (predicate: (command: string) => boolean): string | undefined =>
    find(predicate)?.output ?? (session.length === 0 ? output : undefined);

  const heap = parseHeapStatistics(outputOf(isOverallHeapCommand) ?? '');
  const exceptionOutput = outputOf(command =>
    /^dumpheap\b/i.test(command) && /(^|\s)-type\b/i.test(command));
  const exceptions = exceptionOutput === undefined ? undefined : parseHeapStatistics(exceptionOutput);

  return {
    sections,
    facts: {
      heap,
      gcHeap: parseGcHeapSummary(outputOf(command => /^eeheap\b.*-gc\b/i.test(command)) ?? ''),
      async: parseAsyncStatistics(outputOf(command => /^dumpasync\b.*--stats\b/i.test(command)) ?? ''),
      exceptions,
      threads: parseThreadSummary(outputOf(command => /^clrthreads\b/i.test(command)) ?? ''),
      threadPool: parseThreadPoolSummary(outputOf(command => /^threadpool\b/i.test(command)) ?? ''),
      syncBlockCount: parseSyncBlockCount(outputOf(command => /^syncblk\b/i.test(command)) ?? ''),
      finalizable: parseFinalizableSummary(outputOf(command => /^finalizequeue\b/i.test(command)) ?? ''),
    },
  };
}

/**
 * Строит блоки для команд одного запуска. Разбор идёт по тому же тексту,
 * что показан в «Деталях», поэтому работает и для одного набора, и для общего вывода.
 */
function blocksForCommands(
  analysisId: string,
  commands: readonly string[],
  output: string,
): DumpSectionBlock[] {
  const blocks: DumpSectionBlock[] = [];

  for (const command of commands) {
    const trimmed = command.trim();
    if (/^clrthreads\b/i.test(trimmed)) {
      const rows = parseThreadRows(output);
      if (rows.length > 0) {
        blocks.push({
          kind: 'table',
          columns: [
            { label: translate('ID'), numeric: true, format: 'count' },
            { label: translate('OS thread'), numeric: true },
            { label: translate('State') },
            { label: translate('GC mode') },
            { label: translate('Locks'), numeric: true, format: 'count' },
            { label: translate('Kind') },
          ],
          rows: rows.map(row => ({
            cells: [row.id, row.osId, row.state, row.gcMode, row.lockCount, row.kind ?? ''],
          })),
          filterPlaceholder: translate('Filter threads'),
        });
      }

      continue;
    }

    if (/^eeheap\b.*-gc\b/i.test(trimmed)) {
      const parsed = parseGcSegments(output);
      if (parsed.segments.length > 0) {
        const allocated = parsed.segments.reduce((sum, segment) => sum + segment.allocated, 0);
        const committed = parsed.segments.reduce((sum, segment) => sum + segment.committed, 0);
        const items: DumpMetricItem[] = [
          { label: translate('Allocated'), value: formatBytes(allocated) },
          { label: translate('Committed'), value: formatBytes(committed) },
        ];
        if (parsed.heapCount !== undefined) {
          items.push({ label: translate('GC heaps'), value: String(parsed.heapCount) });
        }

        blocks.push({ kind: 'metrics', items });
        blocks.push({
          kind: 'bar',
          unit: 'bytes',
          segments: parsed.segments.map(segment => ({ label: segment.label, value: segment.allocated })),
        });
        blocks.push({
          kind: 'table',
          columns: [
            { label: translate('Segment'), wide: true },
            { label: translate('Allocated'), numeric: true, format: 'bytes' },
            { label: translate('Committed'), numeric: true, format: 'bytes' },
          ],
          rows: parsed.segments.map(segment => ({
            cells: [segment.label, segment.allocated, segment.committed],
            share: allocated === 0 ? 0 : (segment.allocated / allocated) * 100,
          })),
          showShare: true,
        });
      }

      continue;
    }

    if (isHeapStatisticsCommand(trimmed)) {
      const heap = parseHeapStatistics(output);
      if (heap !== undefined) {
        if (/(^|\s)-type\b/i.test(trimmed)) {
          blocks.push({
            kind: 'table',
            columns: [
              { label: translate('Type'), wide: true },
              { label: translate('Count'), numeric: true, format: 'count' },
              { label: translate('Size'), numeric: true, format: 'bytes' },
            ],
            rows: heap.entries.map(entry => ({
              cells: [entry.typeName, entry.count, entry.size],
              share: heap.totalSize === 0 ? 0 : (entry.size / heap.totalSize) * 100,
            })),
            showShare: true,
            filterPlaceholder: translate('Filter types'),
          });
        } else if (analysisId === 'finalizers') {
          // В наборе финализации `dumpheap -stat` нужен только для имён типов:
          // отдельная таблица кучи здесь была бы дублем верхней панели.
        } else {
          blocks.push({ kind: 'heapTypes', heap, typeCount: heap.entries.length });
        }
      }

      continue;
    }

    if (/^syncblk\b/i.test(trimmed)) {
      const parsed = parseSyncBlocks(output);
      const items: DumpMetricItem[] = [];
      if (parsed.totals.total !== undefined) {
        items.push({ label: translate('Total'), value: String(parsed.totals.total) });
      }

      if (parsed.totals.free !== undefined) {
        items.push({ label: translate('Free'), value: String(parsed.totals.free) });
      }

      if (items.length > 0) {
        blocks.push({ kind: 'metrics', items });
      }

      blocks.push({
        kind: 'table',
        columns: [
          { label: translate('Index'), numeric: true, format: 'count' },
          { label: translate('Monitor held'), numeric: true, format: 'count' },
          { label: translate('Recursion'), numeric: true, format: 'count' },
          { label: translate('OS thread'), numeric: true },
          { label: translate('Type'), wide: true },
        ],
        rows: parsed.rows.map(row => ({
          cells: [row.index, row.monitorHeld, row.recursion, row.osId ?? '', row.typeName ?? ''],
        })),
        empty: translate('No sync blocks in use'),
        filterPlaceholder: translate('Filter sync blocks'),
      });
      continue;
    }

    if (/^clrstack\b/i.test(trimmed)) {
      blocks.push({ kind: 'stacks', threads: parseThreadStacks(output) });
      continue;
    }

    if (/^dumpasync\b/i.test(trimmed)) {
      const statistics = parseAsyncStatistics(output);
      if (statistics !== undefined) {
        blocks.push({
          kind: 'table',
          columns: [
            { label: translate('Type'), wide: true },
            { label: translate('Count'), numeric: true, format: 'count' },
          ],
          rows: statistics.entries.map(entry => ({
            cells: [entry.typeName, entry.count],
            share: statistics.total === 0 ? 0 : (entry.count / statistics.total) * 100,
          })),
          showShare: true,
          filterPlaceholder: translate('Filter types'),
        });
      }

      continue;
    }

    if (/^threadpool\b/i.test(trimmed)) {
      const pool = parseThreadPoolSummary(output);
      if (pool !== undefined) {
        const items: DumpMetricItem[] = [];
        if (pool.cpuUtilization !== undefined) {
          items.push({ label: translate('CPU utilization'), value: `${pool.cpuUtilization}%` });
        }

        if (pool.workersRunning !== undefined && pool.workersTotal !== undefined) {
          items.push({
            label: translate('Workers busy'),
            value: `${pool.workersRunning} / ${pool.workersTotal}`,
          });
        }

        if (pool.workersIdle !== undefined) {
          items.push({ label: translate('Workers idle'), value: String(pool.workersIdle) });
        }

        if (pool.workerMaxLimit !== undefined) {
          items.push({ label: translate('Max workers'), value: String(pool.workerMaxLimit) });
        }

        if (pool.workItems !== undefined) {
          items.push({ label: translate('Queued work items'), value: String(pool.workItems) });
        }

        if (items.length > 0) {
          blocks.push({ kind: 'metrics', items });
        }

        if (pool.workersRunning !== undefined && pool.workersTotal !== undefined && pool.workersTotal > 0) {
          blocks.push({
            kind: 'meter',
            label: translate('Workers busy'),
            value: `${pool.workersRunning} / ${pool.workersTotal}`,
            fraction: pool.workersRunning / pool.workersTotal,
          });
        }
      }

      continue;
    }

    if (/^pe\b/i.test(trimmed)) {
      blocks.push({
        kind: 'exceptions',
        entries: parseExceptionInfo(output),
        empty: translate('No current managed exception in the dump'),
      });
      continue;
    }

    if (/^finalizequeue\b/i.test(trimmed)) {
      const summary = parseFinalizableSummary(output);
      const ready = parseFinalizableReady(output);
      const types = parseFinalizableTypes(output, parseHeapTypeMap(output));
      const items: DumpMetricItem[] = [];
      if (summary !== undefined) {
        items.push({ label: translate('Total'), value: String(summary.total) });
        summary.byGeneration.forEach((value, generation) => {
          items.push({ label: translate('Gen {0}', generation), value: String(value) });
        });
      }

      if (ready !== undefined) {
        items.push({ label: translate('Ready for finalization'), value: String(ready) });
      }

      if (items.length > 0) {
        blocks.push({ kind: 'metrics', items });
      }

      if (summary !== undefined && summary.byGeneration.length > 0) {
        blocks.push({
          kind: 'bar',
          unit: 'count',
          segments: summary.byGeneration.map((value, generation) => ({
            label: translate('Gen {0}', generation),
            value,
          })),
        });
      }

      if (types.length > 0) {
        const total = types.reduce((sum, type) => sum + type.size, 0);
        const shown = types.slice(0, REPORT_ENTRY_LIMIT);
        blocks.push({
          kind: 'table',
          columns: [
            { label: translate('Type'), wide: true },
            { label: translate('Objects'), numeric: true, format: 'count' },
            { label: translate('Size'), numeric: true, format: 'bytes' },
          ],
          rows: shown.map(type => ({
            cells: [type.typeName ?? type.methodTable, type.count, type.size],
            share: total === 0 ? 0 : (type.size / total) * 100,
          })),
          showShare: true,
          ...(types.length > shown.length
            ? { note: translate('Showing the {0} largest method tables.', shown.length) }
            : {}),
          filterPlaceholder: translate('Filter types'),
        });
      }
    }
  }

  return blocks;
}

/** Блоки одной команды: панель наверху строится по одной команде. */
function buildCommandBlocks(analysisId: string, command: string, output: string): DumpSectionBlock[] {
  return blocksForCommands(analysisId, [command], output);
}

/** Заголовок панели по команде: одна и та же команда не повторяется. */
function viewTitle(command: string): string {
  if (/^clrthreads\b/i.test(command)) {
    return translate('Threads');
  }

  if (/^eeheap\b.*-gc\b/i.test(command)) {
    return translate('GC heap segments');
  }

  if (isHeapStatisticsCommand(command)) {
    return /(^|\s)-type\b/i.test(command)
      ? translate('Exception objects on the heap')
      : translate('Heap by type');
  }

  if (/^syncblk\b/i.test(command)) {
    return translate('Sync blocks');
  }

  if (/^clrstack\b/i.test(command)) {
    return translate('Thread stacks');
  }

  if (/^dumpasync\b/i.test(command)) {
    return translate('Async state machines');
  }

  if (/^threadpool\b/i.test(command)) {
    return translate('Thread pool');
  }

  if (/^pe\b/i.test(command)) {
    return translate('Exceptions');
  }

  if (/^finalizequeue\b/i.test(command)) {
    return translate('Finalization queue');
  }

  return command;
}

/**
 * Панели для верхней части отчёта: по одной на уникальную команду.
 * Если несколько наборов используют одну команду (`dumpheap -stat` есть
 * в «Обзоре» и «Куче по типам»), панель показывается один раз.
 */
function buildViews(analyses: readonly SosAnalysis[], outputs: readonly string[]): DumpView[] {
  const views: DumpView[] = [];
  const seen = new Set<string>();

  for (const [index, analysis] of analyses.entries()) {
    const output = outputs[index] ?? '';
    for (const command of analysis.commands) {
      const key = command.trim().toLocaleLowerCase();
      if (seen.has(key)) {
        continue;
      }

      const blocks = buildCommandBlocks(analysis.id, command, output);
      if (blocks.length === 0) {
        continue;
      }

      seen.add(key);
      views.push({ command: command.trim(), title: viewTitle(command), blocks });
    }
  }

  return views;
}

/**
 * Разбирает факты по выводу одного набора команд.
 * Наборы запускаются отдельно, поэтому вывод чужих команд сюда не попадает
 * и общие команды вроде `dumpheap -stat` не смешиваются с фильтрами по типам.
 */
function factsForAnalysis(analysis: SosAnalysis, output: string): DumpFacts {
  const someCommand = (predicate: (command: string) => boolean): boolean =>
    analysis.commands.some(command => predicate(command.trim()));

  return {
    heap: someCommand(isOverallHeapCommand) ? parseHeapStatistics(output) : undefined,
    gcHeap: parseGcHeapSummary(someCommand(command => /^eeheap\b.*-gc\b/i.test(command)) ? output : ''),
    async: parseAsyncStatistics(someCommand(command => /^dumpasync\b.*--stats\b/i.test(command)) ? output : ''),
    exceptions: someCommand(command =>
      /^dumpheap\b/i.test(command) && /(^|\s)-type\b/i.test(command))
      ? parseHeapStatistics(output)
      : undefined,
    threads: parseThreadSummary(someCommand(command => /^clrthreads\b/i.test(command)) ? output : ''),
    threadPool: parseThreadPoolSummary(someCommand(command => /^threadpool\b/i.test(command)) ? output : ''),
    syncBlockCount: parseSyncBlockCount(someCommand(command => /^syncblk\b/i.test(command)) ? output : ''),
    finalizable: parseFinalizableSummary(someCommand(command => /^finalizequeue\b/i.test(command)) ? output : ''),
  };
}

/** Берёт первое найденное значение каждого факта из нескольких наборов. */
function mergeFacts(all: readonly DumpFacts[]): DumpFacts {
  const pick = <Key extends keyof DumpFacts>(key: Key): DumpFacts[Key] =>
    all.find(facts => facts[key] !== undefined)?.[key];

  return {
    heap: pick('heap'),
    gcHeap: pick('gcHeap'),
    async: pick('async'),
    exceptions: pick('exceptions'),
    threads: pick('threads'),
    threadPool: pick('threadPool'),
    syncBlockCount: pick('syncBlockCount'),
    finalizable: pick('finalizable'),
  };
}

/** Результат разбора одного дампа: отчёт и полные факты. */
export interface DumpAnalysis {
  report: DumpReport;
  /** Полные факты нужны для сравнения дампов: в отчёт попадают только топ-типы. */
  facts: DumpFacts;
}

/**
 * Разбирает вывод одного дампа.
 * `output` — либо общий вывод сессии (старый режим с приглашениями `>`),
 * либо вывод каждого выбранного набора по порядку.
 */
export function analyzeDumpOutput(
  dumpFile: string,
  analyses: readonly SosAnalysis[],
  output: string | readonly string[],
  generatedAt: Date,
  options: DumpReportOptions = {},
): DumpAnalysis {
  let sections: DumpReportSection[];
  let facts: DumpFacts;
  let views: DumpView[];

  if (typeof output === 'string') {
    ({ sections, facts } = analyzeSession(analyses, output));
    views = buildViews(analyses, sections.map(section => section.output));
  } else {
    const parsed = analyses.map((analysis, index) => {
      const text = output[index] ?? '';
      return { analysis, output: text.trim(), facts: factsForAnalysis(analysis, text) };
    });
    sections = parsed.map(item => ({
      id: item.analysis.id,
      title: analysisText(item.analysis.id)?.title ?? item.analysis.id,
      commands: item.analysis.commands,
      output: item.output,
    }));
    facts = mergeFacts(parsed.map(item => item.facts));
    views = buildViews(analyses, parsed.map(item => item.output));
  }

  const allEmpty = sections.every(section => section.output.length === 0);
  const report: DumpReport = {
    dumpFile,
    generatedAt: formatTimestamp(generatedAt),
    takenAt: options.takenAt === undefined ? undefined : formatTimestamp(options.takenAt),
    dumpBytes: options.dumpBytes,
    sections,
    views,
    heap: facts.heap === undefined
      ? undefined
      : { ...facts.heap, entries: facts.heap.entries.slice(0, REPORT_ENTRY_LIMIT) },
    typeCount: facts.heap?.entries.length,
    gcHeap: facts.gcHeap,
    async: facts.async === undefined
      ? undefined
      : { ...facts.async, entries: facts.async.entries.slice(0, REPORT_ENTRY_LIMIT) },
    exceptions: facts.exceptions === undefined
      ? undefined
      : { ...facts.exceptions, entries: facts.exceptions.entries.slice(0, REPORT_ENTRY_LIMIT) },
    threads: facts.threads,
    threadPool: facts.threadPool,
    syncBlockCount: facts.syncBlockCount,
    finalizable: facts.finalizable,
    findings: allEmpty
      ? [{
          level: 'warning',
          title: translate('The analysis produced no output'),
          detail: translate('Check that dotnet-dump can open this dump.'),
        }]
      : buildFindings(facts),
  };

  return { report, facts };
}

/** Собирает разобранные данные дампа для графической панели. */
export function buildDumpReport(
  dumpFile: string,
  analyses: readonly SosAnalysis[],
  output: string | readonly string[],
  generatedAt: Date,
  options: DumpReportOptions = {},
): DumpReport {
  return analyzeDumpOutput(dumpFile, analyses, output, generatedAt, options).report;
}

/** Изменение одного типа между дампами. */
export interface TypeChange {
  typeName: string;
  beforeSize: number;
  afterSize: number;
  sizeDelta: number;
  beforeCount: number;
  afterCount: number;
  countDelta: number;
}

/** Результат сравнения двух дампов. */
export interface DumpComparison {
  /** Заголовок: у сравнения снимков памяти он свой. */
  title?: string;
  before: DumpReport;
  after: DumpReport;
  typeChanges: TypeChange[];
  findings: DumpFinding[];
}

/** Сколько изменений типов передавать панели сравнения. */
const TYPE_CHANGE_LIMIT = 30;

/** Сравнивает типы двух куч: изменения по размеру и количеству. */
export function compareHeapTypes(before?: HeapStatSummary, after?: HeapStatSummary): TypeChange[] {
  if (before === undefined && after === undefined) {
    return [];
  }

  const beforeTypes = new Map((before?.entries ?? []).map(entry => [entry.typeName, entry]));
  const afterTypes = new Map((after?.entries ?? []).map(entry => [entry.typeName, entry]));
  const names = new Set([...beforeTypes.keys(), ...afterTypes.keys()]);
  const changes: TypeChange[] = [];

  for (const typeName of names) {
    const beforeEntry = beforeTypes.get(typeName);
    const afterEntry = afterTypes.get(typeName);
    const beforeSize = beforeEntry?.size ?? 0;
    const afterSize = afterEntry?.size ?? 0;
    const beforeCount = beforeEntry?.count ?? 0;
    const afterCount = afterEntry?.count ?? 0;
    const sizeDelta = afterSize - beforeSize;
    const countDelta = afterCount - beforeCount;
    if (sizeDelta === 0 && countDelta === 0) {
      continue;
    }

    changes.push({
      typeName,
      beforeSize,
      afterSize,
      sizeDelta,
      beforeCount,
      afterCount,
      countDelta,
    });
  }

  return changes
    .sort((left, right) => Math.abs(right.sizeDelta) - Math.abs(left.sizeDelta))
    .slice(0, TYPE_CHANGE_LIMIT);
}

/** Разница значений, если оба дампа их содержат. */
function signedDelta(before?: number, after?: number): number | undefined {
  return before === undefined || after === undefined ? undefined : after - before;
}

/** Наблюдения по изменениям между дампами. */
export function buildComparisonFindings(
  before: DumpFacts,
  after: DumpFacts,
  changes: readonly TypeChange[],
): DumpFinding[] {
  const findings: DumpFinding[] = [];
  const beforeHeap = before.heap;
  const afterHeap = after.heap;

  if (beforeHeap !== undefined && afterHeap !== undefined && beforeHeap.totalSize > 0) {
    const delta = afterHeap.totalSize - beforeHeap.totalSize;
    if (Math.abs(delta) >= 10 * 1024 * 1024) {
      const percent = formatPercent((delta / beforeHeap.totalSize) * 100);
      if (delta > 0) {
        findings.push({
          level: delta / beforeHeap.totalSize >= 0.2 ? 'warning' : 'info',
          title: translate('Managed heap grew'),
          detail: translate(
            'Heap grew by {0} ({1}): {2} → {3}.',
            formatBytes(delta),
            percent,
            formatBytes(beforeHeap.totalSize),
            formatBytes(afterHeap.totalSize),
          ),
        });
      } else {
        findings.push({
          level: 'info',
          title: translate('Managed heap shrank'),
          detail: translate(
            'Heap shrank by {0} ({1}): {2} → {3}.',
            formatBytes(-delta),
            percent,
            formatBytes(beforeHeap.totalSize),
            formatBytes(afterHeap.totalSize),
          ),
        });
      }
    }

    const objectsDelta = afterHeap.totalCount - beforeHeap.totalCount;
    if (Math.abs(objectsDelta) >= 10_000) {
      findings.push({
        level: 'info',
        title: translate('Object count changed'),
        detail: translate(
          'Object count changed by {0}: {1} → {2}.',
          objectsDelta > 0 ? `+${objectsDelta}` : String(objectsDelta),
          beforeHeap.totalCount,
          afterHeap.totalCount,
        ),
      });
    }
  }

  const growth = changes
    .filter(change => change.sizeDelta > 0)
    .sort((left, right) => right.sizeDelta - left.sizeDelta)[0];
  if (growth !== undefined && growth.sizeDelta >= 1024 * 1024) {
    findings.push({
      level: 'info',
      title: translate('Largest growth by type'),
      detail: translate('{0} grew by {1}.', growth.typeName, formatBytes(growth.sizeDelta)),
    });
  }

  const reduction = changes
    .filter(change => change.sizeDelta < 0)
    .sort((left, right) => left.sizeDelta - right.sizeDelta)[0];
  if (reduction !== undefined && reduction.sizeDelta <= -1024 * 1024) {
    findings.push({
      level: 'info',
      title: translate('Largest reduction by type'),
      detail: translate('{0} shrank by {1}.', reduction.typeName, formatBytes(-reduction.sizeDelta)),
    });
  }

  const asyncDelta = signedDelta(before.async?.total, after.async?.total);
  if (asyncDelta !== undefined && asyncDelta >= 500) {
    findings.push({
      level: 'warning',
      title: translate('Async state machines increased'),
      detail: translate('{0} more async state machines than in the first dump.', asyncDelta),
    });
  }

  const exceptionsDelta = signedDelta(before.exceptions?.totalCount, after.exceptions?.totalCount);
  if (exceptionsDelta !== undefined && exceptionsDelta >= 1000) {
    findings.push({
      level: 'warning',
      title: translate('Exception objects increased'),
      detail: translate('{0} more exception objects than in the first dump.', exceptionsDelta),
    });
  }

  return findings;
}

/** Сравнивает два разобранных дампа. */
export function buildDumpComparison(before: DumpAnalysis, after: DumpAnalysis): DumpComparison {
  const typeChanges = compareHeapTypes(before.facts.heap, after.facts.heap);
  return {
    title: before.report.source === 'gcdump' ? translate('Memory snapshot comparison') : undefined,
    before: before.report,
    after: after.report,
    typeChanges,
    findings: buildComparisonFindings(before.facts, after.facts, typeChanges),
  };
}

/** Текстовый отчёт сравнения: метрики, изменения типов и полный вывод обеих сессий. */
export function formatComparisonReport(comparison: DumpComparison, generatedAt: Date): string {
  const lines = [
    translate('Dump comparison'),
    translate('Before: {0}', comparison.before.dumpFile),
    ...(comparison.before.takenAt === undefined
      ? []
      : [translate('Dump taken: {0}', comparison.before.takenAt)]),
    translate('After: {0}', comparison.after.dumpFile),
    ...(comparison.after.takenAt === undefined
      ? []
      : [translate('Dump taken: {0}', comparison.after.takenAt)]),
    translate('Report created: {0}', formatTimestamp(generatedAt)),
    '',
  ];

  const beforeHeap = comparison.before.heap;
  const afterHeap = comparison.after.heap;
  if (beforeHeap !== undefined && afterHeap !== undefined) {
    lines.push(
      translate('Managed heap: {0} → {1}', formatBytes(beforeHeap.totalSize), formatBytes(afterHeap.totalSize)),
      translate('Objects: {0} → {1}', beforeHeap.totalCount, afterHeap.totalCount),
    );
  }

  if (comparison.typeChanges.length > 0) {
    lines.push('', translate('Type changes:'));
    for (const change of comparison.typeChanges) {
      const sign = change.sizeDelta >= 0 ? '+' : '−';
      lines.push(
        `  ${sign}${formatBytes(Math.abs(change.sizeDelta))}  ${change.typeName}  `
        + `(${formatBytes(change.beforeSize)} → ${formatBytes(change.afterSize)})`,
      );
    }
  }

  if (comparison.findings.length > 0) {
    lines.push('', translate('What stands out'));
    for (const finding of comparison.findings) {
      lines.push(`  • ${finding.title} — ${finding.detail}`);
    }
  }

  for (const [label, report] of [
    [translate('Before: {0}', comparison.before.dumpFile), comparison.before],
    [translate('After: {0}', comparison.after.dumpFile), comparison.after],
  ] as const) {
    lines.push('', translate('Output:'), label);
    for (const section of report.sections) {
      lines.push('', `=== ${section.title} ===`, section.output || translate('(no output)'));
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Таблица «самые крупные типы» и итоговая строка. */
function formatHeapSummary(summary: HeapStatSummary): string[] {
  const lines = [
    translate('Managed heap summary'),
    `  ${translate('Size').padStart(10)}  ${translate('Count').padStart(10)}  ${translate('Share').padStart(5)}  ${translate('Type')}`,
  ];

  for (const entry of summary.entries.slice(0, HEAP_SUMMARY_LIMIT)) {
    const share = summary.totalSize === 0 ? 0 : (entry.size / summary.totalSize) * 100;
    lines.push(
      `  ${formatBytes(entry.size).padStart(10)}  ${String(entry.count).padStart(10)}  ${`${share.toFixed(1)}%`.padStart(5)}  ${entry.typeName}`,
    );
  }

  lines.push(translate('Total: {0} objects, {1}', summary.totalCount, formatBytes(summary.totalSize)));
  return lines;
}

/** Метка времени в отчёте: 2026-11-07 12:30:00. */
export function formatTimestamp(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(' ');
}
