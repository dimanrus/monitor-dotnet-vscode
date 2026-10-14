/**
 * Проверки локализации.
 *
 * Тесты следят за тем, чтобы словари не расходились с кодом:
 *  - все ссылки вида `%key%` в package.json есть и в английском, и в русском словаре;
 *  - все строки, проходящие через `translate(...)`, переведены на русский;
 *  - в словарях нет лишних записей.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { WEBVIEW_SOURCE_STRINGS } from '../src/core/webviewStrings.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  const content = await readFile(path.join(projectRoot, relativePath), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

/** Все ссылки `%key%` в манифесте расширения. */
function collectManifestKeys(manifest: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      const match = /^%([A-Za-z0-9._]+)%$/.exec(value);
      if (match !== null) {
        keys.add(match[1]);
      }

      return;
    }

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(walk);
    }
  };

  walk(manifest);
  return keys;
}

/** Строки, которые код передаёт в `translate(...)`. */
async function collectCodeStrings(): Promise<Set<string>> {
  const { readdir } = await import('node:fs/promises');
  const strings = new Set<string>();

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }

      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
        continue;
      }

      const content = await readFile(full, 'utf8');
      for (const match of content.matchAll(/\btranslate\(\s*'((?:[^'\\]|\\.)*)'/g)) {
        strings.add(match[1].replace("\\'", "'"));
      }

      for (const match of content.matchAll(/\btranslate\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        strings.add(match[1].replace('\\"', '"'));
      }
    }
  };

  await walk(path.join(projectRoot, 'src'));
  return strings;
}

test('манифест подключает каталог локализации', async () => {
  const manifest = await readJson('package.json');
  assert.equal(manifest['l10n'], './l10n');

  // Русский словарь строк должен лежать в каталоге локализации.
  const bundle = await readJson('l10n/bundle.l10n.ru.json');
  assert.ok(Object.keys(bundle).length > 0);
});

test('все ссылки вида %key% есть в английском и русском словарях', async () => {
  const manifest = await readJson('package.json');
  const keys = collectManifestKeys(manifest);
  const english = await readJson('package.nls.json');
  const russian = await readJson('package.nls.ru.json');

  assert.ok(keys.size > 20, `подозрительно мало ключей: ${keys.size}`);
  for (const key of keys) {
    assert.ok(key in english, `нет английского текста для ${key}`);
    assert.ok(key in russian, `нет русского текста для ${key}`);
    assert.ok(String(english[key]).length > 0, `пустой английский текст для ${key}`);
    assert.ok(String(russian[key]).length > 0, `пустой русский текст для ${key}`);
  }
});

test('в словарях нет лишних записей', async () => {
  const manifest = await readJson('package.json');
  const keys = collectManifestKeys(manifest);

  for (const file of ['package.nls.json', 'package.nls.ru.json']) {
    const dictionary = await readJson(file);
    for (const key of Object.keys(dictionary)) {
      assert.ok(keys.has(key), `запись ${key} из ${file} больше не используется в манифесте`);
    }
  }
});

test('все строки интерфейса переведены на русский', async () => {
  const bundle = await readJson('l10n/bundle.l10n.ru.json');
  const fromCode = await collectCodeStrings();
  const fromWebview = Object.values(WEBVIEW_SOURCE_STRINGS);

  const missing: string[] = [];
  for (const source of [...fromCode, ...fromWebview]) {
    if (!(source in bundle)) {
      missing.push(source);
    }
  }

  assert.deepEqual(missing, [], `нет перевода для строк: ${missing.join(' | ')}`);
});

test('в словаре строк нет лишних записей', async () => {
  const bundle = await readJson('l10n/bundle.l10n.ru.json');
  const fromCode = await collectCodeStrings();
  const fromWebview = new Set<string>(Object.values(WEBVIEW_SOURCE_STRINGS));

  for (const key of Object.keys(bundle)) {
    const used = fromCode.has(key) || fromWebview.has(key);
    assert.ok(used, `перевод «${key}» больше не используется в коде`);
  }
});

test('английский и русский словари описывают одни и те же ключи', async () => {
  const english = Object.keys(await readJson('package.nls.json')).sort();
  const russian = Object.keys(await readJson('package.nls.ru.json')).sort();

  assert.deepEqual(russian, english);
});
