/**
 * Графическая панель снимка CPU (выполняется внутри webview).
 *
 * Показывает то же, что Visual Studio в отчёте CPU Usage: топ методов по
 * собственному и полному времени, дерево вызовов, флеймграф и сравнение
 * двух снимков. Тексты присылает расширение: внутри webview нет API локализации.
 */

import {
  DEFAULT_CPU_WEBVIEW_STRINGS,
  type CpuWebviewStrings,
} from '../core/cpuWebviewStrings.ts';
import {
  weightToMilliseconds,
  type CpuChangeRow,
  type CpuChangeStatus,
  type CpuMethod,
  type CpuProfile,
  type CpuProfileComparison,
  type CpuProfileUnit,
  type CpuTreeNode,
} from '../core/cpuProfile.ts';
import { formatDuration, formatNumber, formatPercent } from '../core/formatting.ts';
import { configureLocale, formatTemplate, localeTag } from '../core/locale.ts';
import { baseName } from '../core/paths.ts';
import './cpu.css';

type OutgoingMessage =
  | { type: 'ready' }
  | { type: 'openProfile' }
  | { type: 'revealProfile' }
  | { type: 'problem'; message: string };

interface IncomingMessage {
  type: 'profile' | 'comparison';
  profile?: CpuProfile;
  comparison?: CpuProfileComparison;
  strings?: CpuWebviewStrings;
  locale?: string;
}

