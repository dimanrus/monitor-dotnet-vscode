/**
 * Снимки в каталоге результатов: CPU-профили Speedscope и снимки памяти GCDump.
 *
 * Группировка вынесена в чистый модуль: правила проверяются тестами без VS Code.
 * Порядок групп фиксирован, чтобы дерево не переставлялось между обновлениями.
 */

/** Вид снимка: память (`.gcdump`) или CPU (`.speedscope.json`). */
export type SnapshotKind = 'memory' | 'cpu';

/** Снимок в каталоге результатов. */
export interface SnapshotFileInfo {
  file: string;
  bytes: number;
  modifiedMs: number;
  kind: SnapshotKind;
}

/** Группа снимков одного вида. */
export interface SnapshotGroup {
  kind: SnapshotKind;
  /** Свежие снимки первыми. */
  files: SnapshotFileInfo[];
}

/** Порядок групп в дереве: сначала CPU, затем память. */
const GROUP_ORDER: readonly SnapshotKind[] = ['cpu', 'memory'];

/**
 * Группирует снимки по виду.
 * Пустые группы не возвращаются: в дереве нет смысла показывать заголовок без файлов.
 */
export function groupSnapshots(files: readonly SnapshotFileInfo[]): SnapshotGroup[] {
  const groups: SnapshotGroup[] = [];
  for (const kind of GROUP_ORDER) {
    const members = files
      .filter(file => file.kind === kind)
      .sort((left, right) => right.modifiedMs - left.modifiedMs);
    if (members.length > 0) {
      groups.push({ kind, files: members });
    }
  }

  return groups;
}
