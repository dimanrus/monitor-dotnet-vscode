import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureLocale, getLocale, localeTag, word } from './locale.ts';

test('язык определяется по коду локали', () => {
  configureLocale('ru');
  assert.equal(getLocale(), 'ru');

  configureLocale('ru-RU');
  assert.equal(getLocale(), 'ru');

  configureLocale('en-US');
  assert.equal(getLocale(), 'en');

  // Неизвестный язык считаем английским.
  configureLocale('de');
  assert.equal(getLocale(), 'en');
});

test('тег локали подходит для Intl', () => {
  configureLocale('ru');
  assert.equal(localeTag(), 'ru-RU');

  configureLocale('en');
  assert.equal(localeTag(), 'en-US');
});

test('слова переводятся и принимают значения', () => {
  configureLocale('ru');
  assert.equal(word('megabyte'), 'МБ');
  assert.equal(word('seriesAverage', '1 КБ'), 'Среднее: 1 КБ');

  configureLocale('en');
  assert.equal(word('megabyte'), 'MB');
  assert.equal(word('seriesAverage', '1 KB'), 'Average: 1 KB');
});

test('все ключи есть в обоих языках', () => {
  const keys = ['byte', 'megabyte', 'kindGauge', 'partSeparator'] as const;
  for (const key of keys) {
    configureLocale('en');
    assert.ok(word(key).length > 0, `нет английского текста для ${key}`);
    configureLocale('ru');
    assert.ok(word(key).length > 0, `нет русского текста для ${key}`);
  }

  configureLocale('en');
});
