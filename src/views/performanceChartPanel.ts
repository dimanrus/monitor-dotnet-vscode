/**
 * Панель Performance: графики CPU, сборки мусора и памяти.
 *
 * Панель — это webview-вид VS Code. Данные и тексты расширение отправляет сообщениями:
 * полный снимок при первом показе и при смене процесса, далее — только новые точки.
 * Тексты передаются потому, что внутри webview нет API локализации VS Code.
 */

import * as vscode from 'vscode';
import {
  buildChartMeta,
  CHART_HISTORY_LIMIT,
  toChartGcEvent,
  toChartPoint,
  type ChartGcEvent,
  type ChartIssue,
  type ChartMeta,
  type ChartPoint,
} from '../core/chartData.ts';
import { collectIssues } from '../core/issueSource.ts';
import type { MonitorState } from '../core/monitorState.ts';
import { buildWebviewStrings, type WebviewStrings } from '../core/webviewStrings.ts';
import { translate } from '../core/locale.ts';
import type { Logger } from '../logger.ts';

/** Сообщение из webview. */
interface WebviewMessage {
  type?: string;
  message?: string;
  points?: number;
  canvases?: string;
  painted?: boolean;
  issues?: number;
}

export class PerformanceChartPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  /** Идентификатор вида из package.json. */
  public static readonly viewType = 'monitor-dotnet.performance';

  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;

  /** Сколько точек уже отправлено в webview и время последней из них. */
  private sentCount = 0;
  private sentLastTime = 0;
  /** Номер поколения данных: меняется при очистке и смене процесса. */
  private sentGeneration = -1;
  /** Тексты для панели: собираются один раз, чтобы не переводить строки на каждом снимке. */
  private strings: WebviewStrings = buildWebviewStrings(translate);

  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly state: MonitorState,
    private readonly getWindowSeconds: () => number,
    private readonly getRefreshIntervalSeconds: () => number,
    private readonly getEnableIssues: () => boolean,
    private readonly logger: Logger,
  ) {
    this.disposables.push({ dispose: this.state.onDidChange(() => this.scheduleFlush()) });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.strings = buildWebviewStrings(translate);
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = this.buildHtml(view.webview);
    view.webview.onDidReceiveMessage(message => this.handleMessage(message as WebviewMessage));

    this.disposables.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          // Возвращаем панель в актуальное состояние после сворачивания.
          this.sendSnapshot();
        }
      }),
      view.onDidDispose(() => this.view = undefined),
    );
  }

  /**
   * Просит панель выделить интервал — так дерево проблем показывает найденное место на графиках.
   * Панель при этом раскрывается: иначе выделение осталось бы невидимым.
   */
  async selectInterval(fromMs: number, toMs: number): Promise<void> {
    await vscode.commands.executeCommand(`${PerformanceChartPanel.viewType}.focus`);
    const view = this.view;
    if (view === undefined) {
      return;
    }

    await view.webview.postMessage({ type: 'selectRange', fromMs, toMs });
  }

  /** Передаёт в панель новые данные, если вид сейчас показан. */
  sync(): void {
    const view = this.view;
    if (view === undefined || !view.visible) {
      return;
    }

    const points = this.buildPoints();
    const gcEvents = this.buildGcEvents();

    if (this.sentGeneration !== this.state.generation || points.length < this.sentCount) {
      this.sendSnapshot();
      return;
    }

    const fresh = points.filter(point => point.t > this.sentLastTime);
    if (fresh.length === 0) {
      // Данных пока нет, но шапка может требовать обновления.
      void view.webview.postMessage({
        type: 'meta',
        meta: this.buildMeta(),
        issues: this.buildIssues(),
        strings: this.strings,
        locale: vscode.env.language,
      });
      return;
    }

    this.sentCount = points.length;
    this.sentLastTime = fresh[fresh.length - 1].t;
    void view.webview.postMessage({
      type: 'append',
      points: fresh,
      gcEvents: gcEvents.filter(event => event.t > this.sentLastTime - this.windowMs()),
      issues: this.buildIssues(),
      meta: this.buildMeta(),
      strings: this.strings,
      locale: vscode.env.language,
    });
  }

  dispose(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
    }

    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** Сообщения из webview. */
  private handleMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'ready':
        // Панель загрузила скрипты и готова принимать данные: значит разметка и политика безопасности верны.
        this.logger.info(translate('Charts panel is ready, sending data.'));
        this.sendSnapshot();
        return;

      case 'requestSnapshot':
        this.sendSnapshot();
        return;

      case 'rendered':
        // Подтверждение от панели: данные дошли и графики нарисованы.
        this.logger.info(translate(
          'Charts panel: points drawn — {0}, canvas sizes [{1}], pixels painted: {2}, issues shown: {3}.',
          message.points ?? 0,
          message.canvases ?? '—',
          message.painted === true ? translate('yes') : translate('no'),
          message.issues ?? 0,
        ));
        return;

      case 'problem':
        // Панель сообщает о сбое отрисовки — пишем в журнал, чтобы проблема не потерялась.
        this.logger.error(translate('Charts panel: {0}', message.message ?? translate('unknown error')));
        return;

      default:
        this.logger.warn(translate('Charts panel sent an unknown message: {0}', JSON.stringify(message)));
        return;
    }
  }

  /** Отправляет полный снимок данных. */
  private sendSnapshot(): void {
    const view = this.view;
    if (view === undefined) {
      return;
    }

    const points = this.buildPoints();
    this.logger.info(translate('Charts panel: points sent — {0}.', points.length));
    this.sentCount = points.length;
    this.sentLastTime = points.length > 0 ? points[points.length - 1].t : 0;
    this.sentGeneration = this.state.generation;

    void view.webview.postMessage({
      type: 'snapshot',
      meta: this.buildMeta(),
      points,
      gcEvents: this.buildGcEvents().slice(-CHART_HISTORY_LIMIT),
      issues: this.buildIssues(),
      strings: this.strings,
      locale: vscode.env.language,
    });
  }

  /** Собирает точки графика из состояния (не больше предела истории). */
  private buildPoints(): ChartPoint[] {
    const series = this.state.series;
    const from = Math.max(0, series.length - CHART_HISTORY_LIMIT);
    return series.slice(from).map(toChartPoint);
  }

  /** Собирает события GC для отметок на графике. */
  private buildGcEvents(): ChartGcEvent[] {
    const result: ChartGcEvent[] = [];
    for (const event of this.state.gcEvents) {
      const converted = toChartGcEvent(event);
      if (converted !== undefined) {
        result.push(converted);
      }
    }

    return result;
  }

  /**
   * Ищет проблемы производительности в собранных данных.
   * Список пересчитывается на каждом обновлении: интервалы уточняются по мере поступления точек.
   */
  private buildIssues(): ChartIssue[] {
    return collectIssues(this.state, this.getEnableIssues());
  }

  private buildMeta(): ChartMeta {
    const latest = this.state.latest;
    return buildChartMeta(
      this.state.hello,
      this.state.status,
      this.state.statusHint ?? this.state.lastError ?? null,
      this.getRefreshIntervalSeconds(),
      this.getWindowSeconds(),
      latest?.gcCollections ?? { gen0: 0, gen1: 0, gen2: 0 },
    );
  }

  private windowMs(): number {
    return Math.max(1, this.getWindowSeconds()) * 1000;
  }

  /** Склеивает частые изменения в одно обновление. */
  private scheduleFlush(): void {
    if (this.flushTimer !== undefined || this.view === undefined || !this.view.visible) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.sync();
    }, 150);
  }

  /** Разметка панели: шапка, плитки, область графиков и сводка по выделению. */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'charts.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'charts.css'));

    // Строгая политика: только собственные скрипты и стили, без внешних источников.
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Monitor Dotnet: Performance</title>
</head>
<body>
  <header>
    <div>
      <div class="process-name" id="process-name">${translate('No process selected')}</div>
      <div class="process-details" id="process-details"></div>
    </div>
    <div class="controls">
      <button id="pause" type="button" aria-pressed="false">${translate('Pause')}</button>
      <button id="reset-selection" type="button">${translate('Reset selection')}</button>
    </div>
  </header>
  <section class="cards" id="cards"></section>
  <section class="issues" id="issues" hidden></section>
  <section class="charts" id="charts"></section>
  <section class="summary" id="summary" hidden></section>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Случайная строка для атрибута nonce в политике безопасности. */
function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 32; index++) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return result;
}
