/**
 * Работа с путями в чистом виде: одинаково для расширения и webview.
 * Здесь нет обращений к файловой системе, поэтому функции проверяются тестами.
 */

/** Имя файла из пути: понимает и прямые, и обратные слэши. */
export function baseName(value: string): string {
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return index >= 0 ? value.slice(index + 1) : value;
}

/**
 * Отбрасывает расширение исполняемого файла или сборки.
 * `includeProjectFiles` нужен для подсказок отладки, где в `program` может быть `.csproj`.
 */
export function stripExtension(value: string, includeProjectFiles = false): string {
  return includeProjectFiles
    ? value.replace(/\.(dll|exe|so|dylib|csproj|fsproj|vbproj)$/i, '')
    : value.replace(/\.(dll|exe|so|dylib)$/i, '');
}
