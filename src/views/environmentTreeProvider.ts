/**
 * Панель Environment: переменные окружения и системные свойства мониторимого приложения —
 * Это данные панели «Окружение».
 */

import * as vscode from 'vscode';
import type { MonitorState } from '../core/monitorState.ts';
import { translate } from '../core/locale.ts';

/** Узел дерева окружения. */
interface EnvironmentNode {
  kind: 'group' | 'entry' | 'notice';
  id: string;
  label: string;
  description?: string;
  tooltip?: vscode.MarkdownString;
  children?: EnvironmentNode[];
}

export class EnvironmentTreeProvider implements vscode.TreeDataProvider<EnvironmentNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<EnvironmentNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private filter = '';

  private readonly state: MonitorState;

  constructor(state: MonitorState) {
    this.state = state;
    this.disposables.push({ dispose: this.state.onDidChange(() => this.emitter.fire(undefined)) });
  }

  readonly onDidChangeTreeData = this.emitter.event;

  getTreeItem(element: EnvironmentNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.label,
      element.children !== undefined && element.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );

    item.id = element.id;
    item.description = element.description;
    item.tooltip = element.tooltip;
    item.contextValue = element.kind;

    if (element.kind === 'group') {
      item.iconPath = new vscode.ThemeIcon('folder');
    } else if (element.kind === 'notice') {
      item.iconPath = new vscode.ThemeIcon('warning');
    }

    return item;
  }

  getChildren(element?: EnvironmentNode): EnvironmentNode[] {
    if (element !== undefined) {
      return element.children ?? [];
    }

    return this.buildRootNodes();
  }

  /** Устанавливает фильтр по имени переменной или свойства. */
  setFilter(filter: string): void {
    this.filter = filter.trim().toLowerCase();
    this.emitter.fire(undefined);
  }

  get currentFilter(): string {
    return this.filter;
  }

  dispose(): void {
    this.emitter.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private buildRootNodes(): EnvironmentNode[] {
    const environment = this.state.environment;
    if (environment === undefined) {
      return [{
        kind: 'notice',
        id: 'empty',
        label: this.state.isActive
          ? translate('Waiting for environment data…')
          : translate('Data appears after monitoring of a .NET application starts.'),
      }];
    }

    const nodes: EnvironmentNode[] = [];

    for (const warning of environment.warnings) {
      nodes.push({ kind: 'notice', id: `warning:${warning}`, label: warning });
    }

    const variables = this.applyFilter(environment.variables);
    const properties = this.applyFilter(environment.properties);

    nodes.push({
      kind: 'group',
      id: 'variables',
      label: translate('Environment variables'),
      description: translate('{0} of {1}', variables.length, environment.variables.length),
      children: variables.map(variable => this.entryNode('var', variable.key, variable.value)),
    });

    nodes.push({
      kind: 'group',
      id: 'properties',
      label: translate('System properties'),
      description: `${properties.length}`,
      children: properties.map(property => this.entryNode('prop', property.key, property.value)),
    });

    return nodes;
  }

  private applyFilter(entries: readonly { key: string; value: string }[]): { key: string; value: string }[] {
    if (this.filter.length === 0) {
      return [...entries];
    }

    return entries.filter(entry =>
      entry.key.toLowerCase().includes(this.filter) ||
      entry.value.toLowerCase().includes(this.filter));
  }

  private entryNode(prefix: string, key: string, value: string): EnvironmentNode {
    return {
      kind: 'entry',
      id: `${prefix}:${key}`,
      label: key,
      description: value,
      tooltip: new vscode.MarkdownString(`**${key}**\n\n\`\`\`\n${value}\n\`\`\``),
    };
  }
}
