/**
 * Панель снимка CPU.
 *
 * Данные приходят из `ProfilingTools`: разобранный профиль Speedscope или сравнение
 * двух профилей. Внутри webview — топ методов, дерево вызовов, флеймграф и таблица
 * изменений; сама запись и разбор выполняются в расширении.
 */

import path from 'node:path';
import * as vscode from 'vscode';
import { buildCpuWebviewStrings } from '../core/cpuWebviewStrings.ts';
import { translate } from '../core/locale.ts';
import { createNonce } from '../core/webviewHtml.ts';
import type { CpuProfile, CpuProfileComparison } from '../core/cpuProfile.ts';
import type { Logger } from '../logger.ts';

/** Что показывает панель: один снимок или сравнение двух. */
type PanelContent =
  | { kind: 'profile'; profile: CpuProfile }
  | { kind: 'comparison'; comparison: CpuProfileComparison };

/** Сообщение из webview. */
interface PanelMessage {
  type?: string;
  message?: string;
}

export class CpuProfilePanel implements vscode.Disposable {
  /** Идентификатор типа панели: нужен для восстановления вкладки. */
  static readonly viewType = 'monitor-dotnet.cpuProfile';

  /** Открытая панель: новый снимок заменяет содержимое, а не плодит вкладки. */
  private static current: CpuProfilePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly logger: Logger;
  private content: PanelContent;
  private webviewReady = false;

  /** Показывает разобранный снимок CPU. */
  static show(
    extensionUri: vscode.Uri,
    profile: CpuProfile,
    logger: Logger,
  ): void {
    CpuProfilePanel.open(
      extensionUri,
      { kind: 'profile', profile },
      translate('CPU snapshot: {0}', path.basename(profile.file)),
      logger,
    );
  }

  /** Показывает сравнение двух снимков в той же панели. */
  static showComparison(
    extensionUri: vscode.Uri,
    comparison: CpuProfileComparison,
    logger: Logger,
  ): void {
    CpuProfilePanel.open(
      extensionUri,
      { kind: 'comparison', comparison },
      translate(
        'CPU snapshot comparison: {0} ↔ {1}',
        path.basename(comparison.before.file),
        path.basename(comparison.after.file),
      ),
      logger,
    );
  }

  private static open(
    extensionUri: vscode.Uri,
    content: PanelContent,
    title: string,
    logger: Logger,
  ): void {
    if (CpuProfilePanel.current !== undefined) {
      CpuProfilePanel.current.update(content, title);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CpuProfilePanel.viewType,
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
      },
    );

    CpuProfilePanel.current = new CpuProfilePanel(panel, extensionUri, content, title, logger);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    content: PanelContent,
    title: string,
    logger: Logger,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.content = content;
    this.logger = logger;

    panel.title = title;
    panel.webview.html = this.buildHtml(panel.webview);
    panel.webview.onDidReceiveMessage(message => void this.handleMessage(message as PanelMessage));
    panel.onDidDispose(() => {
      if (CpuProfilePanel.current === this) {
        CpuProfilePanel.current = undefined;
      }
    });
  }

  dispose(): void {
    this.panel.dispose();
  }

  /** Новые данные в уже открытой панели. */
  private update(content: PanelContent, title: string): void {
    this.content = content;
    this.panel.title = title;
    this.panel.reveal(vscode.ViewColumn.Active);
    this.postContent();
  }

  private postContent(): void {
    if (!this.webviewReady) {
      return;
    }

    const strings = buildCpuWebviewStrings(translate);
    const locale = vscode.env.language;
    const message = this.content.kind === 'profile'
      ? { type: 'profile', profile: this.content.profile, strings, locale }
      : { type: 'comparison', comparison: this.content.comparison, strings, locale };
    void this.panel.webview.postMessage(message);
  }

  private async handleMessage(message: PanelMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.webviewReady = true;
        this.postContent();
        break;

      case 'openProfile': {
        if (this.content.kind !== 'profile') {
          return;
        }

        const file = this.content.profile.file;
        if (file.length === 0) {
          return;
        }

        this.logger.info(translate('Opening CPU profile: {0}', file));
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
        break;
      }

      case 'revealProfile': {
        if (this.content.kind !== 'profile') {
          return;
        }

        const file = this.content.profile.file;
        if (file.length > 0) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
        }

        break;
      }

      case 'problem':
        this.logger.warn(translate('CPU profile panel: {0}', message.message ?? ''));
        break;

      default:
        break;
    }
  }

  /** Разметка панели: всё содержимое строит скрипт из сообщения с данными. */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'cpu.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'cpu.css'),
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
  <title>${translate('CPU profile')}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
