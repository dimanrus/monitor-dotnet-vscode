/**
 * Мелочи для работы с результатами инструментов диагностики.
 * Вынесено отдельно от запуска, чтобы правила проверялись тестами без VS Code.
 */

/** Имя Speedscope-файла, который `dotnet-trace` кладёт рядом с трассировкой. */
export function speedscopeFileFor(traceFile: string): string {
  return traceFile.replace(/\.nettrace$/i, '.speedscope.json');
}

/**
 * Парный `.nettrace` для файла результата.
 * `undefined` означает, что файл не является ни трассировкой, ни её Speedscope-версией.
 */
export function netTraceFileFor(file: string): string | undefined {
  if (/\.nettrace$/i.test(file)) {
    return file;
  }

  if (/\.speedscope\.json$/i.test(file)) {
    return file.replace(/\.speedscope\.json$/i, '.nettrace');
  }

  return undefined;
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

/**
 * Аргументы снимка CPU: сэмплирующий профиль `dotnet-sampled-thread-time` и фиксированная длительность.
 * Профиль пишется сразу в Speedscope, чтобы панель разобрала его без внешних инструментов.
 * `cpu-sampling` здесь не подходит: в `dotnet-trace` это профиль подкоманды `collect-linux`.
 */
export function cpuSnapshotArgs(pid: number, traceFile: string, seconds: number): string[] {
  return [
    'collect',
    '-p', Math.max(1, Math.round(pid)).toString(),
    '--profile', 'dotnet-sampled-thread-time',
    '--format', 'Speedscope',
    '--duration', formatToolDuration(Math.max(1, Math.round(seconds))),
    '-o', traceFile,
  ];
}

/** Параметры отчёта `dotnet-trace report topN`. */
export interface TraceTopNOptions {
  /** Сколько методов показать. */
  number?: number;
  /** Сортировать по inclusive-времени вместо exclusive. */
  inclusive?: boolean;
}

/**
 * Аргументы `dotnet-trace report <trace> topN`.
 * Вывод всегда содержит обе колонки (Inclusive и Exclusive); флаг `--inclusive`
 * меняет только порядок сортировки.
 */
export function traceTopNArgs(traceFile: string, options: TraceTopNOptions = {}): string[] {
  const count = Math.max(1, Math.round(options.number ?? 20));
  return [
    'report', traceFile,
    'topN',
    '-n', String(count),
    ...(options.inclusive === true ? ['--inclusive'] : []),
  ];
}
