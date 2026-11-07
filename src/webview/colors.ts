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

/**
 * Прозрачность заливки выделения на графиках.
 * Цвет выделения в теме непрозрачный (`editor.selectionBackground`), а такой заливкой
 * ряды под ней не видно: она должна просвечивать.
 */
export const SELECTION_ALPHA = 0.28;

/** Составляющие цвета в диапазоне 0–255. */
interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Разбирает `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(...)` и `rgba(...)`. */
function parseRgb(value: string): Rgb | undefined {
  const text = value.trim();

  const hex = /^#([0-9a-f]{3,8})$/i.exec(text);
  if (hex !== null) {
    const digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: Number.parseInt(digits[0] + digits[0], 16),
        g: Number.parseInt(digits[1] + digits[1], 16),
        b: Number.parseInt(digits[2] + digits[2], 16),
      };
    }

    if (digits.length === 6 || digits.length === 8) {
      return {
        r: Number.parseInt(digits.slice(0, 2), 16),
        g: Number.parseInt(digits.slice(2, 4), 16),
        b: Number.parseInt(digits.slice(4, 6), 16),
      };
    }

    return undefined;
  }

  const functional = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (functional === null) {
    return undefined;
  }

  const parts = functional[1].split(/[\s,/]+/).filter(part => part.length > 0);
  if (parts.length < 3) {
    return undefined;
  }

  const channel = (raw: string): number | undefined => {
    if (raw.endsWith('%')) {
      const percent = Number(raw.slice(0, -1));
      return Number.isFinite(percent) ? Math.round((percent / 100) * 255) : undefined;
    }

    const number = Number(raw);
    return Number.isFinite(number) ? Math.round(number) : undefined;
  };

  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  return r === undefined || g === undefined || b === undefined ? undefined : { r, g, b };
}

/**
 * Делает цвет полупрозрачным, чтобы сквозь заливку были видны графики.
 * Незнакомый формат (имя цвета, `color-mix(...)`) заменяется запасным значением:
 * непрозрачная заливка хуже прозрачной, а неверная строка молча оставит прошлый цвет.
 */
export function withAlpha(value: string, alpha: number, fallback: string): string {
  const color = parseRgb(value);
  if (color === undefined) {
    return fallback;
  }

  const clamped = Math.min(1, Math.max(0, alpha));
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamped})`;
}

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
