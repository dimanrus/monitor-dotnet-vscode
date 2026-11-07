/**
 * Разбор снимков памяти GCDump.
 *
 * Снимок снимается `dotnet-gcdump collect`, а читается обратно командой
 * `dotnet-gcdump report <файл>`. Отчёт печатает итоги кучи и таблицу
 * «размер объекта — количество — тип», сгруппированную по точному размеру
 * объекта, поэтому суммарный размер типа считается как `размер × количество`.
 *
 * Модуль не зависит от API VS Code: его проверяют тесты.
 */

import { formatBytes, formatPercent } from '../core/formatting.ts';
import { translate } from '../core/locale.ts';
import {
  formatTimestamp,
  type DumpAnalysis,
  type DumpFinding,
  type DumpReport,
  type HeapStatEntry,
  type HeapStatSummary,
} from './dumpAnalysis.ts';

/** Сколько крупнейших типов показывать в текстовой сводке. */
const SUMMARY_LIMIT = 10;

/** Строка таблицы отчёта: `размер объекта`, `количество`, `тип`. */
const ROW_PATTERN = /^\s*([\d,]+)\s+([\d,]+)\s{2,}(\S.*)$/;

/** Заголовок таблицы: с него начинается разбор строк. */
const TABLE_HEADER = /^\s*Object\s+Bytes\s+Count\s+Type\s*$/i;

/** Сборка в конце имени типа: `System.String  [System.Private.CoreLib.dll]`. */
const ASSEMBLY_SUFFIX = /\s+\[[^\]]+\]\s*$/;

/**
 * Пометка диапазона для крупных объектов: `System.Byte[] (Bytes > 100K)`.
 * Один и тот же тип может встретиться в нескольких строках с разными диапазонами.
 */
const SIZE_BUCKET = /\s+\(Bytes\s*>\s*[\d.]+\s*[KMG]?\)\s*$/i;

/** Число с разделителями разрядов. */
function toNumber(value: string): number {
  return Number(value.replaceAll(',', ''));
}

/** Имя типа без сборки и пометки диапазона размеров. */
function cleanTypeName(value: string): string {
  return value.replace(ASSEMBLY_SUFFIX, '').replace(SIZE_BUCKET, '').trim();
}

/** Итоговое значение из строки вида `15,303,007  GC Heap bytes`. */
function readTotal(output: string, label: string): number | undefined {
  const pattern = new RegExp(`^\\s*([\\d,]+)\\s+${label}\\s*$`, 'm');
  const match = pattern.exec(output);
  return match === null ? undefined : toNumber(match[1]);
}

/**
 * Разбирает вывод `dotnet-gcdump report`.
 * `undefined` означает, что таблицы в выводе нет: файл не читается или формат другой.
 */
export function parseGcdumpReport(output: string): HeapStatSummary | undefined {
  const byType = new Map<string, HeapStatEntry>();
  let inTable = false;

  for (const line of output.split(/\r?\n/)) {
    if (TABLE_HEADER.test(line)) {
      inTable = true;
      continue;
    }

    if (!inTable) {
      continue;
    }

    const match = ROW_PATTERN.exec(line);
    if (match === null) {
      continue;
    }

    const objectBytes = toNumber(match[1]);
    const count = toNumber(match[2]);
    const typeName = cleanTypeName(match[3]);
    if (typeName.length === 0 || !Number.isFinite(objectBytes) || !Number.isFinite(count)) {
      continue;
    }

    // В строке указан размер одного объекта в диапазоне, поэтому размер типа — произведение.
    const size = objectBytes * count;
    const existing = byType.get(typeName);
    if (existing === undefined) {
      byType.set(typeName, { typeName, count, size });
    } else {
      existing.count += count;
      existing.size += size;
    }
  }

  if (byType.size === 0) {
    return undefined;
  }

  const entries = [...byType.values()].sort((left, right) => right.size - left.size);
  return {
    entries,
    // Итоги из шапки точнее суммы строк: для крупных объектов указана только нижняя граница.
    totalSize: readTotal(output, 'GC Heap bytes') ?? entries.reduce((sum, entry) => sum + entry.size, 0),
    totalCount: readTotal(output, 'GC Heap objects') ?? entries.reduce((sum, entry) => sum + entry.count, 0),
  };
}

