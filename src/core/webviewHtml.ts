/**
 * Общие мелочи для HTML-панелей webview.
 * `nonce` вынесен отдельно, чтобы обе панели использовали одну и ту же реализацию.
 */

/** Случайная строка для атрибута `nonce` в политике безопасности. */
export function createNonce(length = 32): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let index = 0; index < length; index++) {
    result += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }

  return result;
}
