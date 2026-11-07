/**
 * Дополнение фильтров сбора из панели Counters.
 *
 * В настройках фильтры записаны строками:
 *  - `System.Runtime` — весь провайдер, `MyProvider[A,B]` — отдельные счётчики;
 *  - `MyMeter` — весь метр, `MyMeter\MyInstrument` — один инструмент.
 *
 * Модуль не зависит от API VS Code: правила проверяются тестами.
 */

/** Разобранная запись фильтра счётчиков. */
interface CounterEntry {
  provider: string;
  /** Пустой список означает «весь провайдер». */
  counters: string[];
}

/** Делит запись `Provider[A,B]` на имя провайдера и счётчики. */
function splitCounterEntry(value: string): CounterEntry {
  const text = value.trim();
  const open = text.indexOf('[');
  if (open < 0) {
    return { provider: text, counters: [] };
  }

  const close = text.lastIndexOf(']');
  const inner = close > open ? text.slice(open + 1, close) : text.slice(open + 1);
  return {
    provider: text.slice(0, open).trim(),
    counters: inner.split(',').map(part => part.trim()).filter(part => part.length > 0),
  };
}

/** Сравнение имён без учёта регистра: имена провайдеров и счётчиков регистр не различают. */
function sameName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/**
 * Добавляет провайдера или отдельный счётчик в фильтр EventCounters.
 * Если провайдер уже включён целиком, список не меняется.
 */
export function withCounterFilter(
  current: readonly string[],
  provider: string,
  counter?: string,
): string[] {
  const name = provider.trim();
  if (name.length === 0) {
    return [...current];
  }

  const index = current.findIndex(entry => sameName(splitCounterEntry(entry).provider, name));
  if (index < 0) {
    const wanted = counter?.trim() ?? '';
    return [...current, wanted.length === 0 ? name : `${name}[${wanted}]`];
  }

  const entry = splitCounterEntry(current[index]);
  const wanted = counter?.trim() ?? '';
  // Провайдер уже собирается целиком — добавлять отдельный счётчик незачем.
  if (wanted.length === 0 || entry.counters.length === 0) {
    return [...current];
  }

  if (entry.counters.some(item => sameName(item, wanted))) {
    return [...current];
  }

  const merged = `${entry.provider}[${[...entry.counters, wanted].join(',')}]`;
  return current.map((value, position) => (position === index ? merged : value));
}

/**
 * Добавляет метр или инструмент в фильтр метрик.
 * `*` уже включает все метры, поэтому список остаётся прежним.
 */
export function withMetricFilter(
  current: readonly string[],
  meter: string,
  instrument?: string,
): string[] {
  const name = meter.trim();
  if (name.length === 0 || current.some(entry => entry.trim() === '*')) {
    return [...current];
  }

  // Весь метр включается только записью без обратной косой черты.
  const wholeMeter = current.some(entry => !entry.includes('\\') && sameName(entry, name));
  if (wholeMeter) {
    return [...current];
  }

  const wanted = instrument?.trim() ?? '';
  if (wanted.length === 0) {
    return [...current, name];
  }

  const full = `${name}\\${wanted}`;
  if (current.some(entry => sameName(entry, full))) {
    return [...current];
  }

  return [...current, full];
}
