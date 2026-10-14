/**
 * Поиск процесса, который отлаживает VS Code.
 *
 * В API отладки нет прямого способа узнать PID цели, поэтому используем набор признаков:
 * явный processId (для attach), путь к программе из конфигурации запуска, фильтр по имени
 * и время старта сессии отладки.
 *
 * Ключевое правило: процесс должен быть запущен вместе с сессией отладки.
 * Без этой проверки легко подключиться к похожему процессу, который работал раньше.
 */

/** Кандидат — процесс .NET, найденный в операционной системе. */
export interface ProcessCandidate {
  pid: number;
  name: string;
  commandLine: string;
  /** Время запуска в миллисекундах UNIX; 0, если определить не удалось. */
  startTimeMs: number;
  /**
   * Путь к исполняемому файлу, полученный от операционной системы.
   * Нужен потому, что в командной строке путь может быть относительным или отсутствовать.
   */
  executablePath?: string;
}

/** Признаки процесса отладки, собранные из сессии VS Code и настроек. */
export interface DebuggeeHints {
  /** Идентификатор процесса из конфигурации attach. */
  processId?: number;
  /** Путь к программе из конфигурации launch. */
  program?: string;
  /** Рабочий каталог из конфигурации launch. */
  cwd?: string;
  /** Подстрока командной строки из настроек расширения. */
  processNameFilter?: string;
  /** Время старта сессии отладки в миллисекундах UNIX. */
  sessionStartMs: number;
  /** Процессы, которые нельзя выбирать (например, сам мост). */
  excludePids: readonly number[];
  /**
   * Разрешить выбор процесса без совпадения по программе.
   * Включается только в самом конце поиска, когда точную цель найти не удалось.
   */
  allowFallback?: boolean;
}

/**
 * Насколько раньше сессии мог стартовать процесс, чтобы считаться целью.
 * Небольшой запас нужен на расхождение порядка событий: среда может создать процесс
 * за мгновение до того, как расширение получит событие о старте сессии.
 */
const START_TIME_TOLERANCE_MS = 5_000;

/** Насколько позже сессии может стартовать процесс, чтобы не потерять цель. */
const START_TIME_MAX_DELAY_MS = 120_000;

/**
 * Выбирает PID процесса отладки.
 * Возвращает `undefined`, если однозначно определить цель не удалось: лучше подождать
 * следующей попытки, чем подключиться к чужому процессу.
 */
export function selectDebuggeePid(
  candidates: readonly ProcessCandidate[],
  hints: DebuggeeHints,
): number | undefined {
  // Явно указанный процесс: используется при подключении к запущенному приложению.
  if (hints.processId !== undefined && hints.processId > 0) {
    return hints.processId;
  }

  const excluded = new Set(hints.excludePids);
  let available = candidates.filter(candidate => !excluded.has(candidate.pid));
  if (available.length === 0) {
    return undefined;
  }

  if (hints.processNameFilter) {
    const filter = hints.processNameFilter.toLowerCase();
    const filtered = available.filter(candidate =>
      candidate.commandLine.toLowerCase().includes(filter) ||
      candidate.name.toLowerCase().includes(filter));
    if (filtered.length > 0) {
      available = filtered;
    }
  }

  // Процессы, запущенные вместе с сессией отладки: только они могут быть целью.
  const fresh = available.filter(candidate => isStartedWithSession(candidate, hints.sessionStartMs));

  const byProgram = matchByProgram(fresh, hints);
  if (byProgram !== undefined) {
    return byProgram;
  }

  const hasProgramHint = Boolean(hints.program || hints.cwd);
  if (!hasProgramHint || hints.allowFallback === true) {
    // Подсказок нет (или поиск уже исчерпал время): берём самый поздний из подходящих процессов.
    return newest(fresh)?.pid;
  }

  return undefined;
}

/** Процесс запущен рядом со стартом сессии отладки. */
function isStartedWithSession(candidate: ProcessCandidate, sessionStartMs: number): boolean {
  if (candidate.startTimeMs <= 0) {
    // Платформа не сообщила время старта: пропускаем, чтобы не подключиться к старому процессу.
    return false;
  }

  return candidate.startTimeMs >= sessionStartMs - START_TIME_TOLERANCE_MS &&
    candidate.startTimeMs <= sessionStartMs + START_TIME_MAX_DELAY_MS;
}

/** Сопоставление по пути к программе и рабочему каталогу из конфигурации запуска. */
function matchByProgram(
  candidates: readonly ProcessCandidate[],
  hints: DebuggeeHints,
): number | undefined {
  const needles = new Set<string>();
  if (hints.program) {
    const program = normalize(hints.program);
    needles.add(program);
    // Для приложения, запущенного через `dotnet app.dll`, в командной строке будет и dll, и каталог.
    needles.add(stripExtension(program));
    needles.add(fileName(program));
    needles.add(stripExtension(fileName(program)));
  }

  if (hints.cwd) {
    needles.add(normalize(hints.cwd));
  }

  const meaningful = [...needles].filter(needle => needle.length > 3);
  if (meaningful.length === 0) {
    return undefined;
  }

  const matches = candidates.filter(candidate => {
    const commandLine = normalize(candidate.commandLine);
    return meaningful.some(needle => commandLine.includes(needle));
  });

  return newest(matches)?.pid;
}

/** Самый поздний по времени запуска процесс: цель отладки стартует последней. */
function newest(candidates: readonly ProcessCandidate[]): ProcessCandidate | undefined {
  let result: ProcessCandidate | undefined;
  for (const candidate of candidates) {
    if (result === undefined || candidate.startTimeMs > result.startTimeMs) {
      result = candidate;
    }
  }

  return result;
}

/** Приводит путь к единому виду: прямые слэши и нижний регистр в Windows. */
function normalize(value: string): string {
  const unified = value.replace(/\\/g, '/');
  return process.platform === 'win32' ? unified.toLowerCase() : unified;
}

/** Отбрасывает расширение файла (.dll, .exe). */
function stripExtension(value: string): string {
  return value.replace(/\.(dll|exe|so|dylib)$/i, '');
}

/** Имя файла из пути. */
function fileName(value: string): string {
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(index + 1) : value;
}
