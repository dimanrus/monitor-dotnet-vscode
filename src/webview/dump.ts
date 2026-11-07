/**
 * Графическая панель разбора дампа (выполняется внутри webview).
 *
 * Панель повторяет оформление панелей VS Code: секции с заголовками, компактные
 * метрики, таблицы с полосами распределения и автоматические наблюдения.
 * Тексты присылает расширение: внутри webview нет API локализации VS Code.
 */

import {
  DEFAULT_DUMP_WEBVIEW_STRINGS,
  type DumpWebviewStrings,
} from '../core/dumpWebviewStrings.ts';
import { formatBytes } from '../core/formatting.ts';
import { configureLocale, formatTemplate, localeTag } from '../core/locale.ts';
import type {
  DumpComparison,
  DumpExceptionInfo,
  DumpFinding,
  DumpReport,
  DumpReportSection,
  DumpSectionBlock,
  DumpStackFrame,
  DumpTableBlock,
  DumpTableColumn,
  DumpThreadStack,
  HeapStatSummary,
  TypeChange,
} from '../monitor/dumpAnalysis.ts';
import './dump.css';

/** По какому показателю сортировать таблицу кучи. */
type Metric = 'size' | 'count';

interface IncomingMessage {
  type: 'report' | 'comparison';
  report?: DumpReport;
  comparison?: DumpComparison;
  strings?: DumpWebviewStrings;
  locale?: string;
}

type OutgoingMessage =
  | { type: 'ready' }
  | { type: 'openText' }
  | { type: 'problem'; message: string };

