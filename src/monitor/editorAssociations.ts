/**
 * Ассоциация файлов `.speedscope.json` с просмотрщиком Speedscope.
 *
 * Сам по себе файл профиля — это JSON, и VS Code открывает его как текст.
 * Расширение `sransara.speedscope-in-vscode` показывает такие файлы наглядным viewer-ом,
 * но для этого в настройках рабочей области нужна строка:
 *
 * ```jsonc
 * "workbench.editorAssociations": {
 *   "*.speedscope.json": "speedscope-in-vscode.speedscope"
 * }
 * ```
 *
 * Чистая логика слияния настроек вынесена сюда, чтобы её проверяли тесты без VS Code.
 */

/** Расширение, которое открывает профили Speedscope внутри VS Code. */
export const SPEEDSCOPE_VIEWER_EXTENSION = 'sransara.speedscope-in-vscode';

/** Идентификатор viewer-а, который указывается в ассоциации. */
export const SPEEDSCOPE_VIEW_TYPE = 'speedscope-in-vscode.speedscope';

/** Шаблон файлов профиля. */
export const SPEEDSCOPE_FILE_PATTERN = '*.speedscope.json';

/** Значение настройки `workbench.editorAssociations`: имя шаблона → редактор. */
export type EditorAssociations = Record<string, unknown>;

/**
 * Добавляет ассоциацию, сохраняя все существующие.
 * Настройка может быть объектом, строкой или отсутствовать — приводим к объекту безопасно.
 */
export function withSpeedscopeAssociation(current: unknown): EditorAssociations {
  const existing: EditorAssociations =
    typeof current === 'object' && current !== null && !Array.isArray(current)
      ? { ...(current as EditorAssociations) }
      : {};

  existing[SPEEDSCOPE_FILE_PATTERN] = SPEEDSCOPE_VIEW_TYPE;
  return existing;
}

/** Настроена ли уже ассоциация профилей с viewer-ом. */
export function hasSpeedscopeAssociation(current: unknown): boolean {
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    return false;
  }

  const value = (current as EditorAssociations)[SPEEDSCOPE_FILE_PATTERN];
  if (value === SPEEDSCOPE_VIEW_TYPE) {
    return true;
  }

  // VS Code разрешает и объектную форму: { viewType, filenamePattern }.
  return typeof value === 'object' && value !== null && (value as { viewType?: unknown }).viewType === SPEEDSCOPE_VIEW_TYPE;
}
