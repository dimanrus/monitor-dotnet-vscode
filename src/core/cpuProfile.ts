/**
 * Разбор профиля CPU в формате Speedscope.
 *
 * `dotnet-trace collect --profile dotnet-sampled-thread-time --format Speedscope` кладёт рядом с `.nettrace`
 * файл `.speedscope.json`: сэмплы стеков с весами времени. Из него считаются две вещи:
 *  - `inclusive` — сколько времени метод был в стеке, включая вызываемые методы;
 *  - `exclusive` — сколько времени метод был вершиной стека, то есть работал сам.
 *
 * По этим числам строятся топ методов, дерево вызовов и флеймграф — то же, что
 * Visual Studio показывает в отчёте CPU Usage. Модуль не зависит от API VS Code,
 * поэтому его правила проверяются тестами.
 */

/** Единица времени в профиле Speedscope. */
export type CpuProfileUnit =
  | 'nanoseconds'
  | 'microseconds'
  | 'milliseconds'
  | 'seconds'
  | 'bytes'
  | 'none';

/** Кадр стека: имя метода и, если известно, файл и строка. */
export interface CpuFrame {
  name: string;
  file?: string;
  line?: number;
}

/** Итоги по одному методу. */
export interface CpuMethod {
  /** Устойчивый ключ метода: имя, файл и строка. */
  key: string;
  name: string;
  file?: string;
  line?: number;
  /** Время, когда метод был вершиной стека (в единицах профиля). */
  exclusive: number;
  /** Время, когда метод был в стеке, включая вложенные вызовы. */
  inclusive: number;
  /** Сколько сэмплов пришлось на метод как на вершину стека. */
  exclusiveSamples: number;
  /** Сколько сэмплов содержали метод в стеке. */
  inclusiveSamples: number;
  /** Доля собственного времени от общего, в процентах. */
  exclusivePercent: number;
  /** Доля полного времени от общего, в процентах. */
  inclusivePercent: number;
}

/** Узел агрегированного дерева вызовов. */
export interface CpuTreeNode {
  key: string;
  name: string;
  file?: string;
  line?: number;
  exclusive: number;
  inclusive: number;
  /** Сколько сэмплов проходило через узел. */
  samples: number;
  exclusivePercent: number;
  inclusivePercent: number;
  children: CpuTreeNode[];
}

/** Разобранный профиль CPU. */
export interface CpuProfile {
  /** Файл, из которого прочитан профиль. */
  file: string;
  /** Имя профиля из файла Speedscope (обычно имя процесса). */
  name: string;
  unit: CpuProfileUnit;
  /** Всё сэмплированное время CPU в единицах профиля. */
  total: number;
  /** Количество сэмплов CPU. */
  samples: number;
  /**
   * Время, когда поток был заблокирован (`UNMANAGED_CODE_TIME`).
   * В `total` и в проценты не входит: Visual Studio тоже показывает только CPU.
   */
  blocked: number;
  /** Сколько сэмплов пришлось на заблокированное время. */
  blockedSamples: number;
  /** Методы: сначала те, что больше времени работали сами. */
  methods: CpuMethod[];
  /** Корни дерева вызовов: сначала самые «тяжёлые». */
  roots: CpuTreeNode[];
  /** Время изменения файла в миллисекундах. */
  takenAt?: number;
  /** Часть дерева не построена из-за ограничений размера. */
  truncated: boolean;
}

/** Что произошло с методом между двумя снимками. */
export type CpuChangeStatus = 'added' | 'removed' | 'changed';

/** Изменение метода между двумя снимками. */
export interface CpuChangeRow {
  key: string;
  name: string;
  file?: string;
  line?: number;
  status: CpuChangeStatus;
  beforeExclusivePercent: number;
  afterExclusivePercent: number;
  /** Разница в процентных пунктах: положительная — метод стал дороже. */
  deltaExclusivePercent: number;
  beforeInclusivePercent: number;
  afterInclusivePercent: number;
  deltaInclusivePercent: number;
}