/** Наблюдения по снимку памяти. */
export function buildGcdumpFindings(heap: HeapStatSummary | undefined): DumpFinding[] {
  if (heap === undefined) {
    return [{
      level: 'warning',
      title: translate('The snapshot could not be parsed'),
      detail: translate('Check that dotnet-gcdump can read this file.'),
    }];
  }

  const findings: DumpFinding[] = [];
  const top = heap.entries[0];
  if (top === undefined || heap.totalSize <= 0) {
    return findings;
  }

  const share = (top.size / heap.totalSize) * 100;
  if (share >= 25) {
    findings.push({
      level: share >= 50 ? 'warning' : 'info',
      title: translate('One type takes most of the heap'),
      detail: translate(
        '{0} takes {1} ({2}) of the managed heap.',
        top.typeName,
        formatBytes(top.size),
        formatPercent(share),
      ),
    });
  }

  return findings;
}

/** Параметры отчёта: время и размер файла снимка. */
export interface GcdumpReportOptions {
  takenAt?: Date;
  fileBytes?: number;
}

/**
 * Разбирает снимок памяти в тот же отчёт, что и дамп: панель умеет показывать
 * любые разобранные данные, а сравнение снимков переиспользует сравнение куч.
 */
export function analyzeGcdumpOutput(
  file: string,
  output: string,
  generatedAt: Date,
  options: GcdumpReportOptions = {},
): DumpAnalysis {
  const heap = parseGcdumpReport(output);
  const text = output.trim();

  const report: DumpReport = {
    title: translate('Memory snapshot analysis'),
    source: 'gcdump',
    dumpFile: file,
    generatedAt: formatTimestamp(generatedAt),
    takenAt: options.takenAt === undefined ? undefined : formatTimestamp(options.takenAt),
    dumpBytes: options.fileBytes,
    sections: [{
      id: 'gcdump',
      title: translate('Heap by type'),
      commands: ['dotnet-gcdump report'],
      output: text,
    }],
    views: heap === undefined
      ? undefined
      : [{
          command: 'dotnet-gcdump report',
          title: translate('Heap by type'),
          blocks: [{ kind: 'heapTypes', heap, typeCount: heap.entries.length }],
        }],
    heap,
    typeCount: heap?.entries.length,
    findings: buildGcdumpFindings(heap),
  };

  return { report, facts: { heap } };
}

/** Текстовый отчёт по снимку: сводка по типам и полный вывод инструмента. */
export function formatGcdumpReport(
  file: string,
  output: string,
  generatedAt: Date,
  options: GcdumpReportOptions = {},
): string {
  const heap = parseGcdumpReport(output);
  const lines = [
    translate('Memory snapshot analysis'),
    translate('Snapshot: {0}', file),
    ...(options.takenAt === undefined
      ? []
      : [translate('Snapshot taken: {0}', formatTimestamp(options.takenAt))]),
    translate('Report created: {0}', formatTimestamp(generatedAt)),
  ];

  if (heap !== undefined) {
    lines.push(
      '',
      translate('Managed heap summary'),
      `  ${translate('Size').padStart(10)}  ${translate('Count').padStart(10)}  ${translate('Share').padStart(5)}  ${translate('Type')}`,
    );

    for (const entry of heap.entries.slice(0, SUMMARY_LIMIT)) {
      const share = heap.totalSize === 0 ? 0 : (entry.size / heap.totalSize) * 100;
      lines.push(
        `  ${formatBytes(entry.size).padStart(10)}  ${String(entry.count).padStart(10)}  ${`${share.toFixed(1)}%`.padStart(5)}  ${entry.typeName}`,
      );
    }

    lines.push(translate('Total: {0} objects, {1}', heap.totalCount, formatBytes(heap.totalSize)));
  }

  lines.push('', translate('Output:'));
  lines.push(output.trim().length > 0 ? output.trimEnd() : translate('(no output)'));
  return `${lines.join('\n')}\n`;
}