interface VsCodeApi {
  postMessage(message: OutgoingMessage): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** Сколько строк таблиц строить: дальше помогает фильтр. */
const METHOD_ROW_LIMIT = 500;
const CHANGE_ROW_LIMIT = 500;

/** Сколько дочерних строк дерева добавлять за один клик «Показать ещё». */
const TREE_CHILDREN_STEP = 200;

/** Предел узлов дерева в DOM: огромный профиль не должен подвешивать панель. */
const TREE_NODE_LIMIT = 3_000;

/** Предел глубины флеймграфа и минимальная видимая ширина полосы в процентах. */
const FLAME_MAX_DEPTH = 96;
const FLAME_MIN_WIDTH = 0.15;

type SortMetric = 'exclusive' | 'inclusive';

const state = {
  profile: undefined as CpuProfile | undefined,
  comparison: undefined as CpuProfileComparison | undefined,
  methodSort: 'exclusive' as SortMetric,
  methodFilter: '',
  changeFilter: '',
  /** Путь флеймграфа от общего корня: последний элемент — текущий фокус. */
  flamePath: [] as CpuTreeNode[],
};

let strings: CpuWebviewStrings = DEFAULT_CPU_WEBVIEW_STRINGS;

window.addEventListener('message', event => {
  const message = event.data as IncomingMessage;
  strings = message.strings ?? strings;
  if (message.locale !== undefined) {
    configureLocale(message.locale);
  }

  try {
    if (message.type === 'profile' && message.profile !== undefined) {
      state.profile = message.profile;
      state.comparison = undefined;
      state.flamePath = [];
      state.methodFilter = '';
      renderProfile();
    } else if (message.type === 'comparison' && message.comparison !== undefined) {
      state.comparison = message.comparison;
      state.profile = undefined;
      state.changeFilter = '';
      renderComparison();
    }
  } catch (error) {
    postProblem(error instanceof Error ? error.message : String(error));
  }
});

vscode.postMessage({ type: 'ready' });

function renderProfile(): void {
  const profile = state.profile;
  const root = byId('root');
  root.replaceChildren();
  if (profile === undefined) {
    return;
  }

  root.append(profileToolbar(profile));
  if (profile.total <= 0 || profile.methods.length === 0) {
    root.append(panel(strings.emptyProfile));
    return;
  }

  root.append(profileTiles(profile));
  root.append(methodsPanel(profile));
  root.append(treePanel(profile));
  root.append(flamePanel(profile));
}

function renderComparison(): void {
  const comparison = state.comparison;
  const root = byId('root');
  root.replaceChildren();
  if (comparison === undefined) {
    return;
  }

  root.append(comparisonToolbar(comparison));
  root.append(comparisonTiles(comparison));
  root.append(comparisonPanel(comparison));
}

function profileToolbar(profile: CpuProfile): HTMLElement {
  const toolbar = el('header', 'toolbar');
  const text = el('div', 'toolbar-text');
  text.append(
    el('div', 'eyebrow', strings.eyebrow),
    el('h1', 'toolbar-title', baseName(profile.file)),
  );

  const path = el('div', 'path', profile.file);
  text.append(path);

  const meta = el('div', 'meta');
  if (profile.name.length > 0) {
    meta.append(el('div', undefined, profile.name));
  }

  if (profile.takenAt !== undefined) {
    meta.append(el('div', 'meta', formatTemplate(
      strings.taken,
      new Date(profile.takenAt).toLocaleString(localeTag(), { dateStyle: 'short', timeStyle: 'medium' }),
    )));
  }

  text.append(meta);
  toolbar.append(text);

  const actions = el('div', 'actions');
  const open = el('button', undefined, strings.openSpeedscope);
  open.addEventListener('click', () => vscode.postMessage({ type: 'openProfile' }));
  const reveal = el('button', 'secondary', strings.revealFile);
  reveal.addEventListener('click', () => vscode.postMessage({ type: 'revealProfile' }));
  actions.append(open, reveal);
  toolbar.append(actions);
  return toolbar;
}

function comparisonToolbar(comparison: CpuProfileComparison): HTMLElement {
  const toolbar = el('header', 'toolbar');
  const text = el('div', 'toolbar-text');
  text.append(
    el('div', 'eyebrow', strings.eyebrow),
    el('h1', 'toolbar-title', `${baseName(comparison.before.file)} ↔ ${baseName(comparison.after.file)}`),
  );

  text.append(el('div', 'path', `${strings.before}: ${comparison.before.file}`));
  text.append(el('div', 'path', `${strings.after}: ${comparison.after.file}`));
  toolbar.append(text);
  return toolbar;
}

function profileTiles(profile: CpuProfile): HTMLElement {
  const container = el('div', 'tiles');
  const top = profile.methods[0];
  container.append(
    tile(strings.tileDuration, durationLabel(profile), formatTemplate(
      strings.metaSummary,
      formatNumber(profile.samples, 0),
      formatNumber(profile.methods.length, 0),
    )),
    tile(strings.tileSamples, formatNumber(profile.samples, 0)),
    tile(strings.tileMethods, formatNumber(profile.methods.length, 0)),
    tile(strings.tileTopMethod, top !== undefined ? shortMethodName(top.name) : '—', top !== undefined ? formatPercent(top.exclusivePercent) : undefined, true),
  );

  if (profile.blocked > 0) {
    container.append(tile(
      strings.tileBlocked,
      weightLabel(profile.blocked, profile.unit),
      strings.blockedHint,
    ));
  }

  return container;
}

function comparisonTiles(comparison: CpuProfileComparison): HTMLElement {
  const container = el('div', 'tiles');
  container.append(
    tile(
      `${strings.tileDuration} · ${strings.before}`,
      durationLabel(comparison.before),
      formatTemplate(strings.samplesCount, formatNumber(comparison.before.samples, 0)),
    ),
    tile(
      `${strings.tileDuration} · ${strings.after}`,
      durationLabel(comparison.after),
      formatTemplate(strings.samplesCount, formatNumber(comparison.after.samples, 0)),
    ),
    tile(strings.tileTotalDelta, formatSignedPercent(comparison.totalDeltaPercent)),
    tile(strings.tileSamples, `${formatNumber(comparison.before.samples, 0)} → ${formatNumber(comparison.after.samples, 0)}`),
  );
  return container;
}

function methodsPanel(profile: CpuProfile): HTMLElement {
  const section = el('section', 'panel');
  const head = el('div', 'panel-head');
  const subtitle = el('p', 'panel-subtitle');
  head.append(el('h2', 'panel-title', strings.sectionMethods), subtitle);
  section.append(head);

  const tools = el('div', 'panel-tools');
  const filter = el('input');
  filter.type = 'search';
  filter.placeholder = strings.filterMethods;
  filter.value = state.methodFilter;

  const segmented = el('div', 'segmented');
  const exclusiveButton = el('button', undefined, strings.sortExclusive);
  const inclusiveButton = el('button', undefined, strings.sortInclusive);
  segmented.append(exclusiveButton, inclusiveButton);

  const rows = el('tbody');
  const note = el('div', 'note');

  const syncSort = (): void => {
    exclusiveButton.classList.toggle('active', state.methodSort === 'exclusive');
    inclusiveButton.classList.toggle('active', state.methodSort === 'inclusive');
    subtitle.textContent = formatTemplate(
      strings.sectionMethodsSubtitle,
      state.methodSort === 'exclusive' ? strings.sortExclusive : strings.sortInclusive,
    );
  };

  filter.addEventListener('input', () => {
    state.methodFilter = filter.value;
    updateMethodRows(profile, rows, note);
  });
  exclusiveButton.addEventListener('click', () => {
    state.methodSort = 'exclusive';
    syncSort();
    updateMethodRows(profile, rows, note);
  });
  inclusiveButton.addEventListener('click', () => {
    state.methodSort = 'inclusive';
    syncSort();
    updateMethodRows(profile, rows, note);
  });
  syncSort();
  tools.append(filter, segmented);
  section.append(tools);

  const body = el('div', 'panel-body flush');
  const table = el('table', 'table');
  const tableHead = el('thead');
  const headRow = el('tr');
  headRow.append(
    el('th', undefined, strings.columnMethod),
    el('th', undefined, strings.columnExclusive),
    el('th', undefined, strings.columnInclusive),
    el('th', 'numeric', strings.columnSamples),
  );
  tableHead.append(headRow);
  table.append(tableHead, rows);
  body.append(table);

  section.append(body, note);
  updateMethodRows(profile, rows, note);
  return section;
}

function updateMethodRows(profile: CpuProfile, rows: HTMLElement, note: HTMLElement): void {
  const query = state.methodFilter.trim().toLowerCase();
  const filtered = query.length === 0
    ? profile.methods
    : profile.methods.filter(method =>
      `${method.name} ${method.file ?? ''}`.toLowerCase().includes(query));
  const sorted = [...filtered].sort((left, right) => state.methodSort === 'exclusive'
    ? right.exclusive - left.exclusive || right.inclusive - left.inclusive
    : right.inclusive - left.inclusive || right.exclusive - left.exclusive);

  rows.replaceChildren();
  if (sorted.length === 0) {
    rows.append(messageRow(strings.noMatches, 4));
  } else {
    for (const method of sorted.slice(0, METHOD_ROW_LIMIT)) {
      rows.append(methodRow(method));
    }
  }

  const hidden = sorted.length <= METHOD_ROW_LIMIT;
  note.hidden = hidden;
  note.textContent = hidden
    ? ''
    : formatTemplate(strings.showingMethods, METHOD_ROW_LIMIT, sorted.length);
}

function methodRow(method: CpuMethod): HTMLElement {
  const row = el('tr');
  row.append(
    methodCell(method.name, method.file, method.line),
    barCell(method.exclusivePercent),
    barCell(method.inclusivePercent),
    el('td', 'numeric', formatNumber(method.exclusiveSamples, 0)),
  );
  return row;
}

function treePanel(profile: CpuProfile): HTMLElement {
  const section = el('section', 'panel');
  section.append(panelHead(strings.sectionTree, strings.sectionTreeSubtitle));

  const body = el('div', 'tree');
  const counter = { value: 0 };
  for (const node of profile.roots) {
    if (counter.value >= TREE_NODE_LIMIT) {
      break;
    }

    body.append(treeRow(node, 0, counter));
  }

  if (profile.truncated || counter.value >= TREE_NODE_LIMIT) {
    body.append(el('div', 'note', strings.truncated));
  }

  section.append(body);
  return section;
}

function treeRow(node: CpuTreeNode, depth: number, counter: { value: number }): HTMLElement {
  const wrapper = el('div');
  counter.value++;

  const row = el('div', 'tree-row');
  row.style.paddingLeft = `${8 + depth * 14}px`;

  const toggle = el('span', 'tree-toggle');
  const children = el('div', 'tree-children');
  children.hidden = true;
  let expanded = false;
  let built = 0;
  let more: HTMLElement | undefined;

  const buildMore = (): void => {
    more?.remove();
    more = undefined;

    const end = Math.min(node.children.length, built + TREE_CHILDREN_STEP);
    for (; built < end; built++) {
      if (counter.value >= TREE_NODE_LIMIT) {
        break;
      }

      children.append(treeRow(node.children[built], depth + 1, counter));
    }

    if (built < node.children.length && counter.value < TREE_NODE_LIMIT) {
      more = el('div', 'tree-more');
      const button = el('button', 'secondary small', strings.showMore);
      button.addEventListener('click', buildMore);
      more.append(button);
      children.append(more);
    }
  };

  if (node.children.length > 0) {
    toggle.textContent = '▸';
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      if (expanded) {
        buildMore();
      }

      toggle.textContent = expanded ? '▾' : '▸';
      children.hidden = !expanded;
    });
  } else {
    toggle.classList.add('empty');
  }

  const name = el('span', 'tree-name', node.name);
  name.title = locationLabel(node.file, node.line) ?? node.name;

  const bar = el('div', 'tree-bar');
  const fill = el('div', 'tree-bar-fill');
  fill.style.width = `${clampPercent(node.inclusivePercent)}%`;
  bar.append(fill);

  const metrics = el('span', 'tree-metrics');
  metrics.append(
    el('span', undefined, `${strings.selfLabel} ${formatPercent(node.exclusivePercent)}`),
    el('span', undefined, `${strings.inclusiveLabel} ${formatPercent(node.inclusivePercent)}`),
  );

  row.append(toggle, name);
  if (node.file !== undefined) {
    row.append(el('span', 'tree-file', locationLabel(node.file, node.line) ?? node.file));
  }

  row.append(bar, metrics);
  wrapper.append(row, children);
  return wrapper;
}