/** Сравнение двух снимков CPU. */
export interface CpuProfileComparison {
  before: CpuProfile;
  after: CpuProfile;
  /** Строки: сначала самые заметные изменения. */
  rows: CpuChangeRow[];
  /** Изменение общего сэмплированного времени в процентах. */
  totalDeltaPercent: number;
}

/** Предел узлов дерева: защита от огромных профилей. */
export const MAX_TREE_NODES = 20_000;

/** Предел глубины дерева: рекурсивные стеки встречаются, но не бесконечны. */
export const MAX_TREE_DEPTH = 512;

/**
 * Служебные кадры Speedscope от `dotnet-trace`.
 * `UNMANAGED_CODE_TIME` — поток ждал или работал в нативном коде;
 * `CPU_TIME` — маркер того, что поток выполнялся, сам по себе методом не является.
 */
const BLOCKED_FRAME = 'UNMANAGED_CODE_TIME';
const CPU_FRAME = 'CPU_TIME';

/**
 * Кадры-группы, которые `dotnet-trace` добавляет над настоящими стеками:
 * процесс, «(Non-Activities)» и список потоков. Сами по себе они не методы,
 * поэтому в дереве вызовов их можно пропустить, оставив потоки и методы.
 */
const GROUPING_FRAMES = new Set(['(Non-Activities)', 'Threads']);

/** Кадры-группы и потоки: в таблицу методов они не попадают. */
function isGroupingFrame(name: string): boolean {
  return GROUPING_FRAMES.has(name) || /^Process(32|64) /.test(name) || /^Thread \(/.test(name);
}

/** Предел строк сравнения: защита от огромных профилей. */
const MAX_COMPARISON_ROWS = 5_000;

/** Ключ кадра: одинаковые имена в разных файлах — разные методы. */
export function frameKey(frame: CpuFrame): string {
  return `${frame.name}\u0000${frame.file ?? ''}\u0000${frame.line ?? ''}`;
}

/**
 * Читает `.speedscope.json`.
 * `undefined` означает, что файл не является корректным профилем Speedscope.
 */
export function parseSpeedscope(
  text: string,
  file = '',
  takenAtMs?: number,
): CpuProfile | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }

  return buildCpuProfile(raw, file, takenAtMs);
}

/** Собирает профиль из уже разобранного JSON: удобно для тестов и повторного использования. */
export function buildCpuProfile(
  raw: unknown,
  file = '',
  takenAtMs?: number,
): CpuProfile | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const shared = isRecord(raw.shared) ? raw.shared : undefined;
  const profiles = Array.isArray(raw.profiles) ? raw.profiles : undefined;
  if (shared === undefined || profiles === undefined || !Array.isArray(shared.frames)) {
    return undefined;
  }

  const frames: CpuFrame[] = [];
  for (const value of shared.frames) {
    const frame = readFrame(value);
    // Индексы сэмплов ссылаются на позиции в исходном массиве, поэтому пустые кадры
    // сохраняем заглушкой, а не выбрасываем — иначе поедут все индексы.
    frames.push(frame ?? { name: '' });
  }

  const methods = new Map<string, MutableMethod>();
  const roots = new Map<string, MutableNode>();
  let total = 0;
  let sampleCount = 0;
  let blocked = 0;
  let blockedSamples = 0;
  let unit: CpuProfileUnit = 'none';
  let name = '';
  let nodeCount = 0;
  let truncated = false;

  for (const rawProfile of profiles) {
    if (!isRecord(rawProfile)) {
      continue;
    }

    const series = readSeries(rawProfile, frames.length);
    if (series === undefined) {
      continue;
    }

    if (unit === 'none') {
      unit = normalizeUnit(rawProfile.unit);
    }

    if (name.length === 0 && typeof rawProfile.name === 'string') {
      name = rawProfile.name;
    }

    for (const sample of series) {
      if (sample.weight <= 0 || sample.stack.length === 0) {
        continue;
      }

      const stack = cpuOnlyStack(frames, sample.stack);
      if (stack === undefined) {
        // Поток был заблокирован: это ожидание, а не работа CPU.
        blocked += sample.weight;
        blockedSamples++;
        continue;
      }

      total += sample.weight;
      sampleCount++;
      const cpuSample = { stack, weight: sample.weight };
      accumulateMethods(methods, frames, cpuSample);
      const created = accumulateTree(roots, frames, cpuSample, nodeCount);
      nodeCount = created.nodes;
      truncated = truncated || created.truncated;
    }
  }

  const methodList = [...methods.values()]
    .map(method => toCpuMethod(method, total))
    .sort((left, right) => right.exclusive - left.exclusive ||
      right.inclusive - left.inclusive ||
      left.name.localeCompare(right.name));

  const treeTruncated = { value: truncated };
  const rootNodes = flattenGrouping(toTreeNodes(roots, total, treeTruncated));

  return {
    file,
    name,
    unit,
    total,
    samples: sampleCount,
    blocked,
    blockedSamples,
    methods: methodList,
    roots: rootNodes,
    takenAt: takenAtMs,
    truncated: treeTruncated.value,
  };
}

