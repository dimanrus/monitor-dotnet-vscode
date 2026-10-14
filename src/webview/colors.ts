/**
 * Цвета для canvas.
 *
 * Canvas не понимает значения вида `var(--chart-cpu)`: строку с переменной нужно
 * заранее превратить в реальный цвет темы. Для `addColorStop` неверный цвет вообще
 * приводит к исключению, поэтому разрешение вынесено в отдельную функцию с проверками.
 */

/** Запасные цвета: используются, если тема не задала переменную. */
export const COLOR_FALLBACKS: Readonly<Record<string, string>> = {
  '--chart-cpu': '#4b9cff',
  '--chart-private-memory': '#b180d7',
  '--chart-managed-heap': '#89d185',
  '--chart-working-set': '#8a8a8a',
  '--chart-allocation': '#d18616',
  '--chart-gen0': '#e5c07b',
  '--chart-gen1': '#d18616',
  '--chart-gen2': '#f14c4c',
};

/** Цвет по умолчанию, если ничего не подошло. */
const DEFAULT_COLOR = '#8a8a8a';

/** Максимальная глубина подстановки переменных: защита от циклических ссылок. */
const MAX_DEPTH = 4;

/**
 * Приводит значение цвета к виду, понятному canvas.
 * Поддерживает `var(--name)` и `var(--name, запасной)`; обычные цвета возвращает без изменений.
 */
export function resolveCanvasColor(
  value: string,
  readVariable: (name: string) => string,
  fallback: string = DEFAULT_COLOR,
): string {
  let current = value.trim();
  if (current.length === 0) {
    return fallback;
  }

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const reference = parseVariableReference(current);
    if (reference === undefined) {
      // Обычный цвет (например, #4b9cff или rgb(...)) — canvas поймёт его сам.
      return current;
    }

    const resolved = readVariable(reference.name).trim();
    if (resolved.length > 0) {
      current = resolved;
      continue;
    }

    // Переменная не задана темой: берём то, что записано в значении или в таблице запасных цветов.
    return reference.fallback ?? COLOR_FALLBACKS[reference.name] ?? fallback;
  }

  // Переменные ссылаются друг на друга по кругу.
  return COLOR_FALLBACKS[value.trim()] ?? fallback;
}

/** Разбирает запись `var(--name)` или `var(--name, значение)`. */
function parseVariableReference(
  value: string,
): { name: string; fallback?: string } | undefined {
  const match = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([\s\S]*))?\)$/.exec(value);
  if (match === null) {
    return undefined;
  }

  const fallback = match[2]?.trim();
  return { name: match[1], fallback: fallback !== undefined && fallback.length > 0 ? fallback : undefined };
}
