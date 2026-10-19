/** Проверки ассоциации профилей Speedscope с просмотрщиком. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  hasSpeedscopeAssociation,
  SPEEDSCOPE_FILE_PATTERN,
  SPEEDSCOPE_VIEW_TYPE,
  withSpeedscopeAssociation,
} from './editorAssociations.ts';

test('ассоциация добавляется в пустые настройки', () => {
  assert.deepEqual(withSpeedscopeAssociation(undefined), {
    [SPEEDSCOPE_FILE_PATTERN]: SPEEDSCOPE_VIEW_TYPE,
  });
});

test('существующие ассоциации сохраняются', () => {
  const merged = withSpeedscopeAssociation({ '*.md': 'vscode.markdown.preview.editor' });

  assert.deepEqual(merged, {
    '*.md': 'vscode.markdown.preview.editor',
    [SPEEDSCOPE_FILE_PATTERN]: SPEEDSCOPE_VIEW_TYPE,
  });
});

test('строковое или неожиданное значение настройки не ломает слияние', () => {
  // Пользователь мог вписать строку вручную — тогда считаем настройку пустой.
  assert.deepEqual(withSpeedscopeAssociation('что-то'), { [SPEEDSCOPE_FILE_PATTERN]: SPEEDSCOPE_VIEW_TYPE });
  assert.deepEqual(withSpeedscopeAssociation(null), { [SPEEDSCOPE_FILE_PATTERN]: SPEEDSCOPE_VIEW_TYPE });
  assert.deepEqual(withSpeedscopeAssociation([1, 2]), { [SPEEDSCOPE_FILE_PATTERN]: SPEEDSCOPE_VIEW_TYPE });
});

test('готовность ассоциации определяется в обеих формах записи', () => {
  assert.equal(hasSpeedscopeAssociation({ [SPEEDSCOPE_FILE_PATTERN]: SPEEDSCOPE_VIEW_TYPE }), true);
  assert.equal(
    hasSpeedscopeAssociation({ [SPEEDSCOPE_FILE_PATTERN]: { viewType: SPEEDSCOPE_VIEW_TYPE } }),
    true,
  );
  assert.equal(hasSpeedscopeAssociation({ '*.md': 'vscode.markdown.preview.editor' }), false);
  assert.equal(hasSpeedscopeAssociation(undefined), false);
  assert.equal(hasSpeedscopeAssociation('строка'), false);
});
