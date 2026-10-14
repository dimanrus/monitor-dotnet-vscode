/**
 * Панель «Проблемы»: найденные проблемы производительности в виде нативного дерева.
 *
 * Дерево показывает те же интервалы, что и список панели графиков, но работает без неё:
 * нажатие на узел выделяет интервал на графиках и раскрывает саму панель.
 *
 * Проблемы копятся по процессам, поэтому дерево их группирует: видно, к какому процессу
 * относится интервал. Выделить на графиках можно только проблемы процесса, чьи данные
 * на графиках сейчас; интервалы остальных остаются в дереве как история прогона.
 */

import * as vscode from 'vscode';
import { buildIssueTree, type IssueEntryData, type IssueProcessNodeData, type IssueTreeNodeData } from '../core/issueNodes.ts';
import { issuesSignature } from '../core/issueSource.ts';
import type { IssueProcess } from '../core/issueStore.ts';
import { translate } from '../core/locale.ts';
import type { MonitorState } from '../core/monitorState.ts';

/** Строка-пояснение, когда проблем нет вовсе. */
export interface EmptyNode {
  kind: 'empty';
  label: string;
  hint: string;
}

/** Узел дерева: процесс с проблемами, отдельная проблема или строка-пояснение. */
export type IssuesNode = EmptyNode | IssueTreeNodeData;

/** Как часто дерево проверяет, изменился ли список проблем. */
const REFRESH_INTERVAL_MS = 2000;

/** Всё, что нужно дереву: состояние мониторинга, проблемы по процессам и признак включённости. */
export interface IssuesTreeOptions {
  state: MonitorState;
  /** Возвращает процессы с найденными проблемами, текущий первым. */
  listGroups: () => IssueProcess[];
  /** Включён ли поиск проблем в настройках. */
  isEnabled: () => boolean;
}

export class IssuesTreeProvider implements vscode.TreeDataProvider<IssuesNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<IssuesNode | undefined>();
  private readonly timer: NodeJS.Timeout;
  /** Отписка от изменений состояния: монитор сообщает о каждой принятой точке. */
  private readonly stopStateChange: () => void;
  private readonly listGroups: () => IssueProcess[];
  private readonly isEnabled: () => boolean;

  private nodes: IssuesNode[] = [];
  /** Отпечаток прошлого состояния: дерево обновляется только при изменениях. */
  private signature = '';

  constructor(options: IssuesTreeOptions) {
    this.listGroups = options.listGroups;
    this.isEnabled = options.isEnabled;
    this.stopStateChange = options.state.onDidChange(() => this.refresh());
    this.timer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    this.timer.unref?.();
    this.refresh();
  }

  readonly onDidChangeTreeData = this.emitter.event;

  getTreeItem(element: IssuesNode): vscode.TreeItem {
    switch (element.kind) {
      case 'empty':
        return this.emptyItem(element);
      case 'process':
        return this.processItem(element.process);
      default:
        return this.issueItem(element.entry);
    }
  }

  getChildren(element?: IssuesNode): IssuesNode[] {
    if (element === undefined) {
      return this.nodes;
    }

    return element.kind === 'process'
      ? element.process.entries.map(entry => ({ kind: 'entry' as const, entry }))
      : [];
  }

  /** Пересчитывает проблемы и обновляет дерево, если список изменился. */
  refresh(): void {
    const enabled = this.isEnabledNow();
    const groups = enabled ? this.listGroups() : [];
    // Процесс и признак «мониторится сейчас» входят в отпечаток: при переключении
    // группы и их порядок меняются, а состав проблем при этом может и не измениться.
    const signature = `${enabled ? 'on' : 'off'}|${groups
      .map(group => `${group.key}${group.isCurrent ? '*' : ''}=${issuesSignature(group.issues)}`)
      .join(';')}`;
    if (signature === this.signature) {
      return;
    }

    this.signature = signature;
    this.nodes = groups.length === 0
      ? [{ kind: 'empty', label: this.emptyLabel(), hint: this.emptyHint() }]
      : buildIssueTree(groups);
    this.emitter.fire(undefined);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stopStateChange();
    this.emitter.dispose();
  }

  /** Узел проблемы: нажатие выделяет интервал на графиках. */
  private issueItem(entry: IssueEntryData): vscode.TreeItem {
    const { data } = entry;
    const item = new vscode.TreeItem(data.label, vscode.TreeItemCollapsibleState.None);
    // Идентификаторы уникальны внутри процесса, поэтому ключ процесса входит в идентификатор узла.
    item.id = `${entry.processKey}:${data.id}`;
    item.description = data.description;
    item.tooltip = data.tooltip;
    // У проблем другого процесса действие «показать на графиках» скрыто: его данных там уже нет.
    item.contextValue = entry.isCurrentProcess ? `issue.${data.severity}` : `issueHistory.${data.severity}`;
    item.iconPath = new vscode.ThemeIcon(
      data.iconId,
      data.colorId === null ? undefined : new vscode.ThemeColor(data.colorId),
    );
    item.command = {
      command: 'monitor-dotnet.selectIssueInterval',
      title: translate('Show on charts'),
      arguments: [{
        issueId: data.id,
        fromMs: data.fromMs,
        toMs: data.toMs,
        processKey: entry.processKey,
        processLabel: entry.processLabel,
      }],
    };

    return item;
  }

  /** Узел процесса: раскрыт у того процесса, данные которого сейчас на графиках. */
  private processItem(process: IssueProcessNodeData): vscode.TreeItem {
    const item = new vscode.TreeItem(
      process.label,
      process.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `process:${process.key}`;
    item.description = process.description;
    item.tooltip = process.tooltip;
    item.contextValue = 'issueProcess';
    item.iconPath = new vscode.ThemeIcon('server-process');
    return item;
  }

  /** Строка-пояснение вместо списка проблем. */
  private emptyItem(element: EmptyNode): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('check');
    item.tooltip = element.hint;
    item.contextValue = 'issueEmpty';
    return item;
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