function flamePanel(profile: CpuProfile): HTMLElement {
  const section = el('section', 'panel');
  section.append(panelHead(strings.sectionFlame, strings.sectionFlameSubtitle));
  const body = el('div', 'panel-body');
  section.append(body);
  renderFlame(profile, body);
  return section;
}

function renderFlame(profile: CpuProfile, body: HTMLElement): void {
  body.replaceChildren();
  const root = virtualRoot(profile);
  const focus = state.flamePath.length > 0 ? state.flamePath[state.flamePath.length - 1] : root;

  const breadcrumbs = el('div', 'breadcrumbs');
  const back = el('button', state.flamePath.length === 0 ? 'crumb current' : 'crumb', strings.flameAll);
  if (state.flamePath.length > 0) {
    back.addEventListener('click', () => {
      state.flamePath = [];
      renderFlame(profile, body);
    });
  }

  breadcrumbs.append(back);
  state.flamePath.forEach((node, index) => {
    breadcrumbs.append(el('span', 'crumb-separator', '›'));
    const current = index === state.flamePath.length - 1;
    const crumb = el('button', current ? 'crumb current' : 'crumb', node.name);
    if (!current) {
      crumb.addEventListener('click', () => {
        state.flamePath = state.flamePath.slice(0, index + 1);
        renderFlame(profile, body);
      });
    }

    breadcrumbs.append(crumb);
  });
  body.append(breadcrumbs);

  const { bars, maxDepth } = layoutFlame(focus, focus.inclusive);
  const chart = el('div', 'flame');
  const inner = el('div', 'flame-inner');
  inner.style.height = `${(maxDepth + 1) * 18 + 8}px`;

  for (const bar of bars) {
    const item = el('div', 'flame-bar');
    item.style.left = `${bar.leftPercent}%`;
    item.style.width = `${bar.widthPercent}%`;
    item.style.top = `${bar.depth * 18}px`;
    item.style.background = `var(--cpu-flame-${bar.depth % 6})`;
    if (bar.widthPercent >= 4) {
      item.textContent = bar.node.name;
    }

    item.title = `${bar.node.name} — ${strings.inclusiveLabel} ${formatPercent(bar.node.inclusivePercent)}, ${strings.selfLabel} ${formatPercent(bar.node.exclusivePercent)}`;
    item.tabIndex = 0;
    const focusBar = (): void => {
      if (bar.node === root) {
        state.flamePath = [];
        renderFlame(profile, body);
        return;
      }

      if (bar.node === focus) {
        return;
      }

      const path = findNodePath(root, bar.node);
      if (path !== undefined) {
        // Виртуальный корень в крошки не попадает: для него есть кнопка «Все сэмплы».
        state.flamePath = path.slice(1);
        renderFlame(profile, body);
      }
    };

    item.addEventListener('click', focusBar);
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        focusBar();
      }
    });
    inner.append(item);
  }

  chart.append(inner);
  body.append(chart, el('div', 'flame-hint', strings.flameZoomHint));
  if (maxDepth + 1 >= FLAME_MAX_DEPTH) {
    body.append(el('div', 'note', formatTemplate(strings.flameDepthLimit, FLAME_MAX_DEPTH)));
  }
}

