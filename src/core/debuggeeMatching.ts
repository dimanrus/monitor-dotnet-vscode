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
  /**
   * Путь к проекту из конфигурации запуска C# Dev Kit (`type: dotnet`).
   * Приложение задаётся проектом, а не сборкой, поэтому имя цели берём из имени файла проекта.
   */
  projectPath?: string;
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

  const hasProgramHint = Boolean(hints.program || hints.projectPath || hints.cwd);
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

/**
 * Сопоставление по пути к программе, проекту и рабочему каталогу из конфигурации запуска.
 *
 * Признаки неравноценны: имя сборки или проекта указывает на цель точно, а рабочий каталог —
 * лишь область поиска. Поэтому совпадения взвешиваются, и побеждает процесс с наибольшим весом.
 * Без этого в решениях Aspire, где рядом работают хост, сервисы и дашборд, выбирался
 * случайный процесс — тот, что стартовал последним.
 */
function matchByProgram(
  candidates: readonly ProcessCandidate[],
  hints: DebuggeeHints,
): number | undefined {
  const needles = buildNeedles(hints);
  if (needles.length === 0) {
    return undefined;
  }

  let best: { pid: number; score: number; isHost: boolean; startTimeMs: number } | undefined;
  for (const candidate of candidates) {
    const commandLine = normalize(candidate.commandLine);
    let score = 0;
    for (const needle of needles) {
      if (commandLine.includes(needle.value)) {
        score += needle.weight;
      }
    }

    if (score === 0) {
      continue;
    }

    // `dotnet run --project …` — это запускающая обёртка, а не само приложение:
    // отладчик подключается к дочернему процессу, поэтому у обёртки снижаем вес.
    if (isRunner(candidate)) {
      score -= RUNNER_PENALTY;
    }

    const isHost = isDotnetHost(candidate);
    if (best === undefined ||
      score > best.score ||
      (score === best.score && best.isHost && !isHost) ||
      (score === best.score && best.isHost === isHost && candidate.startTimeMs > best.startTimeMs)) {
      best = { pid: candidate.pid, score, isHost, startTimeMs: candidate.startTimeMs };
    }
  }

  return best?.pid;
}

/** Признак командной строки с весом: чем выше вес, тем точнее признак указывает на цель. */
interface Needle {
  value: string;
  weight: number;
}

/**
 * Собирает признаки для сопоставления.
 * Вес 3 — путь к программе и имя сборки или проекта, вес 1 — каталог, который лишь ограничивает поиск.
 */
function buildNeedles(hints: DebuggeeHints): Needle[] {
  const needles = new Map<string, number>();

  const add = (value: string, weight: number): void => {
    if (value.length <= 3) {
      return;
    }

    needles.set(value, Math.max(needles.get(value) ?? 0, weight));
  };

  for (const raw of [hints.program, hints.projectPath]) {
    if (raw === undefined || raw.length === 0) {
      continue;
    }

    const normalized = normalize(raw);
    // Путь без расширения: `/app/bin/Debug/net10.0/App.dll` и `/app/App.csproj` дают имя сборки.
    const withoutExtension = stripExtension(normalized);
    add(normalized, 3);
    add(withoutExtension, 3);
    // Имя сборки или проекта — самый надёжный признак: оно есть и в командной строке apphost,
    // и у хоста `dotnet`, и у `dotnet run --project`.
    add(fileName(withoutExtension), 3);
    // Каталог программы нужен для случая, когда в подсказке только сборка.
    add(directoryName(withoutExtension), 1);
  }

  if (hints.cwd !== undefined && hints.cwd.length > 0) {
    add(normalize(hints.cwd), 1);
  }

  return [...needles].map(([value, weight]) => ({ value, weight }));
}

/** Штраф за совпадение с процессом-обёрткой `dotnet run`: настоящая цель — его дочерний процесс. */
const RUNNER_PENALTY = 8;

/** Процесс запущен хостом `dotnet`: он выступает обёрткой, а не самой программой. */
function isDotnetHost(candidate: ProcessCandidate): boolean {
  const executable = candidate.executablePath ?? candidate.commandLine.trim().split(/\s+/)[0] ?? '';
  const name = fileName(normalize(executable)).toLowerCase();
  return name === 'dotnet' || name === 'dotnet.exe';
}

/**
 * Процесс лишь запускает приложение: `dotnet run --project …` или `dotnet watch run`.
 * Проверяем именно подкоманду хоста, а не слово в пути: проект с именем `Run` не должен считаться обёрткой.
 */
function isRunner(candidate: ProcessCandidate): boolean {
  if (!isDotnetHost(candidate)) {
    return false;
  }

  const argumentsList = candidate.commandLine
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(token => token.replace(/^"|"$/g, '').toLowerCase())
    .filter(token => !token.startsWith('-'));

  return argumentsList[0] === 'run' || (argumentsList[0] === 'watch' && argumentsList[1] === 'run');
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

/** Отбрасывает расширение файла: сборки, исполняемые файлы и файлы проектов. */
function stripExtension(value: string): string {
  return value.replace(/\.(dll|exe|so|dylib|csproj|fsproj|vbproj)$/i, '');
}

/** Имя файла из пути. */
function fileName(value: string): string {
  const index = value.lastIndexOf('/');
  return index >= 0 ? value.slice(index + 1) : value;
}

/** Каталог из пути: нужен для подсказок вроде `/app/bin/Debug/net10.0/App.dll`. */
function directoryName(value: string): string {
  const index = value.lastIndexOf('/');
  return index > 0 ? value.slice(0, index) : '';
}
