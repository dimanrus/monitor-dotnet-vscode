/**
 * Приведение ошибок к тексту.
 * Вынесено в отдельный модуль без зависимостей от API VS Code:
 * этим пользуются и модули расширения, и тесты, запускаемые в обычном Node.
 */

/** Возвращает читаемое описание ошибки. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    // Ошибки запуска процессов (spawn) содержат полезный код в свойстве code.
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${error.message} (${code})`;
  }

  return String(error);
}