interface VsCodeApi {
  postMessage(message: OutgoingMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** Сколько символов вывода одной команды показывать: остальное — в текстовом отчёте. */
const OUTPUT_PREVIEW_LIMIT = 40_000;

/** Сколько типов показывать в диаграмме распределения. */
const STACK_SEGMENTS = 5;

/** Сколько строк таблицы показывать на одной странице. */
const PAGE_SIZE = 25;

/** Сколько стеков потоков и карточек исключений показывать на странице. */
const STACK_PAGE_SIZE = 8;
const EXCEPTION_PAGE_SIZE = 5;

let report: DumpReport | undefined;
let comparison: DumpComparison | undefined;
let strings: DumpWebviewStrings = DEFAULT_DUMP_WEBVIEW_STRINGS;

/** Свёрнутые разделы: состояние переживает перерисовку панели. */
const collapsedPanels = new Set<string>();

window.addEventListener('message', event => {
  const message = event.data as IncomingMessage;
  if (message.type !== 'report' && message.type !== 'comparison') {
    return;
  }

  if (message.type === 'comparison') {
    comparison = message.comparison;
    report = undefined;
  } else {
    report = message.report;
    comparison = undefined;
  }

  strings = message.strings ?? strings;
  if (message.locale !== undefined) {
    configureLocale(message.locale);
  }

  try {
    render();
  } catch (error) {
    postProblem(error instanceof Error ? error.message : String(error));
  }
});

vscode.postMessage({ type: 'ready' });

/** Перерисовывает панель целиком: данных немного, это проще точечных обновлений. */
function render(): void {
  if (comparison !== undefined) {
    renderComparison(comparison);
    return;
  }

  if (report === undefined) {
    return;
  }

  document.title = strings.title;
  const root = byId('root');
  root.textContent = '';
  root.append(renderHeader(report));

  const overview = renderOverview(report);
  if (overview !== undefined) {
    root.append(overview);
  }

  const findings = renderFindings(report.findings);
  if (findings !== undefined) {
    root.append(findings);
  }

  root.append(...renderViews(report));
  root.append(renderDetails(report));
}

/** Шапка: тип отчёта, имя дампа, полный путь, время и кнопка текстового отчёта. */
function renderHeader(current: DumpReport): HTMLElement {
  const header = el('header', 'toolbar');
  const text = el('div', 'toolbar-text');
  const title = el('h1', 'toolbar-title', baseName(current.dumpFile));
  const meta = el('div', 'meta-row');
  if (current.takenAt !== undefined) {
    const size = current.dumpBytes === undefined ? '' : ` · ${formatBytes(current.dumpBytes)}`;
    meta.append(el('span', 'meta', `${formatTemplate(strings.taken, current.takenAt)}${size}`));
  }

  meta.append(el('span', 'meta subtle', formatTemplate(strings.generated, current.generatedAt)));
  text.append(
    el('div', 'eyebrow', strings.title),
    title,
    el('div', 'path', current.dumpFile),
    meta,
  );

  const openText = el('button', 'secondary', strings.openTextReport);
  openText.type = 'button';
  openText.addEventListener('click', () => vscode.postMessage({ type: 'openText' }));

  header.append(text, openText);
  return header;
}

/** Секция панели: заголовок с подписью и тело. Заголовок сворачивает секцию. */
function panel(
  title: string,
  subtitle?: string,
): { section: HTMLElement; head: HTMLElement; body: HTMLElement } {
  const section = el('section', 'panel');
  const head = el('div', 'panel-head');
  const titles = el('div', 'panel-titles');
  titles.append(el('h2', undefined, title));
  if (subtitle !== undefined && subtitle.length > 0) {
    titles.append(el('p', 'panel-sub', subtitle));
  }

  const collapsed = collapsedPanels.has(title);
  const toggle = el('button', 'panel-toggle', collapsed ? '▸' : '▾');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.title = collapsed ? strings.expandSection : strings.collapseSection;
  toggle.setAttribute('aria-label', toggle.title);

  const apply = (value: boolean): void => {
    section.classList.toggle('collapsed', value);
    toggle.textContent = value ? '▸' : '▾';
    toggle.setAttribute('aria-expanded', String(!value));
    toggle.title = value ? strings.expandSection : strings.collapseSection;
    toggle.setAttribute('aria-label', toggle.title);
    if (value) {
      collapsedPanels.add(title);
    } else {
      collapsedPanels.delete(title);
    }
  };

  toggle.addEventListener('click', event => {
    event.stopPropagation();
    apply(!section.classList.contains('collapsed'));
  });
  head.addEventListener('click', () => apply(!section.classList.contains('collapsed')));
  if (collapsed) {
    apply(true);
  }

  head.append(titles, toggle);
  const body = el('div', 'panel-body');
  section.append(head, body);
  return { section, head, body };
}

/** Пагинатор списка: стрелки и подпись «страница X из Y». */
interface Pager {
  element: HTMLElement;
  update(totalRows: number, page: number): void;
}

function renderPager(pageSize: number, onPage: (page: number) => void): Pager {
  const group = el('div', 'pager');
  const previous = el('button', 'secondary pager-button', '‹');
  previous.type = 'button';
  previous.title = strings.previousPage;
  previous.setAttribute('aria-label', strings.previousPage);

  const next = el('button', 'secondary pager-button', '›');
  next.type = 'button';
  next.title = strings.nextPage;
  next.setAttribute('aria-label', strings.nextPage);

  const label = el('span', 'pager-label');
  let totalPages = 1;
  let currentPage = 0;

  previous.addEventListener('click', () => {
    if (currentPage > 0) {
      onPage(currentPage - 1);
    }
  });

  next.addEventListener('click', () => {
    if (currentPage < totalPages - 1) {
      onPage(currentPage + 1);
    }
  });

  group.append(previous, label, next);
  return {
    element: group,
    update(totalRows: number, page: number): void {
      totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      currentPage = Math.min(Math.max(0, page), totalPages - 1);
      label.textContent = formatTemplate(strings.pageOf, currentPage + 1, totalPages);
      previous.disabled = currentPage === 0;
      next.disabled = currentPage >= totalPages - 1;
      group.hidden = totalPages <= 1;
    },
  };
}

interface MetricItem {
  label: string;
  value: string;
}

/** Компактные метрики в сетке: подпись сверху, значение снизу. */
function renderMetrics(items: MetricItem[]): HTMLElement {
  const grid = el('div', 'metrics');
  for (const item of items) {
    const metricBox = el('div', 'metric');
    metricBox.append(
      el('div', 'metric-label', item.label),
      el('div', 'metric-value', item.value),
    );
    grid.append(metricBox);
  }

  return grid;
}

/** Обзор: только те показатели, которые удалось разобрать из дампа. */
function renderOverview(current: DumpReport): HTMLElement | undefined {
  const items: MetricItem[] = [];
  const heap = current.heap;

  if (heap !== undefined) {
    items.push(
      { label: strings.tileManagedHeap, value: formatBytes(heap.totalSize) },
      { label: strings.tileObjects, value: count(heap.totalCount) },
      { label: strings.tileTypes, value: count(current.typeCount ?? heap.entries.length) },
    );
  }

  if (current.gcHeap?.committed !== undefined) {
    items.push({ label: strings.tileGcCommitted, value: formatBytes(current.gcHeap.committed) });
  }

  if (current.threads !== undefined) {
    items.push({ label: strings.tileThreads, value: count(current.threads.total) });
  }

  if (current.async !== undefined) {
    items.push({ label: strings.tileAsync, value: count(current.async.total) });
  }

  if (current.exceptions !== undefined) {
    items.push({ label: strings.tileExceptions, value: count(current.exceptions.totalCount) });
  }

  if (current.syncBlockCount !== undefined) {
    items.push({ label: strings.tileSyncBlocks, value: count(current.syncBlockCount) });
  }

  if (current.finalizable !== undefined) {
    items.push({ label: strings.tileFinalizable, value: count(current.finalizable.total) });
  }

  if (items.length === 0) {
    return undefined;
  }

  const { section, body } = panel(strings.sectionOverview);
  body.append(renderMetrics(items));
  return section;
}

/** Наблюдения: то, на что стоит посмотреть в первую очередь. */
function renderFindings(findings: readonly DumpFinding[]): HTMLElement | undefined {
  if (findings.length === 0) {
    return undefined;
  }

  const { section, body } = panel(strings.findingsTitle, strings.findingsSubtitle);
  const list = el('ul', 'findings');
  for (const finding of findings) {
    list.append(renderFinding(finding));
  }

  body.append(list);
  return section;
}

function renderFinding(finding: DumpFinding): HTMLElement {
  const item = el('li', `finding ${finding.level}`);
  const dot = el('span', 'finding-dot');
  dot.title = finding.level === 'warning' ? strings.findingWarning : strings.findingInfo;

  const text = el('div', 'finding-text');
  text.append(
    el('div', 'finding-title', finding.title),
    el('div', 'finding-detail', finding.detail),
  );

  item.append(dot, text);
  return item;
}

/** Заполняет страницу таблицы кучи и возвращает число строк и текущую страницу. */
function fillHeapRows(
  tbody: HTMLElement,
  heap: HeapStatSummary,
  current: Metric,
  query: string,
  page: number,
): { total: number; page: number } {
  const rows = heapRows(heap, current, query);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = currentPage * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  tbody.textContent = '';
  if (pageRows.length === 0) {
    const emptyRow = el('tr');
    const cell = el('td', 'empty-cell', strings.noMatches);
    cell.colSpan = 4;
    emptyRow.append(cell);
    tbody.append(emptyRow);
    return { total: rows.length, page: currentPage };
  }

  for (const row of pageRows) {
    tbody.append(renderTableRow(row, true));
  }

  return { total: rows.length, page: currentPage };
}

interface TableRow {
  typeName: string;
  count?: number;
  size?: number;
  /** Доля в итоге в процентах. */
  share: number;
}

function heapRows(heap: HeapStatSummary, current: Metric, query: string): TableRow[] {
  const total = current === 'size' ? heap.totalSize : heap.totalCount;
  return heap.entries
    .filter(entry => query.length === 0 || entry.typeName.toLocaleLowerCase().includes(query))
    .sort((left, right) => (current === 'size' ? right.size - left.size : right.count - left.count))
    .map(entry => {
      const value = current === 'size' ? entry.size : entry.count;
      return {
        typeName: entry.typeName,
        count: entry.count,
        size: entry.size,
        share: total === 0 ? 0 : (value / total) * 100,
      };
    });
}

/** Одна строка таблицы: тип, количество, размер и полоса с долей. */
function renderTableRow(row: TableRow, showSize: boolean): HTMLTableRowElement {
  const tr = el('tr');

  const typeCell = el('td', 'type-cell');
  const typeName = el('bdi', undefined, row.typeName);
  typeCell.append(typeName);
  typeCell.title = row.typeName;
  tr.append(typeCell);

  tr.append(el('td', 'num', row.count === undefined ? '—' : count(row.count)));
  if (showSize) {
    tr.append(el('td', 'num', row.size === undefined ? '—' : formatBytes(row.size)));
  }

  tr.append(renderShareCell(row.share));
  return tr;
}

/** Ячейка доли: тонкая полоса и процент. */
function renderShareCell(share: number): HTMLTableCellElement {
  const cell = el('td', 'share-cell');
  const meter = el('div', 'meter');
  const fill = el('div', 'meter-fill');
  fill.style.width = `${Math.min(100, Math.max(0, share))}%`;
  meter.append(fill);
  cell.append(meter, el('span', 'share-value', `${share.toFixed(1)}%`));
  return cell;
}

/** Состав кучи: одна полоса с крупнейшими типами и «остальные». */
function renderStack(heap: HeapStatSummary): HTMLElement {
  const wrapper = el('div', 'stack-wrap');
  const stack = el('div', 'stack');
  const legend = el('div', 'stack-legend');

  const top = [...heap.entries].sort((left, right) => right.size - left.size).slice(0, STACK_SEGMENTS);
  for (const [index, entry] of top.entries()) {
    const share = heap.totalSize === 0 ? 0 : (entry.size / heap.totalSize) * 100;
    const segment = el('div', `stack-seg seg-${index}`);
    segment.style.width = `${share}%`;
    segment.title = `${entry.typeName} — ${formatBytes(entry.size)} (${share.toFixed(1)}%)`;
    stack.append(segment);
    legend.append(renderLegendItem(`seg-${index}`, entry.typeName, `${share.toFixed(1)}%`));
  }

  const topSize = top.reduce((sum, entry) => sum + entry.size, 0);
  const otherSize = heap.totalSize - topSize;
  if (otherSize > 0) {
    const share = (otherSize / heap.totalSize) * 100;
    const segment = el('div', 'stack-seg seg-other');
    segment.style.width = `${share}%`;
    segment.title = `${strings.otherTypes} — ${formatBytes(otherSize)} (${share.toFixed(1)}%)`;
    stack.append(segment);
    legend.append(renderLegendItem('seg-other', strings.otherTypes, `${share.toFixed(1)}%`));
  }

  wrapper.append(stack, legend);
  return wrapper;
}

function renderLegendItem(colorClass: string, label: string, value: string): HTMLElement {
  const item = el('div', 'legend-item');
  item.append(
    el('span', `legend-dot ${colorClass}`),
    el('span', 'legend-label', label),
    el('span', 'legend-value', value),
  );
  return item;
}

/** Переключатель «по размеру / по количеству»: сообщает выбранный показатель. */
function renderMetricSwitch(current: Metric, onChange: (next: Metric) => void): HTMLElement {
  const group = el('div', 'segmented');
  group.setAttribute('role', 'group');

  const options: Array<{ value: Metric; label: string }> = [
    { value: 'size', label: strings.metricBySize },
    { value: 'count', label: strings.metricByCount },
  ];
  let active = current;

  for (const option of options) {
    const button = el('button', undefined, option.label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(active === option.value));
    button.addEventListener('click', () => {
      if (active === option.value) {
        return;
      }

      active = option.value;
      for (const sibling of group.querySelectorAll('button')) {
        sibling.setAttribute('aria-pressed', String(sibling === button));
      }

      onChange(option.value);
    });
    group.append(button);
  }

  return group;
}

/**
 * Панели с разобранными данными: по одной на команду.
 * Расширение уже убрало повторы, поэтому каждая команда показывается один раз.
 */
function renderViews(current: DumpReport): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const view of current.views ?? []) {
    const heapBlock = view.blocks.find(
      (block): block is Extract<DumpSectionBlock, { kind: 'heapTypes' }> => block.kind === 'heapTypes',
    );
    const subtitle = heapBlock === undefined
      ? undefined
      : formatTemplate(
        strings.heapSubtitle,
        count(heapBlock.heap.totalCount),
        formatBytes(heapBlock.heap.totalSize),
        count(heapBlock.typeCount),
      );

    const { section, body } = panel(view.title, subtitle);
    for (const block of view.blocks) {
      if (block.kind === 'heapTypes') {
        body.append(el('h3', 'subhead', strings.distributionTitle));
        body.append(renderStack(block.heap));
      }

      body.append(renderBlock(block));
    }

    result.push(section);
  }

