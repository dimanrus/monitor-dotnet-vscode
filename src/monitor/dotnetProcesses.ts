/**
 * Поиск процессов .NET в операционной системе.
 * Используется для подключения к запущенному приложению и для определения цели отладки.
 *
 * Важно: приложение .NET может быть запущено двумя способами, и оба нужно распознавать:
 *  1. через хост: `dotnet /path/App.dll`;
 *  2. через apphost — свой исполняемый файл рядом со сборкой: `/path/App` (Linux/macOS) или `App.exe` (Windows).
 * Именно второй способ использует отладчик .NET, поэтому без его поддержки мониторинг не подключался.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readlink, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ProcessCandidate } from '../core/debuggeeMatching.ts';

const execFileAsync = promisify(execFile);

/** Служебные процессы, которые не должны попадать в список кандидатов. */
const IGNORED_COMMAND_FRAGMENTS = [
  // Инструменты диагностики и сам мост.
  'MonitorDotnet.Bridge',
  'dotnet-monitor',
  'dotnet-counters',
  'dotnet-trace',
  'dotnet-dump',
  'dotnet-gcdump',
  'dotnet-stack',
  // Инфраструктура редактора и компиляторов.
  'vscode-server',
  'extensionHost',
  'Microsoft.CodeAnalysis.LanguageServer',
  'CsharpDevTools',
  'VBCSCompiler',
  'MSBuild.dll',
  'NuGet.Mcp.Server',
  'VSTest.Console',
];

/** Окружение, от которого зависит распознавание .NET-процесса. Вынесено отдельно для тестов. */
export interface DotnetDetectionEnvironment {
  /** Есть ли сборка рядом с исполняемым файлом (шаблон apphost: App и App.dll в одном каталоге). */
  hasSiblingAssembly(executablePath: string): boolean;
}

/** Реализация по умолчанию: проверяем наличие файла на диске. */
export const defaultDetectionEnvironment: DotnetDetectionEnvironment = {
  hasSiblingAssembly: executablePath => existsSync(`${stripExtension(executablePath)}.dll`),
};

/**
 * Возвращает процессы .NET, подходящие для мониторинга.
 * Платформенные различия скрыты внутри: Linux — /proc, macOS — ps, Windows — PowerShell/CIM.
 */
export async function listDotnetProcesses(): Promise<ProcessCandidate[]> {
  const all = await listAllProcesses();
  return all
    .filter(candidate => isDotnetCandidate(candidate))
    .filter(candidate => !isIgnored(candidate));
}

/**
 * Определяет, является ли процесс приложением .NET.
 * Проверки идут от самой дешёвой к самой дорогой.
 */
export function isDotnetCandidate(
  candidate: ProcessCandidate,
  environment: DotnetDetectionEnvironment = defaultDetectionEnvironment,
): boolean {
  const commandLine = candidate.commandLine;
  // Предпочитаем путь от операционной системы: в командной строке он может быть относительным.
  const executable = candidate.executablePath ?? executableFromCommandLine(commandLine);
  const executableName = baseName(executable).toLowerCase();

  // Запуск через хост .NET: `dotnet App.dll` или `dotnet run`.
  if (executableName === 'dotnet' || executableName === 'dotnet.exe') {
    return true;
  }

  // Сборка указана в командной строке напрямую.
  if (commandLine.toLowerCase().includes('.dll')) {
    return true;
  }

  // Процесс-обёртка (apphost): рядом с исполняемым файлом лежит сборка с тем же именем.
  if (executable.length > 0 && environment.hasSiblingAssembly(executable)) {
    return true;
  }

  // Некоторые приложения запускаются с суффиксом .exe даже вне Windows-терминологии.
  return executableName.endsWith('.exe') && candidate.name.toLowerCase() !== executableName;
}

/** Служебные процессы мониторинга и редактора отбрасываем. */
export function isIgnored(candidate: ProcessCandidate): boolean {
  const commandLine = candidate.commandLine.toLowerCase();
  if (IGNORED_COMMAND_FRAGMENTS.some(fragment => commandLine.includes(fragment.toLowerCase()))) {
    return true;
  }

  // Каталог расширений редактора: там живут языковые серверы, а не отлаживаемые приложения.
  return commandLine.includes('/.vscode/') || commandLine.includes('\\.vscode\\');
}

/** Первый токен командной строки — путь к исполняемому файлу. */
function executableFromCommandLine(commandLine: string): string {
  const trimmed = commandLine.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const token = trimmed.split(/\s+/)[0] ?? '';
  return token.replace(/^"|"$/g, '');
}

/** Имя файла из пути (учитывает и прямые, и обратные слэши). */
function baseName(value: string): string {
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return index >= 0 ? value.slice(index + 1) : value;
}

