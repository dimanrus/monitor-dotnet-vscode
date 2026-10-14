/**
 * Типизированный доступ к настройкам расширения (`monitor-dotnet.*`).
 */

import * as vscode from 'vscode';

/** Режим автоматического запуска мониторинга. */
export type EnableMonitoringMode = 'onDebugOrRun' | 'onDebug' | 'never';

export interface MonitorSettings {
  enableMonitoring: EnableMonitoringMode;
  autoReveal: boolean;
  refreshIntervalSeconds: number;
  chartWindowSeconds: number;
  counterProviders: string[];
  metricProviders: string[];
  dotnetPath: string;
  bridgePath: string;
  processNameFilter: string;
  profilingOutputDirectory: string;
  enableIssueDetection: boolean;
}

const CONFIGURATION_SECTION = 'monitor-dotnet';

/** Читает текущие настройки. */
export function getSettings(): MonitorSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIGURATION_SECTION);

  return {
    enableMonitoring: configuration.get<EnableMonitoringMode>('enableMonitoring', 'onDebugOrRun'),
    autoReveal: configuration.get<boolean>('autoReveal', true),
    refreshIntervalSeconds: clamp(configuration.get<number>('refreshIntervalSeconds', 1), 0.2, 60),
    chartWindowSeconds: clamp(configuration.get<number>('chartWindowSeconds', 120), 10, 3600),
    counterProviders: sanitizeList(configuration.get<string[]>('counterProviders', [])),
    metricProviders: sanitizeList(configuration.get<string[]>('metricProviders', ['*'])),
    dotnetPath: (configuration.get<string>('dotnetPath', 'dotnet') || 'dotnet').trim(),
    bridgePath: (configuration.get<string>('bridgePath', '') || '').trim(),
    processNameFilter: (configuration.get<string>('processNameFilter', '') || '').trim(),
    profilingOutputDirectory: (configuration.get<string>('profilingOutputDirectory', '') || '').trim(),
    enableIssueDetection: configuration.get<boolean>('enableIssueDetection', true),
  };
}

/** Подписка на изменение настроек. */
export function onDidChangeSettings(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(CONFIGURATION_SECTION)) {
      listener();
    }
  });
}

/** Открывает настройки расширения в редакторе. */
export async function openSettings(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', CONFIGURATION_SECTION);
}

function sanitizeList(values: readonly string[]): string[] {
  return values
    .map(value => value.trim())
    .filter(value => value.length > 0);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }

  return Math.min(maximum, Math.max(minimum, value));
}