  return result;
}

/** Полный вывод команд — в сворачиваемых блоках, чтобы не мешал обзору. */
function renderDetails(current: DumpReport): HTMLElement {
  const { section, body } = panel(strings.detailsTitle);
  for (const item of current.sections) {
    body.append(renderDetail(item));
  }

  return section;
}

/** В «Деталях» остаётся только исходный вывод команды. */
function renderDetail(section: DumpReportSection): HTMLElement {
  const details = el('details', 'detail');
  const summary = el('summary');
  summary.append(
    el('span', 'summary-title', section.title),
    el('code', 'summary-command', section.commands.join('; ')),
  );

  details.append(summary);
  if (section.output.trim().length === 0) {
    details.append(el('p', 'empty', strings.noOutput));
    return details;
  }

  const truncated = section.output.length > OUTPUT_PREVIEW_LIMIT;
  const pre = el('pre');
  pre.textContent = truncated ? section.output.slice(0, OUTPUT_PREVIEW_LIMIT) : section.output;
  details.append(pre);
  if (truncated) {
    details.append(el('p', 'truncated', strings.truncated));
  }

  return details;
}

/** Интерактивный блок: таблица, стек потоков, полоса состава или исключение. */
function renderBlock(block: DumpSectionBlock): HTMLElement {
  switch (block.kind) {
    case 'metrics':
      return wrapBlock(renderMetrics(block.items));
    case 'meter':
      return wrapBlock(renderMeter(block.fraction, `${block.label}: ${block.value}`));
    case 'table':
      return renderTableBlock(block);
    case 'heapTypes':
      return renderHeapTypesBlock(block.heap, block.typeCount);
    case 'stacks':
      return renderStacksBlock(block.threads);
    case 'bar':
      return renderBarBlock(block);
    case 'exceptions':
      return renderExceptionsBlock(block);
  }
}

