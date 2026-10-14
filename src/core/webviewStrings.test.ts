import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildWebviewStrings,
  DEFAULT_WEBVIEW_STRINGS,
  WEBVIEW_SOURCE_STRINGS,
} from './webviewStrings.ts';

test('английские тексты заполнены и совпадают с ключами перевода', () => {
  for (const [key, value] of Object.entries(WEBVIEW_SOURCE_STRINGS)) {
    assert.ok(value.length > 0, `пустой текст для ${key}`);
    assert.equal(DEFAULT_WEBVIEW_STRINGS[key as keyof typeof DEFAULT_WEBVIEW_STRINGS], value);
  }
});

test('локализованный набор использует переводчик для каждой строки', () => {
  const translated = buildWebviewStrings(source => `[ru] ${source}`);

  assert.equal(translated.chartCpuTitle, '[ru] CPU load');
  assert.equal(translated.summaryTitle, '[ru] Selected range');
  assert.equal(Object.keys(translated).length, Object.keys(WEBVIEW_SOURCE_STRINGS).length);
});

test('переводчик может вернуть исходную строку — набор остаётся пригодным', () => {
  const identity = buildWebviewStrings(source => source);

  assert.deepEqual(identity, DEFAULT_WEBVIEW_STRINGS);
});