/** Длительность профиля в миллисекундах: для форматирования в интерфейсе. */
export function cpuDurationMilliseconds(profile: CpuProfile): number {
  return weightToMilliseconds(profile.total, profile.unit);
}

/** Переводит вес профиля в миллисекунды. */
export function weightToMilliseconds(value: number, unit: CpuProfileUnit): number {
  switch (unit) {
    case 'seconds':
      return value * 1000;
    case 'microseconds':
      return value / 1000;
    case 'nanoseconds':
      return value / 1_000_000;
    default:
      return value;
  }
}

/** Сравнение двух снимков: изменения считаются в процентных пунктах. */
export function compareCpuProfiles(
  before: CpuProfile,
  after: CpuProfile,
): CpuProfileComparison {
  const beforeMethods = new Map(before.methods.map(method => [method.key, method]));
  const afterMethods = new Map(after.methods.map(method => [method.key, method]));
  const keys = new Set([...beforeMethods.keys(), ...afterMethods.keys()]);

  const rows: CpuChangeRow[] = [];
  for (const key of keys) {
    const beforeMethod = beforeMethods.get(key);
    const afterMethod = afterMethods.get(key);
    const source = afterMethod ?? beforeMethod;
    if (source === undefined) {
      continue;
    }

    const beforeExclusive = beforeMethod?.exclusivePercent ?? 0;
    const afterExclusive = afterMethod?.exclusivePercent ?? 0;
    const beforeInclusive = beforeMethod?.inclusivePercent ?? 0;
    const afterInclusive = afterMethod?.inclusivePercent ?? 0;

    rows.push({
      key,
      name: source.name,
      file: source.file,
      line: source.line,
      status: beforeMethod === undefined ? 'added' : afterMethod === undefined ? 'removed' : 'changed',
      beforeExclusivePercent: beforeExclusive,
      afterExclusivePercent: afterExclusive,
      deltaExclusivePercent: afterExclusive - beforeExclusive,
      beforeInclusivePercent: beforeInclusive,
      afterInclusivePercent: afterInclusive,
      deltaInclusivePercent: afterInclusive - beforeInclusive,
    });
  }

  rows.sort((left, right) =>
    Math.abs(right.deltaExclusivePercent) - Math.abs(left.deltaExclusivePercent) ||
    Math.abs(right.deltaInclusivePercent) - Math.abs(left.deltaInclusivePercent) ||
    left.name.localeCompare(right.name));

  const totalDeltaPercent = before.total > 0
    ? ((after.total - before.total) / before.total) * 100
    : 0;

  return {
    before,
    after,
    rows: rows.slice(0, MAX_COMPARISON_ROWS),
    totalDeltaPercent,
  };
}

/** Внутренние накопители: проценты считаются один раз в конце, когда известен итог. */
interface MutableMethod {
  frame: CpuFrame;
  exclusive: number;
  inclusive: number;
  exclusiveSamples: number;
  inclusiveSamples: number;
}

interface MutableNode {
  frame: CpuFrame;
  exclusive: number;
  inclusive: number;
  samples: number;
  children: Map<string, MutableNode>;
}

interface WeightedSample {
  stack: number[];
  weight: number;
}

