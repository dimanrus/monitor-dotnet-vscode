/**
 * Мелочи для работы с результатами инструментов диагностики.
 * Вынесено отдельно от запуска, чтобы правила проверялись тестами без VS Code.
 */

/** Имя Speedscope-файла, который `dotnet-trace` кладёт рядом с трассировкой. */
export function speedscopeFileFor(traceFile: string): string {
  return traceFile.replace(/\.nettrace$/i, '.speedscope.json');
}

/**
 * Имя файла без расширения: `dotnet-trace convert -o` сам добавляет расширение формата,
 * поэтому передавать готовое имя `.speedscope.json` нельзя — получится `.speedscope.json.speedscope.json`.
 */
export function traceBaseFor(traceFile: string): string {
  return traceFile.replace(/\.nettrace$/i, '');
}

/**
 * Длительность для `--duration` инструментов диагностики: `dd:hh:mm:ss`.
 * Ноль секунд означает «до остановки» — такие аргументы не передаются.
 */
export function formatToolDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return [
    Math.floor(total / 86_400),
    Math.floor((total % 86_400) / 3_600),
    Math.floor((total % 3_600) / 60),
    total % 60,
  ].map(pad).join(':');
}
