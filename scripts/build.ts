/**
 * Сборка расширения.
 *
 * esbuild собирает два бандла:
 *  1. dist/extension.cjs — код расширения для хоста VS Code (CommonJS, Node);
 *  2. dist/webview/charts.js и charts.css — логика панели графиков для webview (браузер).
 *
 * TypeScript 7 (нативный компилятор) используется для проверки типов: `npm run typecheck`.
 */
import { build, context, type BuildOptions } from 'esbuild';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** Код расширения: Node + CommonJS, модуль vscode предоставляет хост. */
const extensionOptions: BuildOptions = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(root, 'dist', 'extension.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  external: ['vscode'],
};

/** Панель графиков: браузерный бандл внутри webview, стили выносятся в отдельный файл. */
const webviewOptions: BuildOptions = {
  entryPoints: [path.join(root, 'src', 'webview', 'charts.ts')],
  outfile: path.join(root, 'dist', 'webview', 'charts.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/**
 * Копирует собранный мост рядом с расширением, если он уже был опубликован.
 * Так расширение работает без сборки .NET-проекта у пользователя.
 */
async function copyBridgeIfPresent(): Promise<void> {
  const published = path.join(root, 'media', 'bridge');
  const target = path.join(root, 'dist', 'bridge');

  try {
    const info = await stat(published);
    if (!info.isDirectory()) {
      return;
    }

    await rm(target, { recursive: true, force: true });
    const copied = await copyDirectory(published, target);
    console.log(`Мост скопирован в dist/bridge (${copied} файлов).`);
  } catch {
    // Мост ещё не публиковался: расширение соберёт его из исходников при первом запуске.
  }
}

/** Рекурсивно копирует каталог. Отладочные символы не нужны в поставке. */
async function copyDirectory(from: string, to: string): Promise<number> {
  await mkdir(to, { recursive: true });
  let copied = 0;

  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);

    if (entry.isDirectory()) {
      copied += await copyDirectory(source, destination);
    } else if (!entry.name.endsWith('.pdb')) {
      await copyFile(source, destination);
      copied++;
    }
  }

  return copied;
}

async function main(): Promise<void> {
  if (watch) {
    const contexts = await Promise.all([context(extensionOptions), context(webviewOptions)]);
    await Promise.all(contexts.map(item => item.watch()));
    console.log('Сборка расширения и панели графиков запущена в режиме наблюдения.');
    return;
  }

  await Promise.all([build(extensionOptions), build(webviewOptions)]);
  await copyBridgeIfPresent();
  console.log('Собрано: dist/extension.cjs, dist/webview/charts.js, dist/webview/charts.css');
}

await main();