/** Общая обёртка блока: одинаковые отступы и рамка. */
function wrapBlock(content: HTMLElement): HTMLElement {
  const wrapper = el('div', 'detail-block');
  wrapper.append(content);
  return wrapper;
}

/** Таблица с поиском, пагинацией и колонкой доли. */
function renderTableBlock(block: DumpTableBlock): HTMLElement {
  const wrapper = el('div', 'detail-block');
  if (block.rows.length === 0) {
    wrapper.append(el('p', 'empty', block.empty ?? strings.noMatches));
    return wrapper;
  }

  const table = el('table', 'grid detail-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const column of block.columns) {
    headRow.append(el('th', column.numeric === true ? 'num' : undefined, column.label));
  }

  if (block.showShare === true) {
    headRow.append(el('th', 'share-head', strings.share));
  }

  thead.append(headRow);
  const tbody = el('tbody');
  table.append(thead, tbody);

  let filter = '';
  let page = 0;
  const pager = renderPager(PAGE_SIZE, nextPage => {
    page = nextPage;
    fill();
  });

  const fill = (): void => {
    const rows = block.rows.filter(row => filter.length === 0
      || row.cells.some(cell => String(cell).toLocaleLowerCase().includes(filter)));
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(Math.max(0, page), totalPages - 1);
    const start = page * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);

    tbody.textContent = '';
    if (pageRows.length === 0) {
      const emptyRow = el('tr');
      const cell = el('td', 'empty-cell', block.empty ?? strings.noMatches);
      cell.colSpan = block.columns.length + (block.showShare === true ? 1 : 0);
      emptyRow.append(cell);
      tbody.append(emptyRow);
      pager.update(rows.length, page);
      return;
    }

    for (const row of pageRows) {
      const tr = el('tr');
      for (const [index, column] of block.columns.entries()) {
        tr.append(renderDetailCell(column, row.cells[index] ?? ''));
      }

      if (block.showShare === true) {
        tr.append(renderShareCell(row.share ?? 0));
      }

      tbody.append(tr);
    }

    pager.update(rows.length, page);
  };

  const tools = el('div', 'detail-tools');
  const input = el('input', 'filter');
  input.type = 'search';
  const placeholder = block.filterPlaceholder ?? strings.filterRows;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  input.addEventListener('input', () => {
    filter = input.value.trim().toLocaleLowerCase();
    page = 0;
    fill();
  });
  tools.append(input, pager.element);
  wrapper.append(tools);

  wrapper.append(table);
  if (block.note !== undefined) {
    wrapper.append(el('p', 'note', block.note));
  }

  fill();
  return wrapper;
}

