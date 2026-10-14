/**
 * Проверки отрисовки графиков на «записывающем» мок-канвасе.
 *
 * Живой canvas в тестах недоступен, но нам и не нужны пиксели: важно убедиться, что
 * функция рисования не бросает исключений (одна ошибка здесь однажды оставила графики пустыми)
 * и что интервалы найденных проблем действительно превращаются в полосы нужного цвета.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { drawChart, type ChartPalette, type ChartSpec, type ChartView } from './render.ts';
import type { ChartIssue, ChartPoint } from '../core/chartData.ts';

/** Один вызов метода мок-контекста: имя метода и аргументы. */
interface Call {
  method: string;
  args: unknown[];
}

/** Мок 2D-контекста: записывает всё, что у него просят нарисовать. */
interface RecordingContext {
  calls: Call[];
  fillStyles: (string | undefined)[];
  reset(): void;
}

interface RecordingCanvas {
  clientWidth: number;
  clientHeight: number;
  width: number;
  height: number;
  context: RecordingContext;
  getContext(kind: string): unknown;
}

const DRAW_METHODS = [
  'arc',
  'beginPath',
  'clearRect',
  'clip',
  'closePath',
  'fill',
  'fillRect',
  'fillText',
  'lineTo',
  'moveTo',
  'rect',
  'restore',
  'save',
  'setLineDash',
  'setTransform',
  'stroke',
  'strokeRect',
];

function createCanvas(width = 440, height = 200): RecordingCanvas {
  const calls: Call[] = [];
  const fillStyles: (string | undefined)[] = [];

  const context: RecordingContext & Record<string, unknown> = {
    calls,
    fillStyles,
    reset() {
      calls.length = 0;
      fillStyles.length = 0;
    },
  } as RecordingContext & Record<string, unknown>;

  for (const method of DRAW_METHODS) {
    context[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      if (method === 'fillRect' || method === 'strokeRect') {
        fillStyles.push(context.fillStyle as string | undefined);
      }
    };
  }

  // Градиент заливки: важен сам факт вызова addColorStop с разрешёнными цветами.
  context.createLinearGradient = () => ({
    addColorStop: (stop: number, color: string) => {
      assert.equal(typeof color, 'string');
      assert.ok(!color.includes('var('), `canvas получил CSS-переменную: ${color}`);
      assert.ok(Number.isFinite(stop));
    },
  });
  context.measureText = (text: string) => ({ width: text.length * 6 });

  return {
    clientWidth: width,
    clientHeight: height,
    width,
    height,
    context,
    getContext: (kind: string) => (kind === '2d' ? context : null),
  };
}

function createPalette(): ChartPalette {
  return {
    text: '#cccccc',
    grid: '#3c3c3c',
    crosshair: '#999999',
    selectionFill: 'rgba(0, 127, 212, 0.25)',
    selectionBorder: '#007fd4',
    font: '12px sans-serif',
    gen0: '#4ec9b0',
    gen1: '#dcdcaa',
    gen2: '#f14c4c',
    issueInfo: '#4b9cff',
    issueWarning: '#cca700',
    issueCritical: '#f14c4c',
    // Палитра панели отдаёт уже разрешённые цвета, поэтому подстановка здесь не нужна.
    resolveColor: value => value,
  };
}

function cpuSpec(): ChartSpec {
  return {
    id: 'cpu',
    title: 'CPU',
    series: [{ key: 'cpu', label: 'CPU', color: '#4b9cff', style: 'area' }],
    format: value => `${Math.round(value)}%`,
    fixedMax: 100,
    showGcMarkers: false,
  };
}

/** Ряд точек: значение растёт, чтобы график заведомо что-то нарисовал. */
function points(count = 20, stepMs = 1000, base = Date.now() - 19_000): ChartPoint[] {
  const result: ChartPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    result.push({
      t: base + index * stepMs,
      cpu: 20 + index * 3,
      priv: 40_000_000,
      ws: 30_000_000,
      heap: 2_000_000,
      alloc: 1024,
      tig: 0,
      thr: 8,
    });
  }
  return result;
}

function issue(overrides: Partial<ChartIssue> = {}): ChartIssue {
  return {
    id: 'issue-1',
    kind: 'cpu-saturation',
    chart: 'cpu',
    severity: 'warning',
    fromMs: Date.now() - 10_000,
    toMs: Date.now() - 5_000,
    title: 'CPU is pegged at full load',
    details: 'Load stayed above 90 % for 12 s (peak 99 %).',
    ...overrides,
  };
}

function viewFor(pointsList: ChartPoint[], issues: ChartIssue[]): ChartView {
  return {
    fromMs: pointsList[0].t,
    toMs: pointsList[pointsList.length - 1].t,
    hoverT: null,
    selection: null,
    placeholder: 'Waiting for data…',
    issues,
  };
}

/** Все прямоугольники, залитые в режиме полосы проблемы (полупрозрачная заливка). */
function bandBands(canvas: RecordingCanvas): Call[] {
  return canvas.context.calls.filter(call => call.method === 'fillRect');
}

// Нужен глобальный `window` — рисование берёт из него плотность пикселей.
(globalThis as { window?: unknown }).window = { devicePixelRatio: 1 };

