/**
 * Расчёт видимого диапазона графиков.
 *
 * Логика вынесена из панели (webview) сюда: она не зависит ни от DOM, ни от обмена
 * сообщениями, поэтому её проверяют тесты. Это важно: если диапазон не включает
 * выделенный интервал, переход к найденной проблеме показывает пустое место.
 */

/** Отрезок времени на графиках. */
export interface TimeRange {
  fromMs: number;
  toMs: number;
}

/** Минимальный диапазон показа, чтобы график не «схлопывался» в начале сбора. */
const MIN_SPAN_MS = 1000;

/**
 * Видимый диапазон живых данных: последние `windowSeconds` секунд.
 *
 * Выделенный интервал всегда попадает внутрь диапазона: пользователь переходит к проблеме
 * из дерева, и она может оказаться старше окна показа.
 */
export function liveVisibleRange(
  points: readonly { t: number }[],
  windowSeconds: number,
  nowMs: number,
  selection: TimeRange | null,
): TimeRange {
  const windowMs = Math.max(1, windowSeconds) * 1000;
  const first = points[0];
  const last = points[points.length - 1];
  let view: TimeRange;
  if (first === undefined || last === undefined) {
    // Данных ещё нет: показываем окно до текущего момента.
    view = { fromMs: nowMs - windowMs, toMs: nowMs };
  } else {
    const fromMs = Math.max(first.t, last.t - windowMs);
    view = { fromMs: Math.min(fromMs, last.t - MIN_SPAN_MS), toMs: Math.max(last.t, fromMs + MIN_SPAN_MS) };
  }

  if (selection !== null) {
    view = {
      fromMs: Math.min(view.fromMs, Math.min(selection.fromMs, selection.toMs)),
      toMs: Math.max(view.toMs, Math.max(selection.fromMs, selection.toMs)),
    };
  }

  return view;
}

/**
 * Диапазон показа для сохранённого интервала: сам интервал и запас по краям.
 * Запас нужен, чтобы на графике было видно, что было до проблемы и что после неё.
 */
export function paddedRange(interval: TimeRange): TimeRange {
  const span = Math.max(0, Math.abs(interval.toMs - interval.fromMs));
  const paddingMs = Math.max(MIN_SPAN_MS, Math.round(span * 0.25));
  const fromMs = Math.min(interval.fromMs, interval.toMs);
  const toMs = Math.max(interval.fromMs, interval.toMs);
  return { fromMs: fromMs - paddingMs, toMs: toMs + paddingMs };
}

/**
 * Сужает диапазон показа до сохранённых точек: за их пределами линий нет,
 * и по краям графика осталось бы пустое место.
 */
export function clampToData(range: TimeRange, points: readonly { t: number }[]): TimeRange {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) {
    return range;
  }

  const fromMs = Math.max(range.fromMs, first.t);
  const toMs = Math.min(range.toMs, last.t);
  // Данных на весь диапазон не хватило: показываем то, что есть.
  return fromMs >= toMs ? { fromMs: first.t, toMs: last.t } : { fromMs, toMs };
}

/**
 * Нужно ли закрыть сохранённый интервал: данные монитора заменили (новый процесс или очистка).
 * Генерация данных растёт при каждом таком изменении, поэтому сохранённые точки становятся чужими.
 */
export function archiveReplaced(
  archiveGeneration: number | undefined,
  incomingGeneration: number | undefined,
): boolean {
  if (archiveGeneration === undefined || incomingGeneration === undefined) {
    return false;
  }

  return archiveGeneration !== incomingGeneration;
}