/** Ячейка таблицы: числа форматируются по локали, широкие — как имена типов. */
function renderDetailCell(column: DumpTableColumn, value: string | number): HTMLTableCellElement {
  const text = typeof value === 'number'
    ? column.format === 'bytes' ? formatBytes(value) : count(value)
    : value;

  if (column.wide === true) {
    const cell = el('td', 'type-cell');
    cell.append(el('bdi', undefined, text));
    cell.title = text;
    return cell;
  }

  return el('td', column.numeric === true ? 'num' : undefined, text);
}

/** Таблица типов кучи: поиск, пагинация и переключатель показателя. */
function renderHeapTypesBlock(heap: HeapStatSummary, typeCount: number): HTMLElement {
  const wrapper = el('div', 'detail-block');
  let currentMetric: Metric = 'size';
  let currentFilter = '';
  let page = 0;

  const tbody = el('tbody');
  const pager = renderPager(PAGE_SIZE, nextPage => {
    page = nextPage;
    fill();
  });

  const fill = (): void => {
    const filled = fillHeapRows(tbody, heap, currentMetric, currentFilter, page);
    page = filled.page;
    pager.update(filled.total, page);
  };

  const tools = el('div', 'detail-tools');
  const input = el('input', 'filter');
  input.type = 'search';
  input.placeholder = strings.filterHeap;
  input.setAttribute('aria-label', strings.filterHeap);
  input.addEventListener('input', () => {
    currentFilter = input.value.trim().toLocaleLowerCase();
    page = 0;
    fill();
  });

  tools.append(input, renderMetricSwitch(currentMetric, next => {
    currentMetric = next;
    page = 0;
    fill();
  }), pager.element);
  wrapper.append(tools);

  const table = el('table', 'grid');
  const headRow = el('tr');
  headRow.append(
    el('th', undefined, strings.type),
    el('th', 'num', strings.count),
    el('th', 'num', strings.size),
    el('th', 'share-head', strings.share),
  );
  const thead = el('thead');
  thead.append(headRow);
  table.append(thead, tbody);
  wrapper.append(table);

  if (typeCount > heap.entries.length) {
    wrapper.append(el('p', 'note', formatTemplate(strings.showingLargest, heap.entries.length)));
  }

  fill();
  return wrapper;
}

/** Стеки потоков: фильтр, скрытие кадров рантайма и раскрытие всех стеков. */
function renderStacksBlock(threads: readonly DumpThreadStack[]): HTMLElement {
  const wrapper = el('div', 'detail-block');
  if (threads.length === 0) {
    wrapper.append(el('p', 'empty', strings.noStacks));
    return wrapper;
  }

  const tools = el('div', 'detail-tools');
  const input = el('input', 'filter');
  input.type = 'search';
  input.placeholder = strings.filterStacks;
  input.setAttribute('aria-label', strings.filterStacks);

  const runtimeLabel = el('label', 'toggle');
  const runtimeInput = el('input');
  runtimeInput.type = 'checkbox';
  runtimeInput.checked = true;
  runtimeLabel.append(runtimeInput, el('span', undefined, strings.showRuntimeFrames));

  const expand = el('button', 'secondary', strings.expandAll);
  expand.type = 'button';
  const collapse = el('button', 'secondary', strings.collapseAll);
  collapse.type = 'button';

  let page = 0;
  const pager = renderPager(STACK_PAGE_SIZE, nextPage => {
    page = nextPage;
    apply();
  });
  tools.append(input, runtimeLabel, expand, collapse, pager.element);
  wrapper.append(tools);

  const list = el('div', 'thread-list');
  const items: Array<{ element: HTMLDetailsElement; search: string }> = [];

  for (const thread of threads) {
    const item = el('details', 'thread');
    const summary = el('summary');
    const titles = el('div', 'thread-titles');
    const top = thread.frames.find(frame => !frame.system) ?? thread.frames[0];
    const topMethod = top === undefined ? strings.noFrames : top.method;
    const title = el('div', 'thread-top', topMethod);
    title.title = topMethod;
    titles.append(
      el('span', 'thread-os', `OS ${thread.osId}${thread.id === undefined ? '' : ` · ID ${thread.id}`}`),
      title,
    );
    const frames = el('span', 'frame-count', formatTemplate(strings.threadFrames, thread.frames.length));
    summary.append(titles, frames);
    item.append(summary);
    item.append(thread.frames.length === 0
      ? el('p', 'empty', strings.noFrames)
      : renderFrames(thread.frames));
    item.open = thread === threads[0];
    list.append(item);
    items.push({
      element: item,
      search: [thread.osId, ...thread.frames.map(frame => `${frame.method} ${frame.location ?? ''}`)]
        .join(' ')
        .toLocaleLowerCase(),
    });
  }

  const apply = (): void => {
    const query = input.value.trim().toLocaleLowerCase();
    const filtered = items.filter(item => query.length === 0 || item.search.includes(query));
    const totalPages = Math.max(1, Math.ceil(filtered.length / STACK_PAGE_SIZE));
    page = Math.min(Math.max(0, page), totalPages - 1);
    const start = page * STACK_PAGE_SIZE;
    const visible = new Set(filtered.slice(start, start + STACK_PAGE_SIZE));
    for (const item of items) {
      item.element.hidden = !visible.has(item);
    }

    pager.update(filtered.length, page);
  };

  input.addEventListener('input', () => {
    page = 0;
    apply();
  });

  runtimeInput.addEventListener('change', () => {
    list.classList.toggle('hide-runtime', !runtimeInput.checked);
  });

  collapse.addEventListener('click', () => {
    for (const item of items) {
      if (!item.element.hidden) {
        item.element.open = false;
      }
    }
  });

  expand.addEventListener('click', () => {
    for (const item of items) {
      if (!item.element.hidden) {
        item.element.open = true;
      }
    }
  });

  wrapper.append(list);
  apply();
  return wrapper;
}