// `Path2D` есть только в браузере: для тестов достаточно заглушки, которая принимает команды пути.
class Path2DStub {
  commands: string[] = [];

  moveTo(x: number, y: number): void {
    this.commands.push(`moveTo ${x} ${y}`);
  }

  lineTo(x: number, y: number): void {
    this.commands.push(`lineTo ${x} ${y}`);
  }

  closePath(): void {
    this.commands.push('closePath');
  }
}

(globalThis as { Path2D?: unknown }).Path2D = Path2DStub;

test('отрисовка графика с данными не бросает исключений и что-то рисует', () => {
  const canvas = createCanvas();
  const list = points();

  drawChart(
    canvas as unknown as HTMLCanvasElement,
    cpuSpec(),
    list,
    [],
    viewFor(list, []),
    createPalette(),
  );

  assert.ok(canvas.context.calls.length > 0, 'на канвасе ничего не нарисовано');
  assert.equal(canvas.width, canvas.clientWidth, 'канвас не масштабирован под плотность пикселей');
});

test('вырожденный диапазон времени показывает заглушку вместо линий', () => {
  const canvas = createCanvas();
  const now = Date.now();

  drawChart(
    canvas as unknown as HTMLCanvasElement,
    cpuSpec(),
    [],
    [],
    {
      fromMs: now,
      toMs: now,
      hoverT: null,
      selection: null,
      placeholder: 'Waiting for data…',
      issues: [],
    },
    createPalette(),
  );

  const texts = canvas.context.calls.filter(call => call.method === 'fillText');
  assert.ok(
    texts.some(call => call.args[0] === 'Waiting for data…'),
    'заглушка не показана',
  );
  assert.ok(
    !canvas.context.calls.some(call => call.method === 'arc'),
    'на пустом графике нарисованы точки',
  );
});

test('нулевой размер канваса не приводит к рисованию', () => {
  const canvas = createCanvas(0, 0);

  drawChart(canvas as unknown as HTMLCanvasElement, cpuSpec(), points(), [], viewFor(points(), []), createPalette());

  assert.equal(canvas.context.calls.length, 0, 'на невидимом канвасе что-то нарисовано');
});

test('интервал проблемы рисуется полосой цвета важности', () => {
  const canvas = createCanvas();
  const list = points();
  const palette = createPalette();
  const warning = issue({ severity: 'warning' });

  drawChart(
    canvas as unknown as HTMLCanvasElement,
    cpuSpec(),
    list,
    [],
    viewFor(list, [warning]),
    palette,
  );

  const bands = bandBands(canvas);
  assert.equal(bands.length, 1, `ожидалась одна полоса, нарисовано: ${bands.length}`);
  assert.ok(
    canvas.context.fillStyles.includes(palette.issueWarning),
    `нет заливки цветом предупреждения, были: ${canvas.context.fillStyles.join(', ')}`,
  );
  assert.ok(
    canvas.context.calls.some(call => call.method === 'strokeRect'),
    'края интервала не обведены',
  );

  // Полоса не должна выходить за область графика.
  for (const band of bands) {
    const [x, , width] = band.args as [number, number, number, number];
    assert.ok(x >= 60 && x + width <= canvas.clientWidth, `полоса вышла за пределы: x=${x}, w=${width}`);
  }
});

test('важность проблемы определяет цвет полосы', () => {
  const palette = createPalette();

  for (const [severity, expected] of [
    ['critical', palette.issueCritical],
    ['warning', palette.issueWarning],
    ['info', palette.issueInfo],
  ] as const) {
    const canvas = createCanvas();
    const list = points();

    drawChart(
      canvas as unknown as HTMLCanvasElement,
      cpuSpec(),
      list,
      [],
      viewFor(list, [issue({ severity })]),
      palette,
    );

    assert.ok(
      canvas.context.fillStyles.includes(expected),
      `для важности ${severity} ожидался цвет ${expected}`,
    );
  }
});

test('проблемы других графиков не рисуются на этом графике', () => {
  const canvas = createCanvas();
  const list = points();

  drawChart(
    canvas as unknown as HTMLCanvasElement,
    cpuSpec(),
    list,
    [],
    viewFor(list, [issue({ chart: 'memory', severity: 'critical' })]),
    createPalette(),
  );

  // Остаётся только заливка ряда (area), полос проблем быть не должно: под прозрачностью их нет.
  assert.ok(
    !canvas.context.fillStyles.includes(createPalette().issueCritical),
    'полоса с чужого графика попала на график CPU',
  );
});

test('выделение диапазона и наведение рисуются поверх данных', () => {
  const canvas = createCanvas();
  const list = points();
  const view = viewFor(list, []);
  view.selection = { from: list[5].t, to: list[10].t };
  view.hoverT = list[8].t;

  drawChart(canvas as unknown as HTMLCanvasElement, cpuSpec(), list, [], view, createPalette());

  assert.ok(
    canvas.context.calls.some(call => call.method === 'strokeRect'),
    'рамка выделения не нарисована',
  );
  assert.ok(
    canvas.context.calls.some(call => call.method === 'arc'),
    'точка под курсором не нарисована',
  );
});
