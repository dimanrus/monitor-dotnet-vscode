/**
 * Панель Counters: провайдеры счётчиков и метры со значениями.
 * Провайдеры и метры — раскрываемые группы, значения обновляются на каждом срезе.
 */

import * as vscode from 'vscode';
import { groupCounters, type CounterGroupData, type CounterItemData } from '../core/counterGrouping.ts';
import type { MonitorState } from '../core/monitorState.ts';
import { translate } from '../core/locale.ts';

/** Узел дерева счётчиков: либо группа, либо значение. */
type CountersNode = { kind: 'group'; data: CounterGroupData } | { kind: 'item'; data: CounterItemData };

export class CountersTreeProvider implements vscode.TreeDataProvider<CountersNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CountersNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly state: MonitorState;

  constructor(state: MonitorState) {
    this.state = state;
    this.disposables.push({ dispose: this.state.onDidChange(() => this.emitter.fire(undefined)) });
  }

  readonly onDidChangeTreeData = this.emitter.event;

  getTreeItem(element: CountersNode): vscode.TreeItem {
    if (element.kind === 'item') {
      const item = new vscode.TreeItem(element.data.label, vscode.TreeItemCollapsibleState.None);
      item.id = element.data.key;
      item.description = element.data.description;
      item.tooltip = new vscode.MarkdownString(`\`\`\`\n${element.data.tooltip}\n\`\`\``);
      item.contextValue = 'counterValue';
      return item;
    }

    const group = new vscode.TreeItem(element.data.label, vscode.TreeItemCollapsibleState.Expanded);
    group.id = element.data.key;
    group.description = `${element.data.items.length}`;
    group.tooltip = new vscode.MarkdownString(
      element.data.kind === 'counter'
        ? translate('Counter provider **{0}** (EventCounters)', element.data.label)
        : translate('Meter **{0}** (System.Diagnostics.Metrics)', element.data.label),
    );
    group.iconPath = new vscode.ThemeIcon(element.data.kind === 'counter' ? 'symbol-method' : 'symbol-property');
    group.contextValue = element.data.kind;
    return group;
  }

  getChildren(element?: CountersNode): CountersNode[] {
    if (element === undefined) {
      const groups = this.buildGroups();
      if (groups.length === 0) {
        return [];
      }

      return groups.map(group => ({ kind: 'group' as const, data: group }));
    }

    if (element.kind === 'group') {
      return element.data.items.map(item => ({ kind: 'item' as const, data: item }));
    }

    return [];
  }

  private buildGroups(): CounterGroupData[] {
    return groupCounters(this.state.counters.values(), this.state.metrics.values());
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
