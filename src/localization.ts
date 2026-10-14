/**
 * Подключение механизмов локализации VS Code.
 *
 * Строки интерфейса пишутся по-английски прямо в коде и переводятся через `vscode.l10n`
 * по словарю `l10n/bundle.l10n.<язык>.json`. Язык форматирования чисел и дат берётся из
 * настроек редактора (`vscode.env.language`).
 *
 * Вызывается один раз при активации расширения.
 */

import * as vscode from 'vscode';
import { configureLocale, setTranslator } from './core/locale.ts';

/** Подключает перевод строк и язык форматирования. */
export function activateLocalization(): void {
  setTranslator(message => vscode.l10n.t(message));
  configureLocale(vscode.env.language);
}
