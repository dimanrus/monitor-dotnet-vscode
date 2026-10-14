/**
 * Панель «Проблемы»: найденные проблемы производительности в виде нативного дерева.
 *
 * Дерево показывает те же интервалы, что и список панели графиков, но работает без неё:
 * нажатие на узел выделяет интервал на графиках и раскрывает саму панель.
 */

import * as vscode from 'vscode';
import type { ChartIssue } from '../core/chartData.ts';
import { buildIssueNodes, type IssueNodeData } from '../core/issueNodes.ts';
import { issuesSignature } from '../core/issueSource.ts';
import { translate } from '../core/locale.ts';
import type { MonitorState } from '../core/monitorState.ts';

/** Узел дерева: либо проблема, либо строка-пояснение, когда проблем нет. */
export type IssuesNode =
  | { kind: 'issue'; data: IssueNodeData }
  | { kind: 'empty'; label: string; hint: string };

/** Как часто дерево проверяет, изменился ли список проблем. */
const REFRESH_INTERVAL_MS = 2000;

/** Всё, что нужно дереву: состояние мониторинга, поиск проблем и признак включённости. */
export interface IssuesTreeOptions {
  state: MonitorState;
  /** Возвращает найденные проблемы (пустой список, если поиск выключен). */
  collect: () => ChartIssue[];
  /** Включён ли поиск проблем в настройках. */
  isEnabled: () => boolean;
}

export class IssuesTreeProvider implements vscode.TreeDataProvider<IssuesNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<IssuesNode | undefined>();
  private readonly timer: NodeJS.Timeout;
  /** Отписка от изменений состояния: монитор сообщает о каждой принятой точке. */
  private readonly stopStateChange: () => void;
  private readonly collect: () => ChartIssue[];
  private readonly isEnabled: () => boolean;

  private issues: ChartIssue[] = [];
  private nodes: IssueNodeData[] = [];
  /** Отпечаток прошлого состояния: дерево обновляется только при изменениях. */
  private signature = '';

  constructor(options: IssuesTreeOptions) {
    this.collect = options.collect;
    this.isEnabled = options.isEnabled;
    this.stopStateChange = options.state.onDidChange(() => this.refresh());
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref?.();
    this.refresh();
  }

  readonly onDidChangeTreeData = this.emitter.event;

  /** Текущий список проблем: по нему находит интервал команда перехода к графику. */
  list(): readonly ChartIssue[] {
    return this.issues;
  }

  getTreeItem(element: IssuesNode): vscode.TreeItem {
    if (element.kind === 'empty') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('check');
      item.tooltip = element.hint;
      item.contextValue = 'issueEmpty';
      return item;
    }

    const item = new vscode.TreeItem(element.data.label, vscode.TreeItemCollapsibleState.None);
    item.id = element.data.id;
    item.description = element.data.description;
    item.tooltip = element.data.tooltip;
    item.contextValue = `issue.${element.data.severity}`;
    item.iconPath = new vscode.ThemeIcon(
      element.data.iconId,
      element.data.colorId === null ? undefined : new vscode.ThemeColor(element.data.colorId),
    );
    // Нажатие выделяет интервал на графиках — та же логика, что у списка в панели графиков.
    item.command = {
      command: 'monitor-dotnet.selectIssueInterval',
      title: translate('Show on charts'),
      arguments: [{ fromMs: element.data.fromMs, toMs: element.data.toMs }],
    };

    return item;
  }

  getChildren(element?: IssuesNode): IssuesNode[] {
    if (element !== undefined) {
      return [];
    }

    if (this.nodes.length > 0) {
      return this.nodes.map(data => ({ kind: 'issue' as const, data }));
    }

    return [{ kind: 'empty', label: this.emptyLabel(), hint: this.emptyHint() }];
  }

  /** Пересчитывает проблемы и обновляет дерево, если список изменился. */
  refresh(): void {
    const enabled = this.isEnabledNow();
    const issues = enabled ? this.collect() : [];
    const signature = `${enabled ? 'on' : 'off'}|${issuesSignature(issues)}`;
    if (signature === this.signature) {
      return;
    }

    this.signature = signature;
    this.issues = issues;
    this.nodes = buildIssueNodes(issues);
    this.emitter.fire(undefined);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stopStateChange();
    this.emitter.dispose();
  }

  /** Текст заглушки: зависит от того, выключен ли поиск проблем. */
  private emptyLabel(): string {
    return this.isEnabledNow() ? translate('No issues detected yet') : translate('Issue detection is off');
  }

  /** Пояснение к заглушке. */
  private emptyHint(): string {
    return this.isEnabledNow()
      ? translate('Suspicious intervals appear here while monitoring runs.')
      : translate('Turn on the monitor-dotnet.enableIssueDetection setting to look for issues.');
  }

  /** Чтение настройки не должно ломать дерево, поэтому исключение считаем «включено». */
  private isEnabledNow(): boolean {
    try {
      return this.isEnabled();
    } catch {
      return true;
    }
  }
}
