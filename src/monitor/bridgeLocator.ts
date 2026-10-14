/**
 * Поиск сборки моста.
 * Порядок поиска: настройка → встроенная сборка рядом с расширением → сборка из исходников рабочей области.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { translate } from '../core/locale.ts';
import type { Logger } from '../logger.ts';

const execFileAsync = promisify(execFile);
const BRIDGE_ASSEMBLY = 'MonitorDotnet.Bridge.dll';
const BRIDGE_EXECUTABLE = 'MonitorDotnet.Bridge';

/** Результат поиска моста. */
export interface BridgeLocation {
  /** Путь к сборке или исполняемому файлу, который нужно запустить. */
  bridgePath: string;
  /** Откуда взялась сборка — для диагностики. */
  source: 'setting' | 'bundled' | 'workspace-build';
}

/**
 * Находит мост для запуска.
 * Возвращает `undefined`, если ни один вариант не подошёл: тогда расширение показывает инструкцию.
 */
export async function locateBridge(
  configuredPath: string,
  extensionPath: string,
  logger: Logger,
): Promise<BridgeLocation | undefined> {
  const configured = await resolveConfiguredPath(configuredPath);
  if (configured !== undefined) {
    return { bridgePath: configured, source: 'setting' };
  }

  const bundled = await resolveConfiguredPath(path.join(extensionPath, 'dist', 'bridge', BRIDGE_ASSEMBLY));
  if (bundled !== undefined) {
    return { bridgePath: bundled, source: 'bundled' };
  }

  const fromWorkspace = await tryBuildFromWorkspace(logger);
  if (fromWorkspace !== undefined) {
    return { bridgePath: fromWorkspace, source: 'workspace-build' };
  }

  return undefined;
}

/** Проверяет путь из настроек: это может быть файл сборки или каталог с ней. */
async function resolveConfiguredPath(configuredPath: string): Promise<string | undefined> {
  if (!configuredPath) {
    return undefined;
  }

  const candidate = path.resolve(configuredPath);
  if (!existsSync(candidate)) {
    return undefined;
  }

  const info = await stat(candidate);
  if (info.isFile()) {
    return candidate;
  }

  // Каталог: ищем сборку или исполняемый файл внутри.
  for (const fileName of [BRIDGE_ASSEMBLY, executableName()]) {
    const inside = path.join(candidate, fileName);
    if (existsSync(inside)) {
      return inside;
    }
  }

  return undefined;
}

/** Собирает мост из исходников рабочей области (сценарий разработки расширения). */
async function tryBuildFromWorkspace(logger: Logger): Promise<string | undefined> {
  const project = findBridgeProject();
  if (project === undefined) {
    return undefined;
  }

  try {
    logger.info(translate('Building the bridge from sources: {0}', project));
    await execFileAsync(
      'dotnet',
      ['build', project, '-c', 'Release', '--nologo'],
      { maxBuffer: 10 * 1024 * 1024 },
    );

    const projectDirectory = path.dirname(project);
    const output = path.join(projectDirectory, 'bin', 'Release', 'net10.0', BRIDGE_ASSEMBLY);
    if (existsSync(output)) {
      return output;
    }

    logger.warn(translate('The bridge was built, but the file was not found: {0}', output));
  } catch (error) {
    logger.error(translate('Could not build the bridge from sources'), error);
  }

  return undefined;
}

/** Ищет проект моста в открытой рабочей области или рядом с исходниками расширения. */
function findBridgeProject(): string | undefined {
  const candidates: string[] = [];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme === 'file') {
      candidates.push(path.join(folder.uri.fsPath, 'bridge', 'MonitorDotnet.Bridge', 'MonitorDotnet.Bridge.csproj'));
    }
  }

  // Расширение может запускаться прямо из репозитория, где лежит проект моста
  // (dist → корень репозитория → bridge/...).
  for (const base of [__dirname, process.cwd()]) {
    candidates.push(path.join(base, '..', 'bridge', 'MonitorDotnet.Bridge', 'MonitorDotnet.Bridge.csproj'));
    candidates.push(path.join(base, '..', '..', 'bridge', 'MonitorDotnet.Bridge', 'MonitorDotnet.Bridge.csproj'));
    candidates.push(path.join(base, 'bridge', 'MonitorDotnet.Bridge', 'MonitorDotnet.Bridge.csproj'));
  }

  return candidates.find(candidate => existsSync(candidate));
}

/** Имя исполняемого файла моста с учётом платформы. */
function executableName(): string {
  return process.platform === 'win32' ? `${BRIDGE_EXECUTABLE}.exe` : BRIDGE_EXECUTABLE;
}