function readFrame(value: unknown): CpuFrame | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0) {
    return undefined;
  }

  const frame: CpuFrame = { name };
  if (typeof value.file === 'string' && value.file.trim().length > 0) {
    frame.file = value.file;
  }

  if (typeof value.line === 'number' && Number.isFinite(value.line) && value.line > 0) {
    frame.line = Math.round(value.line);
  }

  return frame;
}

/** Сэмплы профиля: обычный (`sampled`) или событийный (`evented`) формат Speedscope. */
function readSeries(profile: Record<string, unknown>, frameCount: number): WeightedSample[] | undefined {
  if (profile.type === 'evented') {
    return readEventedSeries(profile, frameCount);
  }

  if (!Array.isArray(profile.samples)) {
    return undefined;
  }

  const weights = Array.isArray(profile.weights) ? profile.weights : undefined;
  const series: WeightedSample[] = [];
  for (let index = 0; index < profile.samples.length; index++) {
    const value = profile.samples[index];
    if (!Array.isArray(value)) {
      continue;
    }

    const stack = value.filter((frame): frame is number =>
      typeof frame === 'number' && Number.isInteger(frame) && frame >= 0 && frame < frameCount);
    if (stack.length === 0) {
      continue;
    }

    const rawWeight = weights?.[index];
    const weight = typeof rawWeight === 'number' && Number.isFinite(rawWeight) && rawWeight >= 0
      ? rawWeight
      : 1;
    series.push({ stack, weight });
  }

  return series;
}

/** Событийный профиль (`O` — открыть кадр, `C` — закрыть) переводится в интервалы времени. */
function readEventedSeries(profile: Record<string, unknown>, frameCount: number): WeightedSample[] | undefined {
  if (!Array.isArray(profile.events)) {
    return undefined;
  }

  const start = numberOr(profile.startValue, 0);
  const end = numberOr(profile.endValue, start);
  let last = start;
  const stack: number[] = [];
  const series: WeightedSample[] = [];

  for (const value of profile.events) {
    if (!isRecord(value)) {
      continue;
    }

    const at = numberOr(value.at, last);
    const delta = at - last;
    if (delta > 0 && stack.length > 0) {
      series.push({ stack: [...stack], weight: delta });
    }

    last = at;
    const rawFrame = value.frame;
    if (typeof rawFrame !== 'number' || !Number.isInteger(rawFrame) || rawFrame < 0 || rawFrame >= frameCount) {
      continue;
    }

    if (value.type === 'O') {
      stack.push(rawFrame);
    } else if (value.type === 'C') {
      const index = stack.lastIndexOf(rawFrame);
      if (index >= 0) {
        stack.length = index;
      }
    }
  }

  if (end > last && stack.length > 0) {
    series.push({ stack: [...stack], weight: end - last });
  }

  return series;
}

/**
 * Убирает служебные кадры Speedscope.
 * `undefined` означает, что сэмпл относится к заблокированному времени и в профиль CPU не входит.
 */
function cpuOnlyStack(frames: readonly CpuFrame[], stack: readonly number[]): number[] | undefined {
  const result: number[] = [];
  for (const index of stack) {
    const name = frames[index]?.name;
    if (name === BLOCKED_FRAME) {
      return undefined;
    }

    if (name === CPU_FRAME) {
      continue;
    }

    result.push(index);
  }

  return result;
}

function accumulateMethods(
  methods: Map<string, MutableMethod>,
  frames: readonly CpuFrame[],
  sample: WeightedSample,
): void {
  // Рекурсивный метод встречается в одном стеке несколько раз, но время сэмпла
  // учитывается в inclusive один раз — как в Visual Studio.
  const seen = new Set<string>();
  const leafIndex = sample.stack.length - 1;

  for (let depth = 0; depth < sample.stack.length; depth++) {
    const frame = frames[sample.stack[depth]];
    if (frame === undefined || frame.name.length === 0) {
      continue;
    }

    const key = frameKey(frame);
    if (isGroupingFrame(frame.name)) {
      continue;
    }

    let method = methods.get(key);
    if (method === undefined) {
      method = { frame, exclusive: 0, inclusive: 0, exclusiveSamples: 0, inclusiveSamples: 0 };
      methods.set(key, method);
    }

    if (!seen.has(key)) {
      method.inclusive += sample.weight;
      method.inclusiveSamples++;
      seen.add(key);
    }

    if (depth === leafIndex) {
      method.exclusive += sample.weight;
      method.exclusiveSamples++;
    }
  }
}

