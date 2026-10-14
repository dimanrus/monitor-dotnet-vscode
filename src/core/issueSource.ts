/**
 * Единый источник найденных проблем.
 *
 * Списком проблем пользуются два места: панель графиков (полосы и список на canvas)
 * и нативное дерево «Проблемы». Чтобы они не расходились, обе стороны считают
 * проблемы одной и той же функцией на одном и том же наборе данных.
 *
 * Логика не зависит от API VS Code, поэтому её проверяют тесты.
 */

import { CHART_HISTORY_LIMIT, toChartGcEvent, toChartPoint, type ChartGcEvent, type ChartIssue } from './chartData.ts';
import { detectIssues, type IssueThresholds } from './issueDetection.ts';
import type { MonitorState } from './monitorState.ts';

/**
 * Собирает проблемы по текущему состоянию мониторинга.
 * `enabled` выключает поиск целиком — тогда список пуст.
 */
export function collectIssues(
  state: MonitorState,
  enabled: boolean,
  thresholds?: IssueThresholds,
): ChartIssue[] {
  if (!enabled || state.series.length === 0) {
    return [];
  }

  // История графиков ограничена, поэтому и анализ идёт по тому же срезу данных.
  const from = Math.max(0, state.series.length - CHART_HISTORY_LIMIT);
  const points = state.series.slice(from).map(toChartPoint);
  const gcEvents: ChartGcEvent[] = [];
  for (const event of state.gcEvents) {
    const converted = toChartGcEvent(event);
    if (converted !== undefined) {
      gcEvents.push(converted);
    }
  }

  return detectIssues(points, gcEvents, thresholds);
}

/**
 * Отпечаток списка проблем: по нему дерево понимает, нужно ли обновлять узлы.
 * Пересчитывать дерево на каждую принятую точку было бы накладно.
 */
export function issuesSignature(issues: readonly ChartIssue[]): string {
  return issues.map(issue => `${issue.id}:${issue.fromMs}:${issue.toMs}:${issue.severity}`).join('|');
}