interface FlameBar {
  node: CpuTreeNode;
  depth: number;
  leftPercent: number;
  widthPercent: number;
}

function layoutFlame(root: CpuTreeNode, total: number): { bars: FlameBar[]; maxDepth: number } {
  const bars: FlameBar[] = [];
  let maxDepth = 0;

  const visit = (node: CpuTreeNode, depth: number, left: number): void => {
    if (depth >= FLAME_MAX_DEPTH) {
      return;
    }

    const width = total > 0 ? (node.inclusive / total) * 100 : 0;
    if (width < FLAME_MIN_WIDTH) {
      return;
    }

    maxDepth = Math.max(maxDepth, depth);
    bars.push({ node, depth, leftPercent: left, widthPercent: width });
    let childLeft = left;
    for (const child of node.children) {
      visit(child, depth + 1, childLeft);
      childLeft += total > 0 ? (child.inclusive / total) * 100 : 0;
    }
  };

  visit(root, 0, 0);
  return { bars, maxDepth };
}

function virtualRoot(profile: CpuProfile): CpuTreeNode {
  const rootsInclusive = profile.roots.reduce((sum, node) => sum + node.inclusive, 0);
  const exclusive = Math.max(0, profile.total - rootsInclusive);
  return {
    key: '\u0000all',
    name: strings.flameAll,
    exclusive,
    inclusive: profile.total,
    samples: profile.samples,
    exclusivePercent: profile.total > 0 ? (exclusive / profile.total) * 100 : 0,
    inclusivePercent: profile.total > 0 ? 100 : 0,
    children: profile.roots,
  };
}