/** Вставка сэмпла в дерево. Возвращает число созданных узлов и признак обрезки. */
function accumulateTree(
  roots: Map<string, MutableNode>,
  frames: readonly CpuFrame[],
  sample: WeightedSample,
  nodeCount: number,
): { nodes: number; truncated: boolean } {
  let level = roots;
  let created = nodeCount;
  let truncated = false;
  const depthLimit = Math.min(sample.stack.length, MAX_TREE_DEPTH);
  if (depthLimit < sample.stack.length) {
    truncated = true;
  }

  for (let depth = 0; depth < depthLimit; depth++) {
    const frame = frames[sample.stack[depth]];
    if (frame === undefined || frame.name.length === 0) {
      break;
    }

    const key = frameKey(frame);
    let node = level.get(key);
    if (node === undefined) {
      if (created >= MAX_TREE_NODES) {
        // Узлы больше не создаём, но верхние уровни продолжают накапливать время.
        truncated = true;
        break;
      }

      node = { frame, exclusive: 0, inclusive: 0, samples: 0, children: new Map() };
      level.set(key, node);
      created++;
    }

    node.inclusive += sample.weight;
    node.samples++;
    if (depth === sample.stack.length - 1) {
      node.exclusive += sample.weight;
    }

    level = node.children;
  }

  return { nodes: created, truncated };
}

function toCpuMethod(method: MutableMethod, total: number): CpuMethod {
  return {
    key: frameKey(method.frame),
    name: method.frame.name,
    file: method.frame.file,
    line: method.frame.line,
    exclusive: method.exclusive,
    inclusive: method.inclusive,
    exclusiveSamples: method.exclusiveSamples,
    inclusiveSamples: method.inclusiveSamples,
    exclusivePercent: percentOf(method.exclusive, total),
    inclusivePercent: percentOf(method.inclusive, total),
  };
}

function toTreeNodes(
  nodes: Map<string, MutableNode>,
  total: number,
  truncated: { value: boolean },
): CpuTreeNode[] {  const result: CpuTreeNode[] = [];
  for (const node of nodes.values()) {
    result.push({
      key: frameKey(node.frame),
      name: node.frame.name,
      file: node.frame.file,
      line: node.frame.line,
      exclusive: node.exclusive,
      inclusive: node.inclusive,
      samples: node.samples,
      exclusivePercent: percentOf(node.exclusive, total),
      inclusivePercent: percentOf(node.inclusive, total),
      children: toTreeNodes(node.children, total, truncated),
    });
  }

  result.sort((left, right) =>
    right.inclusive - left.inclusive ||
    right.exclusive - left.exclusive ||
    left.name.localeCompare(right.name));
  return result;
}

/**
 * Пропускает служебные кадры-группы, поднимая их детей на уровень выше.
 * Время групп не теряется: их `exclusive` равно нулю, а `inclusive` детей
 * по-прежнему считается от общего времени профиля.
 */
function flattenGrouping(nodes: CpuTreeNode[]): CpuTreeNode[] {
  const result: CpuTreeNode[] = [];
  for (const node of nodes) {
    const grouping = node.exclusive === 0 && node.children.length > 0 &&
      (GROUPING_FRAMES.has(node.name) || /^Process(32|64) /.test(node.name));
    if (grouping) {
      result.push(...flattenGrouping(node.children));
    } else {
      result.push({ ...node, children: flattenGrouping(node.children) });
    }
  }

  return result;
}

function percentOf(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

function normalizeUnit(value: unknown): CpuProfileUnit {
  const units: readonly CpuProfileUnit[] = [
    'nanoseconds',
    'microseconds',
    'milliseconds',
    'seconds',
    'bytes',
    'none',
  ];
  return typeof value === 'string' && (units as readonly string[]).includes(value)
    ? value as CpuProfileUnit
    : 'none';
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