/** Кадры стека: кадры приложения выделены, служебные приглушены. */
function renderFrames(frames: readonly DumpStackFrame[]): HTMLElement {
  const list = el('ol', 'frames');
  for (const frame of frames) {
    const item = el('li', `frame ${frame.system ? 'frame-sys' : 'frame-app'}`);
    const method = el('span', 'frame-method');
    const dot = frame.method.lastIndexOf('.');
    if (dot > 0) {
      method.append(
        el('span', 'frame-namespace', frame.method.slice(0, dot + 1)),
        el('span', undefined, frame.method.slice(dot + 1)),
      );
    } else {
      method.textContent = frame.method;
    }

    method.title = frame.method;
    item.append(method);
    if (frame.location !== undefined) {
      const location = el('span', 'frame-loc', frame.location);
      location.title = frame.location;
      item.append(location);
    }

    list.append(item);
  }

  return list;
}

/** Полоса состава: сегменты кучи или поколения очереди финализации. */
function renderBarBlock(block: Extract<DumpSectionBlock, { kind: 'bar' }>): HTMLElement {
  const wrapper = el('div', 'detail-block');
  const total = block.segments.reduce((sum, segment) => sum + segment.value, 0);
  const stack = el('div', 'stack');
  const legend = el('div', 'stack-legend');

  for (const [index, segment] of block.segments.entries()) {
    const share = total === 0 ? 0 : (segment.value / total) * 100;
    const colorClass = index < STACK_SEGMENTS ? `seg-${index}` : 'seg-other';
    const part = el('div', `stack-seg ${colorClass}`);
    part.style.width = `${share}%`;
    const value = formatBarValue(block.unit, segment.value);
    part.title = `${segment.label} — ${value} (${share.toFixed(1)}%)`;
    stack.append(part);
    legend.append(renderLegendItem(colorClass, segment.label, value));
  }

  wrapper.append(stack, legend);
  if (block.note !== undefined) {
    wrapper.append(el('p', 'note', block.note));
  }

  return wrapper;
}

function formatBarValue(unit: 'bytes' | 'count', value: number): string {
  return unit === 'bytes' ? formatBytes(value) : count(value);
}

/** Исключения: карточки с поиском и пагинацией. */
function renderExceptionsBlock(block: Extract<DumpSectionBlock, { kind: 'exceptions' }>): HTMLElement {
  const wrapper = el('div', 'detail-block');
  if (block.entries.length === 0) {
    wrapper.append(el('p', 'empty', block.empty ?? strings.noOutput));
    return wrapper;
  }

  const tools = el('div', 'detail-tools');
  const input = el('input', 'filter');
  input.type = 'search';
  input.placeholder = strings.filterRows;
  input.setAttribute('aria-label', strings.filterRows);

  const list = el('div', 'exception-list');
  let filter = '';
  let page = 0;
  const pager = renderPager(EXCEPTION_PAGE_SIZE, nextPage => {
    page = nextPage;
    fill();
  });

  const fill = (): void => {
    const entries = block.entries.filter(entry => filter.length === 0
      || [entry.typeName, entry.message, entry.inner, entry.address]
        .some(value => value !== undefined && value.toLocaleLowerCase().includes(filter)));
    const totalPages = Math.max(1, Math.ceil(entries.length / EXCEPTION_PAGE_SIZE));
    page = Math.min(Math.max(0, page), totalPages - 1);
    const start = page * EXCEPTION_PAGE_SIZE;
    const pageEntries = entries.slice(start, start + EXCEPTION_PAGE_SIZE);

    list.textContent = '';
    if (pageEntries.length === 0) {
      list.append(el('p', 'empty', strings.noMatches));
    } else {
      for (const entry of pageEntries) {
        list.append(renderExceptionCard(entry));
      }
    }

    pager.update(entries.length, page);
  };

  input.addEventListener('input', () => {
    filter = input.value.trim().toLocaleLowerCase();
    page = 0;
    fill();
  });
  tools.append(input, pager.element);

  wrapper.append(tools, list);
  fill();
  return wrapper;
}

