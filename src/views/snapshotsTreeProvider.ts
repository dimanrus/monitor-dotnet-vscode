/**
 * Панель «Снимки»: CPU-профили и снимки памяти из каталога результатов.
 *
 * Снимки сгруппированы по виду: сравнивать имеет смысл только файлы одного типа.
 * Клик открывает подходящий отчёт, контекстное меню сравнивает снимок с другим
 * того же вида или показывает файл в проводнике.
 */

import path from 'node:path';
import * as vscode from 'vscode';
import { formatBytes } from '../core/formatting.ts';
import { localeTag, translate } from '../core/locale.ts';
import {
  groupSnapshots,
  type SnapshotFileInfo,
  type SnapshotKind,
} from '../core/snapshotFiles.ts';

/** Группа снимков: заголовок «CPU» или «Память». */
export interface SnapshotGroupNode {
  nodeType: 'group';
  snapshotKind: SnapshotKind;
  files: SnapshotItemNode[];
}

/**
 * Один снимок.
 * `file` продублирован на верхнем уровне: команды дерева получают узел целиком,
 * а общий разбор аргументов ищет у него свойство `file`.
 */
export interface SnapshotItemNode {
  nodeType: 'item';
  file: string;
  snapshot: SnapshotFileInfo;
}

export type SnapshotTreeNode = SnapshotGroupNode | SnapshotItemNode;

export class SnapshotsTreeProvider implements vscode.TreeDataProvider<SnapshotTreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SnapshotTreeNode | undefined>();
  private readonly load: () => Promise<SnapshotFileInfo[]>;
  private groups: SnapshotGroupNode[] = [];

  readonly onDidChangeTreeData = this.emitter.event;

  constructor(load: () => Promise<SnapshotFileInfo[]>) {
    this.load = load;
    this.refresh();
  }

  /** Перечитывает каталог: после снятия снимка и по кнопке обновления. */
  refresh(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    let files: SnapshotFileInfo[] = [];
    try {
      files = await this.load();
    } catch {
      files = [];
    }

    this.groups = groupSnapshots(files).map(group => ({
      nodeType: 'group',
      snapshotKind: group.kind,
      files: group.files.map(snapshot => ({
        nodeType: 'item',
        file: snapshot.file,
        snapshot,
      })),
    }));
    this.emitter.fire(undefined);
  }

  getChildren(element?: SnapshotTreeNode): SnapshotTreeNode[] {
    if (element === undefined) {
      return this.groups;
    }

    return element.nodeType === 'group' ? element.files : [];
  }

  getTreeItem(node: SnapshotTreeNode): vscode.TreeItem {
    return node.nodeType === 'group' ? this.groupItem(node) : this.fileItem(node);
  }

  private groupItem(node: SnapshotGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      groupLabel(node.snapshotKind),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `snapshot-group:${node.snapshotKind}`;
    item.description = `${node.files.length}`;
    item.contextValue = node.snapshotKind === 'cpu' ? 'cpuSnapshotGroup' : 'memorySnapshotGroup';
    item.iconPath = new vscode.ThemeIcon(node.snapshotKind === 'cpu' ? 'pulse' : 'database');
    item.tooltip = groupDescription(node.snapshotKind);
    return item;
  }

  private fileItem(node: SnapshotItemNode): vscode.TreeItem {
    const { snapshot } = node;
    const name = path.basename(snapshot.file);
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.id = snapshot.file;
    item.resourceUri = vscode.Uri.file(snapshot.file);
    item.description = describe(snapshot);
    item.tooltip = new vscode.MarkdownString(`\`${snapshot.file}\`\n\n${describe(snapshot)}`);
    item.iconPath = new vscode.ThemeIcon(snapshot.kind === 'cpu' ? 'graph' : 'database');
    item.contextValue = snapshot.kind === 'cpu' ? 'cpuSnapshot' : 'memorySnapshot';
    item.command = snapshot.kind === 'cpu'
      ? {
          command: 'monitor-dotnet.openCpuSnapshot',
          title: translate('Open CPU snapshot'),
          arguments: [node],
        }
      : {
          command: 'monitor-dotnet.analyzeMemorySnapshot',
          title: translate('Analyse memory snapshot'),
          arguments: [node],
        };
    return item;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function groupLabel(kind: SnapshotKind): string {
  return kind === 'cpu' ? translate('CPU snapshots') : translate('Memory snapshots');
}

/** Подсказка группы: чем полезен вид и чего в нём нет. */
function groupDescription(kind: SnapshotKind): string {
  return kind === 'cpu'
    ? translate('Sampled CPU profiles: top methods, call tree, flame graph and comparison.')
    : translate('Managed heap by type only. For thread stacks, exceptions and locks, take a memory dump (.dmp).');
}

/** Подпись под именем: размер и время изменения файла. */
function describe(snapshot: SnapshotFileInfo): string {
  const modified = new Date(snapshot.modifiedMs).toLocaleString(localeTag(), {
    dateStyle: 'short',
    timeStyle: 'short',
  });
  return `${formatBytes(snapshot.bytes)} · ${modified}`;
}