/** Путь до узла по ссылке: одинаковые имена методов в разных ветках не путаются. */
function findNodePath(root: CpuTreeNode, target: CpuTreeNode): CpuTreeNode[] | undefined {
  if (root === target) {
    return [root];
  }

  for (const child of root.children) {
    const path = findNodePath(child, target);
    if (path !== undefined) {
      return [root, ...path];
    }
  }

  return undefined;
}

function comparisonPanel(comparison: CpuProfileComparison): HTMLElement {
  const section = el('section', 'panel');
  section.append(panelHead(strings.comparisonTitle, strings.comparisonSubtitle));

  const tools = el('div', 'panel-tools');
  const filter = el('input');
  filter.type = 'search';
  filter.placeholder = strings.filterMethods;
  filter.value = state.changeFilter;
  const rows = el('tbody');
  const note = el('div', 'note');
  filter.addEventListener('input', () => {
    state.changeFilter = filter.value;
    updateChangeRows(comparison, rows, note);
  });
  tools.append(filter);
  section.append(tools);

  const body = el('div', 'panel-body flush');
  const table = el('table', 'table');
  const head = el('thead');
  const headRow = el('tr');
  headRow.append(
    el('th', undefined, strings.columnMethod),
    el('th', undefined, strings.columnStatus),
    el('th', 'numeric', strings.columnBefore),
    el('th', 'numeric', strings.columnAfter),
    el('th', 'numeric', strings.columnDelta),
    el('th', 'numeric', strings.columnDeltaInclusive),
  );
  head.append(headRow);
  table.append(head, rows);
  body.append(table);

  const hint = el('div', 'note', strings.comparisonHint);
  section.append(body, hint, note);
  updateChangeRows(comparison, rows, note);
  return section;
}

function updateChangeRows(
  comparison: CpuProfileComparison,
  rows: HTMLElement,
  note: HTMLElement,
): void {
  const query = state.changeFilter.trim().toLowerCase();
  const filtered = query.length === 0
    ? comparison.rows
    : comparison.rows.filter(row =>
      `${row.name} ${row.file ?? ''}`.toLowerCase().includes(query));
  const maxDelta = filtered.reduce((max, row) => Math.max(max, Math.abs(row.deltaExclusivePercent)), 1);

  rows.replaceChildren();
  if (filtered.length === 0) {
    rows.append(messageRow(comparison.rows.length === 0 ? strings.noChanges : strings.noMatches, 6));
  } else {
    for (const row of filtered.slice(0, CHANGE_ROW_LIMIT)) {
      rows.append(changeRow(row, maxDelta));
    }
  }

  const hidden = filtered.length <= CHANGE_ROW_LIMIT;
  note.hidden = hidden;
  note.textContent = hidden
    ? ''
    : formatTemplate(strings.showingChanges, CHANGE_ROW_LIMIT, filtered.length);
}