function renderExceptionCard(entry: DumpExceptionInfo): HTMLElement {
  const card = el('div', 'exception-card');
  const head = el('div', 'exception-head');
  head.append(el('div', 'exception-type', entry.typeName ?? strings.exceptionType));
  if (entry.address !== undefined) {
    head.append(el('code', 'exception-address', entry.address));
  }

  card.append(head);

  if (entry.message !== undefined && entry.message.length > 0) {
    const message = el('div', 'exception-message');
    message.append(el('span', 'exception-label', strings.exceptionMessage), el('p', undefined, entry.message));
    card.append(message);
  }

  if (entry.inner !== undefined && entry.inner.length > 0) {
    const inner = el('div', 'exception-field');
    inner.append(
      el('span', 'exception-label', strings.exceptionInner),
      el('code', 'exception-value', entry.inner),
    );
    card.append(inner);
  }

  if (entry.hresult !== undefined) {
    const hresult = el('div', 'exception-field');
    hresult.append(
      el('span', 'exception-label', strings.exceptionHresult),
      el('code', 'exception-value', entry.hresult),
    );
    card.append(hresult);
  }

  if (entry.frames.length > 0) {
    const stack = el('details', 'exception-stack');
    const summary = el('summary', undefined, `${strings.exceptionStack} · ${formatTemplate(strings.threadFrames, entry.frames.length)}`);
    stack.append(summary, renderFrames(entry.frames));
    card.append(stack);
  }

  return card;
}

/** Панель сравнения двух дампов. */
function renderComparison(current: DumpComparison): void {
  document.title = strings.comparisonTitle;
  const root = byId('root');
  root.textContent = '';
  root.append(renderComparisonHeader(current));

  const overview = renderComparisonOverview(current);
  if (overview !== undefined) {
    root.append(overview);
  }

  const findings = renderFindings(current.findings);
  if (findings !== undefined) {
    root.append(findings);
  }

  const changes = renderTypeChanges(current);
  if (changes !== undefined) {
    root.append(changes);
  }

  root.append(renderComparisonDetails(current));
}

function renderComparisonHeader(current: DumpComparison): HTMLElement {
  const header = el('header', 'toolbar');
  const text = el('div', 'toolbar-text');
  text.append(
    el('div', 'eyebrow', strings.comparisonTitle),
    el('h1', 'toolbar-title', `${baseName(current.before.dumpFile)} ↔ ${baseName(current.after.dumpFile)}`),
    el('div', 'path', current.before.dumpFile),
    el('div', 'path', current.after.dumpFile),
    el('div', 'meta-row', comparisonMeta(current)),
  );

  const openText = el('button', 'secondary', strings.openTextReport);
  openText.type = 'button';
  openText.addEventListener('click', () => vscode.postMessage({ type: 'openText' }));
  header.append(text, openText);
  return header;
}

/** Подписи «до / после» с временем и размером файлов. */
function comparisonMeta(current: DumpComparison): string {
  const parts = [
    comparisonLabel(strings.beforeLabel, current.before),
    comparisonLabel(strings.afterLabel, current.after),
    formatTemplate(strings.generated, current.after.generatedAt),
  ];
  return parts.join('  ·  ');
}

function comparisonLabel(label: string, report: DumpReport): string {
  const details: string[] = [];
  if (report.takenAt !== undefined) {
    details.push(report.takenAt);
  }

  if (report.dumpBytes !== undefined) {
    details.push(formatBytes(report.dumpBytes));
  }

  return details.length === 0 ? label : `${label}: ${details.join(' · ')}`;
}

interface DeltaItem {
  label: string;
  before?: number;
  after?: number;
  format: 'bytes' | 'count';
}

/** Обзор сравнения: изменения основных показателей с процентами. */
function renderComparisonOverview(current: DumpComparison): HTMLElement | undefined {
  const allItems: DeltaItem[] = [
    {
      label: strings.tileManagedHeap,
      before: current.before.heap?.totalSize,
      after: current.after.heap?.totalSize,
      format: 'bytes',
    },
    {
      label: strings.tileObjects,
      before: current.before.heap?.totalCount,
      after: current.after.heap?.totalCount,
      format: 'count',
    },
    { label: strings.tileTypes, before: current.before.typeCount, after: current.after.typeCount, format: 'count' },
    {
      label: strings.tileGcCommitted,
      before: current.before.gcHeap?.committed,
      after: current.after.gcHeap?.committed,
      format: 'bytes',
    },
    {
      label: strings.tileThreads,
      before: current.before.threads?.total,
      after: current.after.threads?.total,
      format: 'count',
    },
    {
      label: strings.tileAsync,
      before: current.before.async?.total,
      after: current.after.async?.total,
      format: 'count',
    },
    {
      label: strings.tileExceptions,
      before: current.before.exceptions?.totalCount,
      after: current.after.exceptions?.totalCount,
      format: 'count',
    },
    {
      label: strings.tileSyncBlocks,
      before: current.before.syncBlockCount,
      after: current.after.syncBlockCount,
      format: 'count',
    },
    {
      label: strings.tileFinalizable,
      before: current.before.finalizable?.total,
      after: current.after.finalizable?.total,
      format: 'count',
    },
  ];
  const items = allItems.filter(item => item.before !== undefined || item.after !== undefined);

  if (items.length === 0) {
    return undefined;
  }

  const { section, body } = panel(strings.sectionOverview);
  const grid = el('div', 'metrics');
  for (const item of items) {
    grid.append(renderDeltaMetric(item));
  }

  body.append(grid);
  return section;
}

