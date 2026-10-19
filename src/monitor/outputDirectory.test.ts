/**
 * Проверки каталога для результатов профилирования.
 *
 * Главное правило: без настройки файлы идут в `.monitor-dotnet` внутри проекта,
 * а не во временный каталог системы, и не попадают в git.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultOutputDirectory, listResultFiles, OUTPUT_DIRECTORY_NAME, prepareOutputDirectory } from './outputDirectory.ts';

/** Временный «проект»: не трогает ни репозиторий, ни систему. */
function temporaryProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'monitor-dotnet-project-'));
}

test('по умолчанию результаты идут в .monitor-dotnet внутри проекта', () => {
  const project = '/home/user/projects/app';

  assert.equal(defaultOutputDirectory(project), path.join(project, OUTPUT_DIRECTORY_NAME));
  assert.equal(OUTPUT_DIRECTORY_NAME, '.monitor-dotnet');
});

test('без открытого проекта используется временный каталог', () => {
  const directory = defaultOutputDirectory(undefined);

  assert.ok(directory.includes(os.tmpdir()), `неожиданный каталог: ${directory}`);
  assert.ok(!directory.includes('.monitor-dotnet'), 'скрытый каталог в системном временном каталоге не нужен');
});

test('каталог создаётся вместе с .gitignore, чтобы артефакты не попадали в git', async () => {
  const project = temporaryProject();
  try {
    const directory = await prepareOutputDirectory('', project);

    assert.equal(directory, path.join(project, OUTPUT_DIRECTORY_NAME));
    assert.ok(existsSync(directory), 'каталог не создан');
    const ignore = path.join(directory, '.gitignore');
    assert.ok(existsSync(ignore), 'нет .gitignore');
    assert.match(readFileSync(ignore, 'utf8'), /^\*$/m, 'в .gitignore нет правила «игнорировать всё»');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('существующий .gitignore пользователя не перезаписывается', async () => {
  const project = temporaryProject();
  try {
    const directory = path.join(project, OUTPUT_DIRECTORY_NAME);
    await prepareOutputDirectory('', project);

    const ignore = path.join(directory, '.gitignore');
    writeFileSync(ignore, '# мой файл\n', 'utf8');
    await prepareOutputDirectory('', project);

    assert.equal(readFileSync(ignore, 'utf8'), '# мой файл\n', 'файл пользователя изменён');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('заданная настройка используется как есть и без .gitignore', async () => {
  const project = temporaryProject();
  const configured = path.join(project, 'custom', 'traces');
  try {
    const directory = await prepareOutputDirectory(configured, project);

    assert.equal(directory, configured);
    assert.ok(existsSync(configured), 'каталог настройки не создан');
    assert.ok(!existsSync(path.join(configured, '.gitignore')), 'в пользовательском каталоге не должно быть нашего .gitignore');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('файлы профилей находятся и сортируются от новых к старым', async () => {
  const project = temporaryProject();
  try {
    const directory = await prepareOutputDirectory('', project);
    const older = path.join(directory, 'trace-1.speedscope.json');
    const newer = path.join(directory, 'trace-2.speedscope.json');
    writeFileSync(older, '{}', 'utf8');
    writeFileSync(newer, '{}', 'utf8');
    // Выставляем время явно: в пределах одной секунды файловая система может его не различить.
    utimesSync(older, new Date(2026, 0, 1), new Date(2026, 0, 1));
    utimesSync(newer, new Date(2026, 0, 2), new Date(2026, 0, 2));
    writeFileSync(path.join(directory, 'trace-1.nettrace'), 'x', 'utf8');

    const found = await listResultFiles(directory, '.speedscope.json');

    assert.deepEqual(found, [newer, older], 'файлы найдены не в том порядке');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('отсутствующий каталог не считается ошибкой', async () => {
  const missing = path.join(os.tmpdir(), 'monitor-dotnet-missing-98123');

  assert.deepEqual(await listResultFiles(missing, '.speedscope.json'), []);
});
