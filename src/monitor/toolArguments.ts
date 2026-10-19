/**
 * Мелочи для работы с результатами инструментов диагностики.
 * Вынесено отдельно от запуска, чтобы правила проверялись тестами без VS Code.
 */

/** Имя Speedscope-файла, который `dotnet-trace` кладёт рядом с трассировкой. */
export function speedscopeFileFor(traceFile: string): string {
  return traceFile.replace(/\.nettrace$/i, '.speedscope.json');
}
