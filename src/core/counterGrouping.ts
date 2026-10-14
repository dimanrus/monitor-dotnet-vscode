/**
 * Группировка счётчиков и метрик для панели Counters.
 * Провайдеры (для счётчиков) и метры (для метрик) становятся раскрываемыми группами.
 */

import { formatCounterValue, formatMetricValue, describeCounter, describeMetric, truncate } from './formatting.ts';
import { localeTag } from './locale.ts';
import type { CounterSample, MetricSample } from './monitorState.ts';

/** Один элемент списка счётчиков/метрик. */
export interface CounterItemData {
  /** Уникальный ключ (используется для идентификации узла дерева). */
  key: string;
  /** Отображаемое имя счётчика или инструмента. */
  label: string;
  /** Текущее значение с единицами измерения. */
  description: string;
  /** Подсказка с подробностями. */
  tooltip: string;
}

/** Группа счётчиков одного провайдера или метрик одного метра. */
export interface CounterGroupData {
  key: string;
  label: string;
  kind: 'counter' | 'metric';
  items: CounterItemData[];
}

/**
 * Собирает группы: сначала счётчики провайдеров, затем метрики метров.
 * Группы и элементы внутри групп отсортированы по имени.
 */
export function groupCounters(
  counters: Iterable<CounterSample>,
  metrics: Iterable<MetricSample>,
): CounterGroupData[] {
  const counterGroups = new Map<string, CounterGroupData>();
  for (const counter of counters) {
    const group = counterGroups.get(counter.provider) ?? {
      key: `counter:${counter.provider}`,
      label: counter.provider,
      kind: 'counter' as const,
      items: [],
    };

    group.items.push({
      key: `counter:${counter.provider}:${counter.name}`,
      label: counter.displayName ?? counter.name,
      description: formatCounterValue(counter),
      tooltip: `${counter.provider} · ${counter.name}\n${describeCounter(counter)}`,
    });
    counterGroups.set(counter.provider, group);
  }

  const metricGroups = new Map<string, CounterGroupData>();
  for (const metric of metrics) {
    const group = metricGroups.get(metric.meter) ?? {
      key: `metric:${metric.meter}`,
      label: metric.meter,
      kind: 'metric' as const,
      items: [],
    };

    const tags = metric.tags ? ` ${truncate(metric.tags, 40)}` : '';
    group.items.push({
      key: `metric:${metric.meter}:${metric.instrument}:${metric.tags ?? ''}`,
      label: metric.instrument + tags,
      description: formatMetricValue(metric),
      tooltip: `${metric.meter} · ${metric.instrument}\n${describeMetric(metric)}`,
    });
    metricGroups.set(metric.meter, group);
  }

  return [...counterGroups.values(), ...metricGroups.values()]
    .map(group => ({
      ...group,
      items: group.items.sort((left, right) => left.label.localeCompare(right.label, localeTag())),
    }))
    .sort((left, right) => {
      const byLabel = left.label.localeCompare(right.label, localeTag());
      if (byLabel !== 0) {
        return byLabel;
      }

      // При одинаковых именах счётчики идут раньше метрик.
      return (left.kind === 'counter' ? 0 : 1) - (right.kind === 'counter' ? 0 : 1);
    });
}
