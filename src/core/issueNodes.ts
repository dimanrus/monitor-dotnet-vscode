/**
 * Превращение найденных проблем в узлы нативного дерева.
 *
 * Здесь только данные: идентификатор значка, подписи и интервал. Благодаря этому
 * отображение проверяется тестами без запуска VS Code.
 */

import type { ChartIssue, IssueSeverity } from './chartData.ts';
import { formatClockTime, formatDuration } from './formatting.ts';
import type { IssueProcess } from './issueStore.ts';
import { translate } from './locale.ts';

/** Узел дерева проблем: готовые к показу подписи и признак важности. */
export interface IssueNodeData {
  id: string;
  /** Заголовок проблемы — основная строка узла. */
  label: string;
  /** Время начала и длительность интервала. */
  description: string;
  /** Подробности во всплывающей подсказке. */
  tooltip: string;
  severity: IssueSeverity;
  /** Идентификатор значка темы. */
  iconId: string;
  /** Идентификатор цвета темы для значка или null, если цвет не нужен. */
  colorId: string | null;
  fromMs: number;
  toMs: number;
}

/** Описание значка по важности проблемы. */
const SEVERITY_ICONS: Record<IssueSeverity, { iconId: string; colorId: string | null }> = {
  critical: { iconId: 'error', colorId: 'errorForeground' },
  warning: { iconId: 'warning', colorId: 'editorWarning.foreground' },
  info: { iconId: 'info', colorId: 'editorInfo.foreground' },
};

/** Строит узлы дерева по списку проблем: порядок сохраняется (свежие сверху). */
export function buildIssueNodes(issues: readonly ChartIssue[]): IssueNodeData[] {
  return issues.map(issue => {
    const icon = SEVERITY_ICONS[issue.severity];
    return {
      id: issue.id,
      label: issue.title,
      description: `${formatClockTime(issue.fromMs)} · ${formatDuration(issue.toMs - issue.fromMs)}`,
      tooltip: `${translate('Interval: {0} — {1} ({2}).', formatClockTime(issue.fromMs), formatClockTime(issue.toMs), formatDuration(issue.toMs - issue.fromMs))}\n\n${issue.details}`,
      severity: issue.severity,
      iconId: icon.iconId,
      colorId: icon.colorId,
      fromMs: issue.fromMs,
      toMs: issue.toMs,
    };
  });
}

/** Проблема в дереве: узел и процесс, в котором она найдена. */
export interface IssueEntryData {
  data: IssueNodeData;
  /** Ключ процесса: по нему дерево отличает проблемы текущего процесса от истории. */
  processKey: string;
  /** Подпись процесса для сообщения о том, что интервала нет на графиках. */
  processLabel: string;
  /** Мониторится ли процесс сейчас: только его интервалы есть на графиках. */
  isCurrentProcess: boolean;
}

/** Процесс с найденными проблемами: подписи готовы к показу. */
export interface IssueProcessNodeData {
  key: string;
  label: string;
  description: string;
  tooltip: string;
  /** Раскрыт ли узел: раскрываем процесс, данные которого на графиках сейчас. */
  expanded: boolean;
  entries: IssueEntryData[];
}

/** Узел дерева проблем: процесс с проблемами или отдельная проблема. */
export type IssueTreeNodeData =
  | { kind: 'process'; process: IssueProcessNodeData }
  | { kind: 'entry'; entry: IssueEntryData };

/**
 * Строит дерево проблем по процессам.
 *
 * Группа процесса не появляется только в одном случае: когда процесс с проблемами один
 * и это тот самый процесс, данные которого на графиках. Тогда лишний уровень вложенности
 * мешал бы читать список. В остальных случаях группа нужна: она показывает, к какому
 * процессу относятся интервалы.
 */
export function buildIssueTree(groups: readonly IssueProcess[]): IssueTreeNodeData[] {
  const processes = groups.map(group => buildProcessNode(group));
  if (processes.length === 1 && processes[0].expanded) {
    return processes[0].entries.map(entry => ({ kind: 'entry' as const, entry }));
  }

  return processes.map(process => ({ kind: 'process' as const, process }));
}

/** Узел процесса: его проблемы и признак «данные этого процесса на графиках сейчас». */
function buildProcessNode(group: IssueProcess): IssueProcessNodeData {
  return {
    key: group.key,
    label: group.label,
    description: group.isCurrent
      ? `${group.issues.length} · ${translate('monitoring now')}`
      : String(group.issues.length),
    tooltip: group.label,
    expanded: group.isCurrent,
    entries: buildIssueNodes(group.issues).map(data => ({
      data,
      processKey: group.key,
      processLabel: group.label,
      isCurrentProcess: group.isCurrent,
    })),
  };
}
