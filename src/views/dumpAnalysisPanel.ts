/**
 * Панель графического разбора дампа памяти.
 *
 * Данные приходят из `buildDumpReport`: плитки с итогами, диаграммы кучи и
 * асинхронных state machine, а полный вывод SOS-команд — в сворачиваемых блоках.
 * Текстовый отчёт открывается отдельной кнопкой: в нём полный вывод без сокращений.
 */

import path from 'node:path';
import * as vscode from 'vscode';
import { buildDumpWebviewStrings } from '../core/dumpWebviewStrings.ts';
import { translate } from '../core/locale.ts';
import { createNonce } from '../core/webviewHtml.ts';
import type { Logger } from '../logger.ts';
import type {
  DumpComparison,
  DumpGcRoot,
  DumpObjectDetails,
  DumpObjectInstance,
  DumpReport,
} from '../monitor/dumpAnalysis.ts';

/** Что показывает панель: один дамп или сравнение двух. */
type PanelContent =
  | { kind: 'report'; report: DumpReport }
  | { kind: 'comparison'; comparison: DumpComparison };

/**
 * Действия, которые панель запрашивает у расширения.
 * Сам разбор дампа выполняется в `ProfilingTools`, панель лишь показывает результат.
 */
export interface DumpDrilldownHost {
  /** Объекты типа: `dumpheap -type`.
   * `undefined` означает, что команду выполнить не удалось. */
  inspectType?: (typeName: string) => Promise<DumpObjectInstance[] | undefined>;
  /** Поля объекта: `dumpobj`. */
  inspectObject?: (address: string) => Promise<DumpObjectDetails | undefined>;
  /** Пути до GC-корней: `gcroot`. */
  findRoots?: (address: string) => Promise<DumpGcRoot[] | undefined>;
  /** Открыть дамп в интерактивном `dotnet-dump analyze`. */
  openInTerminal?: () => Promise<void>;
  /** Снять полный дамп: из отчёта GCDump это путь к стекам и исключениям. */
  takeDump?: () => Promise<void>;
}

/** Сообщение из webview. */
interface PanelMessage {
  type?: string;
  message?: string;
  typeName?: string;
  address?: string;
}

export class DumpAnalysisPanel implements vscode.Disposable {
  /** Идентификатор типа панели: нужен для восстановления вкладки. */
  static readonly viewType = 'monitor-dotnet.dumpAnalysis';

  /** Открытая панель: повторный разбор заменяет её содержимое, а не плодит вкладки. */
  private static current: DumpAnalysisPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly logger: Logger;
  private content: PanelContent;
  private textReport: string;
  private webviewReady = false;
  private host: DumpDrilldownHost | undefined;

  /** Показывает отчёт: переиспользует открытую панель, если она есть. */
  static show(
    extensionUri: vscode.Uri,
    report: DumpReport,
    textReport: string,
    logger: Logger,
    host?: DumpDrilldownHost,
  ): void {
    DumpAnalysisPanel.open(
      extensionUri,
      { kind: 'report', report },
      report.source === 'gcdump'
        ? translate('Memory snapshot: {0}', path.basename(report.dumpFile))
        : translate('Memory dump: {0}', path.basename(report.dumpFile)),
      textReport,
      logger,
      host,
    );
  }

  /** Показывает сравнение двух дампов в той же панели. */
  static showComparison(
    extensionUri: vscode.Uri,
    comparison: DumpComparison,
    textReport: string,
    logger: Logger,
  ): void {
    const title = comparison.before.source === 'gcdump'
      ? translate(
          'Memory snapshot comparison: {0} ↔ {1}',
          path.basename(comparison.before.dumpFile),
          path.basename(comparison.after.dumpFile),
        )
      : translate(
          'Dump comparison: {0} ↔ {1}',
          path.basename(comparison.before.dumpFile),
          path.basename(comparison.after.dumpFile),
        );

    DumpAnalysisPanel.open(
      extensionUri,
      { kind: 'comparison', comparison },
      title,
      textReport,
      logger,
    );
  }

  private static open(
    extensionUri: vscode.Uri,
    content: PanelContent,
    title: string,
    textReport: string,
    logger: Logger,
    host?: DumpDrilldownHost,
  ): void {
    if (DumpAnalysisPanel.current !== undefined) {
      DumpAnalysisPanel.current.update(content, title, textReport, host);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DumpAnalysisPanel.viewType,
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
      },
    );