/** Отбрасывает расширение исполняемого файла или сборки. */
function stripExtension(value: string): string {
  return value.replace(/\.(dll|exe|so|dylib)$/i, '');
}

/** Список процессов платформенно-зависимым способом. */
async function listAllProcesses(): Promise<ProcessCandidate[]> {
  try {
    if (process.platform === 'linux') {
      return await listLinuxProcesses();
    }

    if (process.platform === 'darwin') {
      return await listMacProcesses();
    }

    if (process.platform === 'win32') {
      return await listWindowsProcesses();
    }
  } catch {
    // Ниже вернём пустой список: расширение сообщит пользователю, что процессы не найдены.
  }

  return [];
}

/** Linux: читаем /proc напрямую. */
async function listLinuxProcesses(): Promise<ProcessCandidate[]> {
  const bootTimeMs = await readBootTimeMs();
  const entries = await readdir('/proc', { withFileTypes: true });
  const candidates: ProcessCandidate[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }

    const pid = Number(entry.name);
    const commandLine = await readFile(`/proc/${entry.name}/cmdline`, 'utf8')
      .then(text => text.replace(/\0/g, ' ').trim())
      .catch(() => '');
    if (commandLine.length === 0) {
      continue;
    }

    const startTicks = await readStartTimeTicks(entry.name);
    candidates.push({
      pid,
      name: baseName(executableFromCommandLine(commandLine)),
      commandLine,
      startTimeMs: startTicks > 0 ? bootTimeMs + (startTicks / CLOCK_TICKS_PER_SECOND) * 1000 : 0,
      executablePath: await readExecutablePath(entry.name),
    });
  }

  return candidates;
}

/** Время загрузки системы: нужно, чтобы перевести тики из /proc/<pid>/stat в абсолютное время. */
async function readBootTimeMs(): Promise<number> {
  try {
    const content = await readFile('/proc/stat', 'utf8');
    const match = /^btime\s+(\d+)/m.exec(content);
    return match ? Number(match[1]) * 1000 : 0;
  } catch {
    return 0;
  }
}

/** 22-е поле /proc/<pid>/stat — время старта процесса в тиках от загрузки. */
async function readStartTimeTicks(pid: string): Promise<number> {
  try {
    const content = await readFile(`/proc/${pid}/stat`, 'utf8');
    // Имя процесса заключено в скобки и может содержать пробелы, поэтому ищем закрывающую скобку.
    const close = content.lastIndexOf(')');
    if (close < 0) {
      return 0;
    }

    // После «) » идёт поле state (3-е в stat), поэтому starttime (22-е) лежит под индексом 19.
    const fields = content.slice(close + 2).split(' ');
    const value = Number(fields[19]);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Частота тиков ядра, используемая в поле starttime файла /proc/<pid>/stat. */
const CLOCK_TICKS_PER_SECOND = 100;

/**
 * Абсолютный путь к исполняемому файлу процесса: символическая ссылка /proc/<pid>/exe.
 * Возвращает пустую строку, если прочитать не удалось (например, нет прав).
 */
async function readExecutablePath(pid: string): Promise<string> {
  try {
    const target = await readlink(`/proc/${pid}/exe`);
    // Для удалённых файлов ядро добавляет суффикс « (deleted)».
    return target.replace(/\s+\(deleted\)$/, '');
  } catch {
    return '';
  }
}

/** macOS: получаем список процессов через `ps`. */
async function listMacProcesses(): Promise<ProcessCandidate[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,lstart=,command='], { maxBuffer: 8 * 1024 * 1024 });
  const candidates: ProcessCandidate[] = [];

  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    if (match === null) {
      continue;
    }

    const startedAt = Date.parse(match[2]) || 0;
    candidates.push({
      pid: Number(match[1]),
      name: baseName(executableFromCommandLine(match[3])),
      commandLine: match[3],
      startTimeMs: startedAt,
    });
  }

  return candidates;
}

/** Windows: запрашиваем у CIM список процессов с командной строкой. */
async function listWindowsProcesses(): Promise<ProcessCandidate[]> {
  const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,ExecutablePath,CreationDate | ConvertTo-Json -Compress';
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    maxBuffer: 32 * 1024 * 1024,
  });

  const parsed: unknown = JSON.parse(stdout.trim() || '[]');
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const candidates: ProcessCandidate[] = [];

  for (const item of items) {
    const record = item as { ProcessId?: number; Name?: string; CommandLine?: string; ExecutablePath?: string; CreationDate?: string };
    if (typeof record.ProcessId !== 'number') {
      continue;
    }

    candidates.push({
      pid: record.ProcessId,
      name: record.Name ?? '',
      commandLine: record.CommandLine ?? record.Name ?? '',
      startTimeMs: record.CreationDate ? Date.parse(record.CreationDate) || 0 : 0,
      executablePath: record.ExecutablePath ?? '',
    });
  }

  return candidates;
}
