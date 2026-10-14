/**
 * Превращение найденных проблем в узлы нативного дерева.
 *
 * Здесь только данные: идентификатор значка, подписи и интервал. Благодаря этому
 * отображение проверяется тестами без запуска VS Code.
 */

import type { ChartIssue, IssueSeverity } from './chartData.ts';
import { formatClockTime, formatDuration } from './formatting.ts';
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