function changeRow(row: CpuChangeRow, maxDelta: number): HTMLElement {
  const tableRow = el('tr');
  const status = el('td');
  status.append(el('span', `badge ${row.status}`, statusLabel(row.status)));

  const delta = row.deltaExclusivePercent;
  const deltaCell = el('td', 'numeric');
  const cell = el('div', 'delta-bar-cell');
  const bar = el('div', 'delta-bar');
  const fill = el('div', delta >= 0 ? 'delta-bar-fill up' : 'delta-bar-fill down');
  fill.style.width = `${Math.min(50, (Math.abs(delta) / Math.max(maxDelta, 0.0001)) * 50)}%`;
  bar.append(fill);
  cell.append(bar, el('span', `delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}`.trim(), formatSignedPercent(delta)));
  deltaCell.append(cell);

  const inclusiveCell = el(
    'td',
    `numeric delta ${row.deltaInclusivePercent > 0 ? 'up' : row.deltaInclusivePercent < 0 ? 'down' : ''}`.trim(),
    formatSignedPercent(row.deltaInclusivePercent),
  );

  tableRow.append(
    methodCell(row.name, row.file, row.line),
    status,
    el('td', 'numeric', formatPercent(row.beforeExclusivePercent)),
    el('td', 'numeric', formatPercent(row.afterExclusivePercent)),
    deltaCell,
    inclusiveCell,
  );
  return tableRow;
}

function statusLabel(status: CpuChangeStatus): string {
  switch (status) {
    case 'added':
      return strings.statusAdded;
    case 'removed':
      return strings.statusRemoved;
    default:
      return strings.statusChanged;
  }
}

function methodCell(name: string, file: string | undefined, line: number | undefined): HTMLElement {
  const cell = el('td', 'method');
  cell.append(el('div', 'method-name', name));
  if (file !== undefined) {
    cell.append(el('div', 'method-file', locationLabel(file, line) ?? file));
  }

  return cell;
}

function barCell(percent: number): HTMLElement {
  const cell = el('td');
  const wrap = el('div', 'bar-cell');
  const track = el('div', 'bar-track');
  const fill = el('div', 'bar-fill');
  fill.style.width = `${clampPercent(percent)}%`;
  track.append(fill);
  wrap.append(track, el('span', 'bar-value', formatPercent(percent)));
  cell.append(wrap);
  return cell;
}

function panel(headText: string): HTMLElement {
  const section = el('section', 'panel');
  section.append(el('div', 'empty', headText));
  return section;
}

function panelHead(title: string, subtitle: string): HTMLElement {
  const head = el('div', 'panel-head');
  head.append(el('h2', 'panel-title', title), el('p', 'panel-subtitle', subtitle));
  return head;
}

function tile(label: string, value: string, sub?: string, smallText = false): HTMLElement {
  const box = el('div', 'tile');
  box.append(el('div', 'tile-label', label));
  box.append(el('div', smallText ? 'tile-value small-text' : 'tile-value', value));
  if (sub !== undefined && sub.length > 0) {
    box.append(el('div', 'tile-sub', sub));
  }

  return box;
}

function messageRow(text: string, columns: number): HTMLElement {
  const row = el('tr');
  const cell = el('td', 'empty', text);
  cell.colSpan = columns;
  row.append(cell);
  return row;
}

function locationLabel(file: string | undefined, line: number | undefined): string | undefined {
  if (file === undefined) {
    return undefined;
  }

  return line !== undefined ? `${file}:${line}` : file;
}

/** Короткое имя для плитки: без сборки и списка параметров. */
function shortMethodName(name: string): string {
  const bang = name.lastIndexOf('!');
  const withoutAssembly = bang >= 0 ? name.slice(bang + 1) : name;
  const paren = withoutAssembly.indexOf('(');
  return paren > 0 ? withoutAssembly.slice(0, paren) : withoutAssembly;
}

/** Длительность в удобных единицах; при неизвестной единице показываем вес как есть. */
function durationLabel(profile: CpuProfile): string {
  return weightLabel(profile.total, profile.unit);
}

function weightLabel(value: number, unit: CpuProfileUnit): string {
  if (unit === 'none' || unit === 'bytes') {
    return formatNumber(value, 0);
  }

  return formatDuration(weightToMilliseconds(value, unit));
}

function formatSignedPercent(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) {
    return '—';
  }

  return `${value > 0 ? '+' : ''}${value.toFixed(fractionDigits)} %`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
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
