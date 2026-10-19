/** Проверки имени Speedscope-файла. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speedscopeFileFor } from './toolArguments.ts';

test('имя Speedscope-файла строится из имени трассировки', () => {
  assert.equal(
    speedscopeFileFor('/project/.monitor-dotnet/trace-123.nettrace'),
    '/project/.monitor-dotnet/trace-123.speedscope.json',
  );
  // Расширение в верхнем регистре тоже встречается на Windows.
  assert.equal(speedscopeFileFor('C:/out/trace.Nettrace'), 'C:/out/trace.speedscope.json');
});