function renderDeltaMetric(item: DeltaItem): HTMLElement {
  const before = item.before ?? 0;
  const after = item.after ?? 0;
  const delta = after - before;
  const percent = before === 0 ? undefined : (delta / before) * 100;
  const direction = delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : '';

  const box = el('div', 'metric');
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  box.append(
    el('div', 'metric-label', item.label),
    el('div', `metric-value ${direction}`, `${sign}${formatDeltaValue(item, Math.abs(delta))}`),
    el(
      'div',
      'metric-hint',
      `${formatDeltaValue(item, before)} → ${formatDeltaValue(item, after)}`
      + (percent === undefined ? '' : ` (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%)`),
    ),
  );
  return box;
}

function formatDeltaValue(item: DeltaItem, value: number): string {
  return item.format === 'bytes' ? formatBytes(value) : count(value);
}

/** Изменения по типам: самые крупные по абсолютному изменению размера. */
function renderTypeChanges(current: DumpComparison): HTMLElement | undefined {
  if (current.typeChanges.length === 0) {
    return undefined;
  }

  const { section, body } = panel(strings.typeChangesTitle, strings.typeChangesSubtitle);
  const table = el('table', 'grid comparison');
  const headRow = el('tr');
  headRow.append(
    el('th', undefined, strings.type),
    el('th', 'num', strings.beforeLabel),
    el('th', 'num', strings.afterLabel),
    el('th', 'num', strings.changeSize),
    el('th', 'num', strings.changeCount),
  );
  const thead = el('thead');
  thead.append(headRow);
  const tbody = el('tbody');
  const maxDelta = Math.max(...current.typeChanges.map(change => Math.abs(change.sizeDelta)), 1);
  for (const change of current.typeChanges) {
    tbody.append(renderTypeChange(change, maxDelta));
  }

  table.append(thead, tbody);
  body.append(table);
  return section;
}

function renderTypeChange(change: TypeChange, maxDelta: number): HTMLTableRowElement {
  const tr = el('tr');
  const typeCell = el('td', 'type-cell');
  typeCell.append(el('bdi', undefined, change.typeName));
  typeCell.title = change.typeName;

  tr.append(
    typeCell,
    el('td', 'num', formatBytes(change.beforeSize)),
    el('td', 'num', formatBytes(change.afterSize)),
    renderDeltaCell(change.sizeDelta, maxDelta),
    renderDeltaCountCell(change.countDelta),
  );
  return tr;
}

function renderDeltaCell(delta: number, maxDelta: number): HTMLTableCellElement {
  const cell = el('td', 'delta-cell');
  const meter = el('div', 'meter');
  const fill = el('div', `meter-fill ${delta > 0 ? 'delta-up' : 'delta-down'}`);
  fill.style.width = `${Math.max(2, (Math.abs(delta) / maxDelta) * 100)}%`;
  meter.append(fill);

  const direction = delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : '';
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  cell.append(meter, el('span', `delta-value ${direction}`, `${sign}${formatBytes(Math.abs(delta))}`));
  return cell;
}

function renderDeltaCountCell(delta: number): HTMLTableCellElement {
  const direction = delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : '';
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  return el('td', `num delta-value ${direction}`, `${sign}${count(Math.abs(delta))}`);
}

/** Подробности сравнения: полный вывод обеих сессий. */
function renderComparisonDetails(current: DumpComparison): HTMLElement {
  const { section, body } = panel(strings.detailsTitle);
  body.append(el('h3', 'subhead', strings.beforeLabel));
  for (const item of current.before.sections) {
    body.append(renderDetail(item));
  }

  body.append(el('h3', 'subhead', strings.afterLabel));
  for (const item of current.after.sections) {
    body.append(renderDetail(item));
  }

  return section;
}

/** Широкая полоса заполнения: доля занятого от общего. */
function renderMeter(fraction: number, titleText: string): HTMLElement {
  const meter = el('div', 'meter wide-meter');
  const fill = el('div', 'meter-fill');
  fill.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
  meter.title = titleText;
  meter.append(fill);
  return meter;
}

/** Имя файла без каталогов: путь может быть длинным. */
function baseName(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] ?? file;
}

/** Точное количество с разделителями разрядов: в дампе важна цифра, а не «1.28 млн». */
function count(value: number): string {
  return new Intl.NumberFormat(localeTag(), { maximumFractionDigits: 0 }).format(value);
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Element #${id} not found`);
  }

  return element;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) {
    element.className = className;
  }

  if (text !== undefined) {
    element.textContent = text;
  }

  return element;
}

function postProblem(message: string): void {
  vscode.postMessage({ type: 'problem', message });
}
