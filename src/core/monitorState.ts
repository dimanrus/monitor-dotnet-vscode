/**
 * Состояние мониторинга: временные ряды для графиков, последние значения счётчиков и метрик,
 * сведения о процессе и окружении. Модуль не зависит от API VS Code, поэтому его легко тестировать.
 */

import type {
  BridgeCounterValue,
  BridgeEnvironmentMessage,
  BridgeGcEventValue,
  BridgeHelloMessage,
  BridgeMetricValue,
  BridgeSampleMessage,
  BridgeStatusMessage,
} from './protocol.ts';

/** Точка ряда показателей процесса. */
export interface ProcessSeriesPoint {
  timestampMs: number;
  cpuPercent: number;
  privateMemoryBytes: number;
  workingSetBytes: number;
  managedHeapBytes: number;
  allocationRateBytesPerSec: number;
  timeInGcPercent: number;
  threadCount: number;
  gcCollections: { gen0: number; gen1: number; gen2: number };
}

/** Последнее известное значение классического счётчика. */
export interface CounterSample extends BridgeCounterValue {
  timestampMs: number;
}

/** Последнее известное значение метрики. */
export interface MetricSample extends BridgeMetricValue {
  timestampMs: number;
}

/** Состояние монитора, как его видит пользователь. */
export type MonitorStatus = 'idle' | 'connecting' | 'running' | 'stopped' | 'failed';

/** Подписчик на изменения состояния. */
export type StateListener = () => void;

/** Предельное число хранимых событий GC — хватает для истории и не раздувает память. */
const MAX_GC_EVENTS = 500;

export class MonitorState {
  private readonly listeners = new Set<StateListener>();

  /** Временной ряд показателей процесса (для графиков). */
  readonly series: ProcessSeriesPoint[] = [];

  /** Последние события сборки мусора (фазы завершения — с длительностью). */
  readonly gcEvents: BridgeGcEventValue[] = [];

  /** Последние значения счётчиков: ключ — «провайдер/счётчик». */
  readonly counters = new Map<string, CounterSample>();

  /** Последние значения метрик: ключ — «метр/инструмент/теги». */
  readonly metrics = new Map<string, MetricSample>();

  private _status: MonitorStatus = 'idle';
  private _hello: BridgeHelloMessage | undefined;
  private _environment: BridgeEnvironmentMessage | undefined;
  private _statusHint: string | undefined;
  private _lastError: string | undefined;
  private _maxPoints = 900;
  private _generation = 0;

  /** Ограничение на длину хранимого ряда (зависит от окна графиков). */
  setMaxPoints(maxPoints: number): void {
    this._maxPoints = Math.max(2, Math.floor(maxPoints));
    this.trimSeries();
  }

  get maxPoints(): number {
    return this._maxPoints;
  }

  /**
   * Номер поколения данных: увеличивается при очистке и сбросе.
   * Панель графиков по нему понимает, что накопленные точки больше не актуальны.
   */
  get generation(): number {
    return this._generation;
  }

  get status(): MonitorStatus {
    return this._status;
  }

  get statusHint(): string | undefined {
    return this._statusHint;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  /** Сведения о подключении (сообщение hello). */
  get hello(): BridgeHelloMessage | undefined {
    return this._hello;
  }

  /** Окружение целевого процесса. */
  get environment(): BridgeEnvironmentMessage | undefined {
    return this._environment;
  }

  /** Последняя точка ряда. */
  get latest(): ProcessSeriesPoint | undefined {
    return this.series.at(-1);
  }

  /**
   * Границы собранного ряда или undefined, если данных нет.
   * По ним видно, покрывают ли живые данные выделенный интервал.
   */
  get range(): { fromMs: number; toMs: number } | undefined {
    const first = this.series[0];
    const last = this.series.at(-1);
    return first === undefined || last === undefined
      ? undefined
      : { fromMs: first.timestampMs, toMs: last.timestampMs };
  }

  /** Признак активного мониторинга (есть свежие данные). */
  get isActive(): boolean {
    return this._status === 'running' || this._status === 'connecting';
  }

  /** Подписка на изменения. Возвращает функцию отписки. */
  onDidChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Применяет сведения о подключении. */
  applyHello(hello: BridgeHelloMessage): void {
    this._hello = hello;
    this._status = 'running';
    this._statusHint = undefined;
    this._lastError = undefined;
    this.notify();
  }

  /** Применяет окружение целевого процесса. */
  applyEnvironment(environment: BridgeEnvironmentMessage): void {
    this._environment = environment;
    this.notify();
  }

  /** Применяет состояние монитора. */
  applyStatus(status: BridgeStatusMessage): void {
    this._status = status.state;
    this._statusHint = status.message ?? undefined;
    this.notify();
  }

  /** Запоминает сообщение об ошибке. */
  applyError(message: string, fatal: boolean): void {
    this._lastError = message;
    if (fatal) {
      this._status = 'failed';
    }

    this.notify();
  }

  /** Применяет периодический срез данных. */
  applySample(sample: BridgeSampleMessage): void {
    const process = sample.process;
    this.series.push({
      timestampMs: sample.timestampUnixMs,
      cpuPercent: process.cpuPercent,
      privateMemoryBytes: process.privateMemoryBytes,
      workingSetBytes: process.workingSetBytes,
      managedHeapBytes: process.managedHeapBytes,
      allocationRateBytesPerSec: process.allocationRateBytesPerSec,
      timeInGcPercent: process.timeInGcPercent,
      threadCount: process.threadCount,
      gcCollections: { ...process.gcCollections },
    });
    this.trimSeries();

    for (const counter of sample.counters) {
      this.counters.set(counterKey(counter.provider, counter.name), { ...counter, timestampMs: sample.timestampUnixMs });
    }

    for (const metric of sample.metrics) {
      this.metrics.set(metricKey(metric), { ...metric, timestampMs: sample.timestampUnixMs });
    }

    for (const gcEvent of sample.gcEvents) {
      this.gcEvents.push(gcEvent);
    }

    if (this.gcEvents.length > MAX_GC_EVENTS) {
      this.gcEvents.splice(0, this.gcEvents.length - MAX_GC_EVENTS);
    }

    if (this._status !== 'running') {
      this._status = 'running';
      this._statusHint = undefined;
    }

    this.notify();
  }

  /** Останавливает мониторинг, но сохраняет собранные данные. */
  markStopped(message?: string): void {
    this._status = 'stopped';
    this._statusHint = message;
    this.notify();
  }

  /** Полностью очищает собранные данные. */
  clear(): void {
    this._generation++;
    this.series.length = 0;
    this.gcEvents.length = 0;
    this.counters.clear();
    this.metrics.clear();
    this._environment = undefined;
    this.notify();
  }

  /** Сбрасывает сведения о процессе вместе с данными (перед новым подключением). */
  reset(): void {
    this._generation++;
    this.series.length = 0;
    this.gcEvents.length = 0;
    this.counters.clear();
    this.metrics.clear();
    this._environment = undefined;
    this._hello = undefined;
    this._lastError = undefined;
    this._statusHint = undefined;
    this._status = 'idle';
    this.notify();
  }

  private trimSeries(): void {
    if (this.series.length > this._maxPoints) {
      this.series.splice(0, this.series.length - this._maxPoints);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Ключ счётчика в словаре состояния. */
export function counterKey(provider: string, name: string): string {
  return `${provider}/${name}`;
}

/** Ключ метрики в словаре состояния: учитываются теги и вид инструмента. */
export function metricKey(metric: BridgeMetricValue): string {
  const tags = metric.tags ?? '';
  return `${metric.meter}/${metric.instrument}/${tags}`;
}