    DumpAnalysisPanel.current = new DumpAnalysisPanel(panel, extensionUri, content, title, textReport, logger, host);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    content: PanelContent,
    title: string,
    textReport: string,
    logger: Logger,
    host?: DumpDrilldownHost,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.content = content;
    this.textReport = textReport;
    this.logger = logger;
    this.host = host;

    panel.title = title;
    panel.webview.html = this.buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage(message => void this.handleMessage(message as PanelMessage));
    panel.onDidDispose(() => {
      if (DumpAnalysisPanel.current === this) {
        DumpAnalysisPanel.current = undefined;
      }
    });
  }

  dispose(): void {
    this.panel.dispose();
  }

  /** Новые данные в уже открытой панели. */
  private update(content: PanelContent, title: string, textReport: string, host?: DumpDrilldownHost): void {
    this.content = content;
    this.textReport = textReport;
    this.host = host;
    this.panel.title = title;
    this.panel.reveal(vscode.ViewColumn.Active);
    this.postContent();
  }

  private postContent(): void {
    if (!this.webviewReady) {
      return;
    }

    const strings = buildDumpWebviewStrings(translate);
    const locale = vscode.env.language;
    const report = this.content.kind === 'report' ? this.content.report : undefined;
    const message = this.content.kind === 'report'
      ? {
          type: 'report',
          report: this.content.report,
          strings,
          locale,
          // У снимка GCDump нет адресов объектов: клик по типу ему ничего не даст.
          canDrilldown: report?.source !== 'gcdump' && this.host?.inspectType !== undefined,
          canOpenTerminal: this.host?.openInTerminal !== undefined,
          canTakeDump: report?.source === 'gcdump' && this.host?.takeDump !== undefined,
        }
      : { type: 'comparison', comparison: this.content.comparison, strings, locale };

    void this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        this.postContent();
        break;

      case 'openText': {
        const document = await vscode.workspace.openTextDocument({
          content: this.textReport,
          language: 'plaintext',
        });
        await vscode.window.showTextDocument(document, { preview: false });
        break;
      }

      case 'inspectType':
        await this.postInstances(message.typeName);
        break;

      case 'inspectObject':
        await this.postObject(message.address);
        break;

      case 'gcRoots':
        await this.postRoots(message.address);
        break;

      case 'openTerminal':
        await this.host?.openInTerminal?.();
        break;

      case 'takeDump':
        await this.host?.takeDump?.();
        break;

      case 'problem':
        this.logger.warn(translate('Dump analysis panel: {0}', message.message ?? ''));
        break;

      default:
        break;
    }
  }

  /** Показывает объекты типа: `dumpheap -type`. */
  private async postInstances(typeName: string | undefined): Promise<void> {
    if (this.host?.inspectType === undefined || typeName === undefined || typeName.length === 0) {
      return;
    }

    void this.panel.webview.postMessage({ type: 'inspectorLoading' });
    const instances = await this.host.inspectType(typeName);
    if (instances === undefined) {
      void this.panel.webview.postMessage({
        type: 'inspectorError',
        message: translate('Could not read the dump. See the notification for details.'),
      });
      return;
    }

    void this.panel.webview.postMessage({ type: 'instances', typeName, instances });
  }

  /** Показывает поля объекта: `dumpobj`. */
  private async postObject(address: string | undefined): Promise<void> {
    if (this.host?.inspectObject === undefined || address === undefined || address.length === 0) {
      return;
    }

    void this.panel.webview.postMessage({ type: 'inspectorLoading' });
    const details = await this.host.inspectObject(address);
    if (details === undefined) {
      void this.panel.webview.postMessage({
        type: 'inspectorError',
        message: translate('Could not read the dump. See the notification for details.'),
      });
      return;
    }

    void this.panel.webview.postMessage({ type: 'object', details });
  }

  /** Показывает пути до GC-корней: `gcroot`. */
  private async postRoots(address: string | undefined): Promise<void> {
    if (this.host?.findRoots === undefined || address === undefined || address.length === 0) {
      return;
    }

    void this.panel.webview.postMessage({ type: 'inspectorLoading' });
    const roots = await this.host.findRoots(address);
    if (roots === undefined) {
      void this.panel.webview.postMessage({
        type: 'inspectorError',
        message: translate('Could not read the dump. See the notification for details.'),
      });
      return;
    }

    void this.panel.webview.postMessage({ type: 'roots', address, roots });
  }

  /** Разметка панели: всё содержимое строит скрипт из сообщения с данными. */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'dump.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'dump.css'),
    );

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
  <title>${translate('Memory dump analysis')}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
