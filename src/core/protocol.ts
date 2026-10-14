/**
 * Типы сообщений, которыми обмениваются мост (MonitorDotnet.Bridge) и расширение.
 * Мост пишет по одной JSON-строке на сообщение (NDJSON), расширение разбирает их здесь.
 */

/** Версия протокола, которую ожидает расширение. */
export const PROTOCOL_VERSION = '1.0';

/** Снимок показателей процесса за интервал. */
export interface BridgeProcessSnapshot {
  cpuPercent: number;
  privateMemoryBytes: number;
  workingSetBytes: number;
  threadCount: number;
  managedHeapBytes: number;
  gen0HeapBytes: number;
  gen1HeapBytes: number;
  gen2HeapBytes: number;
  lohHeapBytes: number;
  allocationRateBytesPerSec: number;
  timeInGcPercent: number;
  gcCollections: GcCollectionCounts;
  exceptionsPerSecond: number | null;
}

/** Накопленное количество сборок мусора по поколениям. */
export interface GcCollectionCounts {
  gen0: number;
  gen1: number;
  gen2: number;
}

/** Значение классического счётчика EventCounters. */
export interface BridgeCounterValue {
  provider: string;
  name: string;
  displayName: string | null;
  unit: string | null;
  counterType: string | null;
  value: number;
  mean: number | null;
  min: number | null;
  max: number | null;
  standardDeviation: number | null;
  intervalSeconds: number;
  series: string | null;
  sampleCount: number;
}

/** Вид инструмента метрик. */
export type MetricKind = 'counter' | 'updowncounter' | 'gauge' | 'histogram';

/** Значение метрики (System.Diagnostics.Metrics). */
export interface BridgeMetricValue {
  meter: string;
  meterVersion: string | null;
  instrument: string;
  kind: MetricKind;
  unit: string | null;
  value: number;
  rate: number | null;
  count: number | null;
  sum: number | null;
  tags: string | null;
  description: string | null;
}

/** Событие сборки мусора. */
export interface BridgeGcEventValue {
  timestampUnixMs: number;
  generation: number;
  reason: string;
  gcType: string;
  phase: 'start' | 'stop';
  durationMs: number | null;
  count: number;
}

/** Сообщение о подключении к процессу. */
export interface BridgeHelloMessage {
  type: 'hello';
  protocolVersion: string;
  pid: number;
  processName: string;
  runtimeVersion: string | null;
  os: string;
  architecture: string;
  commandLine: string | null;
  processorCount: number;
  startedAtUnixMs: number;
}

/** Периодический срез данных. */
export interface BridgeSampleMessage {
  type: 'sample';
  timestampUnixMs: number;
  process: BridgeProcessSnapshot;
  counters: BridgeCounterValue[];
  metrics: BridgeMetricValue[];
  gcEvents: BridgeGcEventValue[];
}

/** Переменные окружения и системные свойства целевого процесса. */
export interface BridgeEnvironmentMessage {
  type: 'environment';
  variables: Array<{ key: string; value: string }>;
  properties: Array<{ key: string; value: string }>;
  warnings: string[];
}

/** Состояние монитора. `reason` переводится расширением, `message` — запасной вариант. */
export interface BridgeStatusMessage {
  type: 'status';
  state: 'connecting' | 'running' | 'stopped' | 'failed';
  /** Код причины остановки, например `targetExited`. */
  reason?: string | null;
  message: string | null;
}

/** Ошибка моста. `code` переводится расширением, `message` — подробность или запасной текст. */
export interface BridgeErrorMessage {
  type: 'error';
  /** Код ошибки, например `processNotFound` или `connectFailed`. */
  code?: string | null;
  message: string;
  fatal: boolean;
}

/** Диагностическое сообщение моста. */
export interface BridgeLogMessage {
  type: 'log';
  level: 'error' | 'warning' | 'info' | 'debug';
  message: string;
}

export type BridgeMessage =
  | BridgeHelloMessage
  | BridgeSampleMessage
  | BridgeEnvironmentMessage
  | BridgeStatusMessage
  | BridgeErrorMessage
  | BridgeLogMessage;

const KNOWN_TYPES = new Set([
  'hello',
  'sample',
  'environment',
  'status',
  'error',
  'log',
]);

/**
 * Разбирает одну строку NDJSON.
 * Возвращает `null` для пустых, неизвестных или повреждённых строк: одна битая строка
 * не должна прерывать поток мониторинга.
 */
export function parseBridgeMessage(line: string): BridgeMessage | null {
  const text = line.trim();
  if (text.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }

  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) {
    return null;
  }

  return parsed as BridgeMessage;
}

/** Проверяет, что срез содержит обязательные числовые поля. */
export function isUsableSample(message: BridgeSampleMessage): boolean {
  return (
    Number.isFinite(message.process?.cpuPercent) &&
    Number.isFinite(message.process?.privateMemoryBytes)
  );
}
