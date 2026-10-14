/**
 * Индикатор в статус-баре: показывает загрузку процессора и память мониторимого процесса.
 * Нажатие открывает панель Performance.
 */

import * as vscode from 'vscode';
import { formatBytes, formatPercent } from '../core/formatting.ts';
import type { MonitorState } from '../core/monitorState.ts';
import { translate } from '../core/locale.ts';

export class MonitorStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly state: MonitorState;

  constructor(state: MonitorState) {
    this.state = state;
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = 'monitor-dotnet.focusPerformance';
    this.disposables.push({ dispose: this.state.onDidChange(() => this.update()) });
    this.update();
  }

  /** Обновляет текст индикатора по текущему состоянию. */
  update(): void {
    const latest = this.state.latest;
    if (latest === undefined) {
      this.item.hide();
      return;
    }

    this.item.text = `$(pulse) ${translate('CPU {0} · {1}', formatPercent(latest.cpuPercent), formatBytes(latest.privateMemoryBytes))}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**Monitor Dotnet**\n\n`
      + `- ${translate('Process')}: ${this.state.hello?.processName ?? '—'} (PID ${this.state.hello?.pid ?? '—'})\n`
      + `- CPU: ${formatPercent(latest.cpuPercent)}\n`
      + `- ${translate('Private memory')}: ${formatBytes(latest.privateMemoryBytes)}\n`
      + `- ${translate('Managed heap')}: ${formatBytes(latest.managedHeapBytes)}\n`
      + `- ${translate('GC collections (gen0/gen1/gen2)')}: `
      + `${latest.gcCollections.gen0}/${latest.gcCollections.gen1}/${latest.gcCollections.gen2}`,
    );
    this.item.show();
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.item.dispose();
  }
}
