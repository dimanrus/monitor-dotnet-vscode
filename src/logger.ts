/**
 * Канал вывода расширения. Туда же попадает диагностика моста (stderr),
 * чтобы при проблемах было видно, что происходило.
 */

import * as vscode from 'vscode';
import { describeError } from './core/errors.ts';

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor(name = 'Monitor Dotnet') {
    this.channel = vscode.window.createOutputChannel(name);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, error?: unknown): void {
    this.write('error', error === undefined ? message : `${message}: ${describeError(error)}`);
  }

  /** Дописывает строку без пометки уровня — например, вывод внешних инструментов. */
  raw(message: string): void {
    this.channel.appendLine(message);
  }

  /** Показывает панель вывода с логом расширения. */
  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private write(level: string, message: string): void {
    // Метка времени ставится при записи: иначе все строки сессии выглядели бы одновременными.
    this.channel.appendLine(`[${new Date().toISOString()}] [${level}] ${message}`);
  }
}

export { describeError };
