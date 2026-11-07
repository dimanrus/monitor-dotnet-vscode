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
import type { Logger } from '../logger.ts';
import type { DumpComparison, DumpReport } from '../monitor/dumpAnalysis.ts';

/** Что показывает панель: один дамп или сравнение двух. */
type PanelContent =
  | { kind: 'report'; report: DumpReport }
  | { kind: 'comparison'; comparison: DumpComparison };

/** Сообщение из webview. */
interface PanelMessage {
  type?: string;
  message?: string;
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

  /** Показывает отчёт: переиспользует открытую панель, если она есть. */
  static show(
    extensionUri: vscode.Uri,
    report: DumpReport,
    textReport: string,
    logger: Logger,
  ): void {
    DumpAnalysisPanel.open(
      extensionUri,
      { kind: 'report', report },
      report.source === 'gcdump'
        ? translate('Memory snapshot: {0}', path.basename(report.dumpFile))
        : translate('Memory dump: {0}', path.basename(report.dumpFile)),
      textReport,
      logger,
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
  ): void {
    if (DumpAnalysisPanel.current !== undefined) {
      DumpAnalysisPanel.current.update(content, title, textReport);
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

    DumpAnalysisPanel.current = new DumpAnalysisPanel(panel, extensionUri, content, title, textReport, logger);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    content: PanelContent,
    title: string,
    textReport: string,
    logger: Logger,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.content = content;
    this.textReport = textReport;
    this.logger = logger;

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
  private update(content: PanelContent, title: string, textReport: string): void {
    this.content = content;
    this.textReport = textReport;
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
    const message = this.content.kind === 'report'
      ? { type: 'report', report: this.content.report, strings, locale }
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

      case 'problem':
        this.logger.warn(translate('Dump analysis panel: {0}', message.message ?? ''));
        break;

      default:
        break;
    }
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

/** Случайная строка для атрибута nonce в политике безопасности. */
function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < 32; index++) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return result;
}
