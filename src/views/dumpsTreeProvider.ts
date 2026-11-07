/**
 * Панель «Дампы»: файлы `.dmp` и снимки `.gcdump` из каталога результатов.
 *
 * Клик по файлу открывает графический анализ, контекстное меню позволяет
 * сравнить его с другим файлом того же вида или показать в проводнике.
 */

import path from 'node:path';
import * as vscode from 'vscode';
import { formatBytes } from '../core/formatting.ts';
import { localeTag, translate } from '../core/locale.ts';
import type { DumpFileInfo } from '../monitor/dumpFiles.ts';

export class DumpsTreeProvider implements vscode.TreeDataProvider<DumpFileInfo>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DumpFileInfo | undefined>();
  private readonly load: () => Promise<DumpFileInfo[]>;
  private items: DumpFileInfo[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(load: () => Promise<DumpFileInfo[]>) {
    this.load = load;
    this.refresh();
  }

  /** Перечитывает каталог: вызывается после снятия дампа и по кнопке обновления. */
  refresh(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    try {
      this.items = await this.load();
    } catch {
      this.items = [];
    }

    this.emitter.fire(undefined);
  }

  getChildren(element?: DumpFileInfo): DumpFileInfo[] {
    return element === undefined ? this.items : [];
  }

  getTreeItem(item: DumpFileInfo): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(path.basename(item.file), vscode.TreeItemCollapsibleState.None);
    const isSnapshot = item.kind === 'snapshot';
    treeItem.id = item.file;
    treeItem.resourceUri = vscode.Uri.file(item.file);
    treeItem.description = describeDump(item);
    treeItem.tooltip = new vscode.MarkdownString(
      `\`${item.file}\`\n\n${formatBytes(item.bytes)} · ${formatModified(item.modifiedMs)}`,
    );
    treeItem.iconPath = new vscode.ThemeIcon(isSnapshot ? 'database' : 'file-binary');
    treeItem.contextValue = isSnapshot ? 'snapshot' : 'dump';
    treeItem.command = {
      command: isSnapshot ? 'monitor-dotnet.analyzeMemorySnapshot' : 'monitor-dotnet.analyzeDumpFile',
      title: isSnapshot ? translate('Analyse memory snapshot') : translate('Analyse dump'),
      arguments: [item],
    };
    return treeItem;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Подпись под именем: размер и время изменения файла. */
function describeDump(item: DumpFileInfo): string {
  return `${formatBytes(item.bytes)} · ${formatModified(item.modifiedMs)}`;
}

function formatModified(milliseconds: number): string {
  return new Date(milliseconds).toLocaleString(localeTag(), {
    dateStyle: 'short',
    timeStyle: 'short',
  });
}
