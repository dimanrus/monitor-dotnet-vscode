/**
 * Получение данных диагностики по требованию: стек вызовов, снимки памяти,
 * дампы, запись счётчиков и профилирование.
 * Используются официальные средства .NET: `dotnet-stack`, `dotnet-gcdump`, `dotnet-dump`,
 * `dotnet-counters`, `dotnet-trace` и `dotnet-symbol`.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { formatBytes } from '../core/formatting.ts';
import { localeTag, translate } from '../core/locale.ts';
import { describeError } from '../core/errors.ts';
import {
  DEFAULT_ANALYSIS_IDS,
  SOS_ANALYSES,
  analysisText,
  analyzeDumpOutput,
  buildAnalyzeArgs,
  buildDumpComparison,
  buildDumpReport,
  commandsFromInput,
  formatAnalysisReport,
  formatComparisonReport,
  type SosAnalysis,
} from './dumpAnalysis.ts';
import { listDumpFiles, listMemoryFiles, listSnapshotFiles, type DumpFileInfo } from './dumpFiles.ts';
import { analyzeGcdumpOutput, formatGcdumpReport } from './gcdumpAnalysis.ts';
import { DumpAnalysisPanel } from '../views/dumpAnalysisPanel.ts';
import {
  CALL_STACK_TOOL,
  COUNTERS_TOOL,
  DUMP_TOOL,
  MEMORY_SNAPSHOT_TOOL,
  SYMBOL_TOOL,
  TRACE_TOOL,
  resolveToolPath,
  type DotnetTool,
} from './dotnetToolLocator.ts';
import {
  hasSpeedscopeAssociation,
  SPEEDSCOPE_FILE_PATTERN,
  SPEEDSCOPE_VIEWER_EXTENSION,
  withSpeedscopeAssociation,
} from './editorAssociations.ts';
import { defaultOutputDirectory, listResultFiles, prepareOutputDirectory } from './outputDirectory.ts';
import { formatToolDuration, speedscopeFileFor, traceBaseFor } from './toolArguments.ts';
import type { Logger } from '../logger.ts';

const execFileAsync = promisify(execFile);

/** Параметры записи профиля. */
export interface ProfilingOptions {
  /** Профиль `dotnet-trace`; `default` — не передавать `--profile`. */
  profile?: string;
  /** Длительность записи в секундах; 0 или пусто — до остановки. */
  durationSeconds?: number;
}

/** Параметры снятия дампа памяти. */
export interface DumpOptions {
  /** Тип дампа: `Full`, `Heap`, `Mini` или `Triage`. */
  type?: string;
  /** Добавить к дампу отчёт о сбое (`--crashreport`). */
  crashReport?: boolean;
}

/** Параметры выгрузки счётчиков в файл. */
export interface CountersExportOptions {
  /** Формат файла: `csv` или `json`. */
  format?: string;
  /** Сколько секунд писать. */
  durationSeconds?: number;
  /** Фильтр счётчиков в записи `Provider[A,B]`; пусто — набор инструмента. */
  counters?: string;
}

/** Обёртка над внешними инструментами диагностики. */
export class ProfilingTools implements vscode.Disposable {
  private traceProcess: ChildProcess | undefined;

  /** Признак записи профиля: по нему панель показывает кнопку остановки. */
  private readonly profilingChanged = new vscode.EventEmitter<boolean>();

  /** Запись профиля началась или закончилась (в том числе сама по `--duration`). */
  readonly onDidChangeProfiling = this.profilingChanged.event;

  /**
   * Предложения про просмотрщик показываем один раз за сессию:
   * иначе они повторялись бы при каждом открытии профиля.
   */
  private speedscopeSetupOffered = false;

  private readonly logger: Logger;

  /** Каталог расширения: из него панель берёт собранные скрипт и стили. */
  private readonly extensionUri: vscode.Uri;

  constructor(logger: Logger, extensionUri: vscode.Uri) {
    this.logger = logger;
    this.extensionUri = extensionUri;
  }

  /** Признак активной записи профиля. */
  get isProfiling(): boolean {
    return this.traceProcess !== undefined;
  }

  dispose(): void {
    this.profilingChanged.dispose();
    this.traceProcess?.kill('SIGKILL');
    this.traceProcess = undefined;
  }

  /**
   * Собирает стек вызовов и показывает его в редакторе.
   * Полезно при зависаниях интерфейса и подозрениях на блокировки.
   */
  async collectCallStack(pid: number, dotnetPath: string): Promise<void> {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: collecting the call stack…') },
      async () => {
        const output = await this.runTool(CALL_STACK_TOOL, dotnetPath, ['report', '-p', pid.toString()]);
        if (output === undefined) {
          return;
        }

        const document = await vscode.workspace.openTextDocument({ content: output, language: 'plaintext' });
        await vscode.window.showTextDocument(document, { preview: false });
      },
    );
  }

  /** Снимает дамп памяти (GCDump) и предлагает открыть разбор или каталог с файлом. */
  async collectMemorySnapshot(pid: number, dotnetPath: string, outputDirectory: string): Promise<void> {
    const target = path.join(await this.resolveOutputDirectory(outputDirectory), `memory-${pid}-${timestamp()}.gcdump`);
    let analyzeRequested = false;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: taking a memory snapshot…') },
      async () => {
        const output = await this.runTool(MEMORY_SNAPSHOT_TOOL, dotnetPath, ['collect', '-p', pid.toString(), '-o', target]);
        if (output === undefined) {
          return;
        }

        this.logger.info(translate('Memory snapshot saved: {0}', target));
        const analyze = translate('Analyse Memory Snapshot');
        const reveal = translate('Reveal in Explorer');
        const action = await vscode.window.showInformationMessage(
          translate('Memory snapshot saved: {0}', path.basename(target)),
          analyze,
          reveal,
        );
        if (action === analyze) {
          analyzeRequested = true;
        } else if (action === reveal) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
        }
      },
    );

    // Разбор запускается после уведомления: у него свой прогресс и своя панель.
    if (analyzeRequested) {
      await this.analyzeMemorySnapshot(dotnetPath, outputDirectory, target);
    }
  }

  /**
   * Открывает последний записанный профиль в формате Speedscope.
   * Кнопка нужна, чтобы не искать файл вручную: `dotnet-trace` кладёт `.speedscope.json`
   * рядом с трассировкой, и открыть его можно в любой момент после записи.
   */
  async openSpeedscopeProfile(outputDirectory: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    const profiles = await listResultFiles(directory, '.speedscope.json');

    if (profiles.length === 0) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: no Speedscope profile found in {0}. Run performance profiling first.',
        directory,
      ));
      return;
    }

    // Обычно нужен последний профиль, но выбор остаётся за пользователем.
    const picked = profiles.length === 1
      ? profiles[0]
      : await vscode.window.showQuickPick(
        profiles.map(profile => ({ label: path.basename(profile), profile })),
        { title: translate('Open Speedscope profile'), placeHolder: translate('Newest profiles first') },
      ).then(item => item?.profile);

    if (picked === undefined) {
      return;
    }

    // Перед открытием предлагаем просмотрщик: без него файл откроется как обычный JSON.
    await this.ensureSpeedscopeViewer();

    this.logger.info(translate('Opening Speedscope profile: {0}', picked));
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(picked));
  }

  /**
   * Предлагает установить просмотрщик Speedscope и связать с ним файлы профилей.
   * Оба шага необязательные: если пользователь откажется, профиль откроется как JSON.
   */
  private async ensureSpeedscopeViewer(): Promise<void> {
    if (this.speedscopeSetupOffered) {
      return;
    }

    this.speedscopeSetupOffered = true;
    const installed = vscode.extensions.getExtension(SPEEDSCOPE_VIEWER_EXTENSION) !== undefined;
    if (!installed) {
      const install = translate('Install');
      const action = await vscode.window.showInformationMessage(
        translate(
          'Monitor Dotnet: the Speedscope viewer shows .speedscope.json profiles inside VS Code. Install the extension?',
        ),
        install,
      );

      if (action === install) {
        this.logger.info(translate('Installing the Speedscope viewer: {0}', SPEEDSCOPE_VIEWER_EXTENSION));
        await vscode.commands.executeCommand('workbench.extensions.installExtension', SPEEDSCOPE_VIEWER_EXTENSION);
      }
    }

    await this.ensureSpeedscopeAssociation();
  }

  /** Записывает ассоциацию `*.speedscope.json` в настройки рабочей области. */
  private async ensureSpeedscopeAssociation(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('workbench');
    const current = configuration.get<unknown>('editorAssociations');
    if (hasSpeedscopeAssociation(current)) {
      return;
    }

    const associate = translate('Associate .speedscope.json files');
    const action = await vscode.window.showInformationMessage(
      translate(
        'Monitor Dotnet: open .speedscope.json profiles with the Speedscope viewer by default? This adds an editor association to the workspace settings.',
      ),
      associate,
    );

    if (action !== associate) {
      return;
    }

    try {
      await configuration.update('editorAssociations', withSpeedscopeAssociation(current));
      this.logger.info(translate('Editor association added for {0}.', SPEEDSCOPE_FILE_PATTERN));
    } catch (error) {
      // Настройку могли запретить политикой — тогда подсказываем, что вписать вручную.
      this.logger.warn(translate('Could not update editor associations: {0}', describeError(error)));
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: could not update the settings. Add "workbench.editorAssociations": { "*.speedscope.json": "speedscope-in-vscode.speedscope" } to your settings.json.',
      ));
    }
  }

  /**
   * Записывает счётчики в файл через `dotnet-counters collect`.
   *
   * Живые значения есть в панели, но файл остаётся после закрытия VS Code:
   * его можно приложить к задаче или разобрать в таблице.
   */
  async exportCounters(
    pid: number,
    dotnetPath: string,
    outputDirectory: string,
    options: CountersExportOptions = {},
  ): Promise<string | undefined> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    const format = options.format === 'json' ? 'json' : 'csv';
    const seconds = Math.max(1, Math.round(options.durationSeconds ?? 60));
    const target = path.join(directory, `counters-${pid}-${timestamp()}.${format}`);
    const executable = await this.locateTool(COUNTERS_TOOL, dotnetPath);
    if (executable === undefined) {
      return undefined;
    }

    const args = [
      'collect',
      '-p', pid.toString(),
      '-o', target,
      '--format', format,
      '--duration', formatToolDuration(seconds),
    ];
    const counters = options.counters?.trim() ?? '';
    if (counters.length > 0) {
      args.push('--counters', counters);
    }

    this.logger.info(translate('Exporting counters: dotnet-counters collect -p {0} -o {1}', pid, target));
    const finished = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: translate('Monitor Dotnet: recording counters for {0} s…', seconds),
        cancellable: true,
      },
      (_progress, token) => new Promise<boolean>(resolve => {
        const child = execFile(executable, args, { maxBuffer: 32 * 1024 * 1024 }, error => {
          // Отмена по кнопке не ошибка: файл с записанной частью остаётся.
          if (error !== null && !token.isCancellationRequested) {
            const text = describeError(error);
            this.logger.error(translate('Tool {0} failed', COUNTERS_TOOL.command), error);
            void vscode.window.showErrorMessage(
              translate('Monitor Dotnet: {0} failed — {1}', COUNTERS_TOOL.purpose, text),
            );
            resolve(false);
            return;
          }

          resolve(true);
        });

        token.onCancellationRequested(() => child.kill('SIGINT'));
      }),
    );

    if (!finished) {
      return undefined;
    }

    this.logger.info(translate('Counters saved: {0}', target));
    const reveal = translate('Reveal in Explorer');
    const action = await vscode.window.showInformationMessage(
      translate('Counters saved: {0}', path.basename(target)),
      reveal,
    );
    if (action === reveal) {
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
    }

    return target;
  }

  /**
   * Снимает полный дамп памяти через `dotnet-dump`.
   * Дамп нужен, когда приложение зависло или падает: его можно открыть в `dotnet-dump analyze`
   * и посмотреть стеки, объекты и исключения.
   */
  async collectMemoryDump(
    pid: number,
    dotnetPath: string,
    outputDirectory: string,
    options: DumpOptions = {},
  ): Promise<void> {
    const target = path.join(await this.resolveOutputDirectory(outputDirectory), `dump-${pid}-${timestamp()}.dmp`);
    let analyzeRequested = false;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: taking a memory dump…') },
      async () => {
        // По умолчанию Heap: меньше полного дампа, но содержит стеки и управляемую память.
        const output = await this.runTool(DUMP_TOOL, dotnetPath, [
          'collect',
          '-p', pid.toString(),
          '-o', target,
          '--type', options.type ?? 'Heap',
          ...(options.crashReport === true ? ['--crashreport'] : []),
        ]);
        if (output === undefined) {
          return;
        }

        this.logger.info(translate('Memory dump saved: {0}', target));
        const analyze = translate('Analyse Memory Dump');
        const reveal = translate('Reveal in Explorer');
        const action = await vscode.window.showInformationMessage(
          translate('Memory dump saved: {0}', path.basename(target)),
          analyze,
          reveal,
        );
        if (action === analyze) {
          analyzeRequested = true;
        } else if (action === reveal) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
        }
      },
    );

    // Разбор запускается после уведомления о снятии дампа: у него свой прогресс.
    if (analyzeRequested) {
      await this.analyzeMemoryDump(dotnetPath, outputDirectory, target);
    }
  }

  /**
   * Скачивает символы к дампу через `dotnet-symbol`.
   * Без символов в дампе не видно имён функций, поэтому это обычный следующий шаг.
   */
  async downloadSymbols(dotnetPath: string, outputDirectory: string, dumpFile?: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    // Каталог уже отсортирован по времени изменения: свежие дампы первыми.
    const dumps = await listResultFiles(directory, '.dmp');
    if (dumps.length === 0 && dumpFile === undefined) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: no memory dump found in {0}. Take a memory dump first.',
        directory,
      ));
      return;
    }

    const files = dumpFile !== undefined ? [dumpFile] : dumps;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: downloading symbols…') },
      async () => {
        for (const file of files) {
          // `-o` складывает символы рядом с дампом, не засоряя каталог проекта.
          const output = await this.runTool(SYMBOL_TOOL, dotnetPath, ['--symbols', '--modules', '-o', path.dirname(file), file]);
          if (output === undefined) {
            return;
          }
        }

        this.logger.info(translate('Symbols downloaded for {0} file(s).', files.length));
        void vscode.window.showInformationMessage(
          translate('Monitor Dotnet: symbols downloaded for {0} dump(s).', files.length),
        );
      },
    );
  }

  /**
   * Переводит записанный `.nettrace` в Speedscope и открывает результат.
   * Нужно для трейсов, записанных раньше или другим инструментом: скорость
   * разбора не требует повторной записи под нагрузкой.
   */
  async convertTrace(dotnetPath: string, outputDirectory: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    const trace = await this.pickResultFile(directory, '.nettrace', translate('Select a trace to convert'));
    if (trace === undefined) {
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: converting the trace…') },
      async () => {
        // `-o` без расширения: инструмент сам добавит `.speedscope.json`.
        const output = await this.runTool(TRACE_TOOL, dotnetPath, [
          'convert', trace,
          '--format', 'Speedscope',
          '-o', traceBaseFor(trace),
        ]);
        if (output === undefined) {
          return;
        }

        const target = speedscopeFileFor(trace);
        this.logger.info(translate('Trace converted: {0}', target));
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target));
      },
    );
  }

  /**
   * Показывает самые «дорогие» методы из записанного трейса.
   * Быстрый ответ «кто занимал стек», когда открывать Speedscope незачем.
   */
  async showTraceTopMethods(dotnetPath: string, outputDirectory: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    const trace = await this.pickResultFile(directory, '.nettrace', translate('Select a trace to analyse'));
    if (trace === undefined) {
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: reading the trace…') },
      async () => {
        const output = await this.runTool(TRACE_TOOL, dotnetPath, [
          'report', trace,
          'topN',
          '-n', '20',
        ]);
        if (output === undefined) {
          return;
        }

        const document = await vscode.workspace.openTextDocument({ content: output, language: 'plaintext' });
        await vscode.window.showTextDocument(document, { preview: false });
      },
    );
  }

  /**
   * Добавляет номера строк к стеку из редактора: `dotnet-stack symbolicate`.
   *
   * Нужно, когда стек пришёл из логов или письма: в нём есть Method Token и IL Offset,
   * но нет имён файлов. Берётся выделение или весь текст редактора.
   */
  async symbolicateStack(dotnetPath: string, outputDirectory: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const selected = editor === undefined || editor.selection.isEmpty
      ? editor?.document.getText()
      : editor.document.getText(editor.selection);
    const text = selected?.trim() ?? '';
    if (text.length === 0) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: open a file with a stack trace to symbolicate it.',
      ));
      return;
    }

    const directory = await this.resolveOutputDirectory(outputDirectory);
    const source = path.join(directory, `stack-${timestamp()}.txt`);
    await writeFile(source, `${text}\n`, 'utf8');

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: translate('Monitor Dotnet: reading symbol names…') },
      async () => {
        // `-c` печатает результат в консоль, файл `.symbolicated` рядом не создаётся.
        const output = await this.runTool(CALL_STACK_TOOL, dotnetPath, ['symbolicate', source, '-c']);
        if (output === undefined) {
          return;
        }

        this.logger.info(translate('Stack trace symbolicated: {0}', source));
        const document = await vscode.workspace.openTextDocument({
          content: output.length > 0 ? output : text,
          language: 'plaintext',
        });
        await vscode.window.showTextDocument(document, { preview: false });
      },
    );
  }

  /** Выбор файла результата: если он один, спрашивать незачем. */
  private async pickResultFile(directory: string, extension: string, title: string): Promise<string | undefined> {
    const files = await listResultFiles(directory, extension);
    if (files.length === 0) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: no files with the extension {0} in {1}.',
        extension,
        directory,
      ));
      return undefined;
    }

    if (files.length === 1) {
      return files[0];
    }

    const picked = await vscode.window.showQuickPick(
      files.map(file => ({ label: path.basename(file), file })),
      { title, placeHolder: translate('Newest files first') },
    );
    return picked?.file;
  }

  /**
   * Разбирает дамп памяти командами `dotnet-dump analyze`.
   *
   * Кнопка в заголовке панели берёт самый свежий `.dmp` из каталога результатов,
   * чтобы разбор запускался в один клик. Конкретный файл можно разобрать из
   * контекстного меню проводника — тогда его путь приходит в `dumpFile`.
   * Каждый выбранный набор команд запускается отдельно: `dotnet-dump` не
   * печатает приглашения `> команда`, поэтому иначе нельзя понять, какой
   * вывод к какому набору относится. Результат открывается в графической
   * панели, а полный текстовый отчёт доступен из неё одной кнопкой.
   */
  async analyzeMemoryDump(dotnetPath: string, outputDirectory: string, dumpFile?: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    const target = dumpFile ?? (await listResultFiles(directory, '.dmp'))[0];
    if (target === undefined) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: no memory dump found in {0}. Take a memory dump first.',
        directory,
      ));
      return;
    }

    const analyses = await this.pickAnalyses();
    if (analyses === undefined) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: translate('Monitor Dotnet: analysing {0}…', path.basename(target)),
      },
      async () => {
        const commands = analyses.flatMap(analysis => analysis.commands);
        this.logger.info(translate('Dump analysis of {0}: {1}', target, commands.join('; ')));
        const outputs: string[] = [];
        for (const analysis of analyses) {
          const output = await this.runTool(DUMP_TOOL, dotnetPath, buildAnalyzeArgs(target, analysis.commands));
          if (output === undefined) {
            return;
          }
          outputs.push(output);
        }

        const generatedAt = new Date();
        const options = await this.memoryFileOptions(target);
        const report = buildDumpReport(target, analyses, outputs, generatedAt, options);
        const textReport = formatAnalysisReport(target, analyses, outputs, generatedAt, options);
        DumpAnalysisPanel.show(this.extensionUri, report, textReport, this.logger);
      },
    );
  }

  /**
   * Сравнивает два дампа одним набором команд и показывает различия.
   *
   * Дампы разбираются последовательно: два `dotnet-dump analyze` одновременно
   * нагружают диск и память сильнее, чем нужно.
   */
  async compareMemoryDumps(dotnetPath: string, outputDirectory: string, firstFile?: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    const dumps = await listDumpFiles(directory);
    if (dumps.length < 2) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: at least two dumps are needed for comparison.',
      ));
      return;
    }

    const before = firstFile !== undefined && dumps.some(dump => dump.file === firstFile)
      ? firstFile
      : await this.pickMemoryFile(dumps, translate('Select the first dump'));
    if (before === undefined) {
      return;
    }

    const after = await this.pickMemoryFile(dumps, translate('Select the second dump'), before);
    if (after === undefined) {
      return;
    }

    const analyses = await this.pickAnalyses();
    if (analyses === undefined) {
      return;
    }

    const commands = analyses.flatMap(analysis => analysis.commands);
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: translate('Monitor Dotnet: comparing dumps…'),
      },
      async progress => {
        const collect = async (file: string): Promise<string[] | undefined> => {
          const outputs: string[] = [];
          for (const analysis of analyses) {
            const output = await this.runTool(DUMP_TOOL, dotnetPath, buildAnalyzeArgs(file, analysis.commands));
            if (output === undefined) {
              return undefined;
            }
            outputs.push(output);
          }
          return outputs;
        };

        progress.report({ message: translate('Analysing {0}…', path.basename(before)) });
        const beforeOutput = await collect(before);
        if (beforeOutput === undefined) {
          return;
        }

        progress.report({ message: translate('Analysing {0}…', path.basename(after)) });
        const afterOutput = await collect(after);
        if (afterOutput === undefined) {
          return;
        }

        this.logger.info(translate('Dump comparison of {0} and {1}: {2}', before, after, commands.join('; ')));
        const generatedAt = new Date();
        const beforeAnalysis = analyzeDumpOutput(
          before,
          analyses,
          beforeOutput,
          generatedAt,
          await this.memoryFileOptions(before),
        );
        const afterAnalysis = analyzeDumpOutput(
          after,
          analyses,
          afterOutput,
          generatedAt,
          await this.memoryFileOptions(after),
        );
        const comparison = buildDumpComparison(beforeAnalysis, afterAnalysis);
        const textReport = formatComparisonReport(comparison, generatedAt);
        DumpAnalysisPanel.showComparison(this.extensionUri, comparison, textReport, this.logger);
      },
    );
  }

  /**
   * Разбирает снимок памяти `dotnet-gcdump report`.
   *
   * Снимок снимается быстро и не останавливает процесс, поэтому он первый шаг
   * при поиске утечки. Раньше файл только сохранялся и открыть его было нечем;
   * теперь те же панели, что и у дампа, строятся из отчёта инструмента.
   */
  async analyzeMemorySnapshot(dotnetPath: string, outputDirectory: string, snapshotFile?: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    const target = snapshotFile ?? (await listResultFiles(directory, '.gcdump'))[0];
    if (target === undefined) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: no memory snapshot found in {0}. Take a memory snapshot first.',
        directory,
      ));
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: translate('Monitor Dotnet: analysing {0}…', path.basename(target)),
      },
      async () => {
        this.logger.info(translate('Snapshot analysis of {0}', target));
        const output = await this.runTool(MEMORY_SNAPSHOT_TOOL, dotnetPath, ['report', target]);
        if (output === undefined) {
          return;
        }

        const generatedAt = new Date();
        const options = await this.memoryFileOptions(target);
        const analysis = analyzeGcdumpOutput(target, output, generatedAt, options);
        const textReport = formatGcdumpReport(target, output, generatedAt, options);
        DumpAnalysisPanel.show(this.extensionUri, analysis.report, textReport, this.logger);
      },
    );
  }

  /**
   * Сравнивает два снимка памяти: что выросло в куче между ними.
   * Сравнение идёт по тем же правилам, что и у дампов, — меняются только команды.
   */
  async compareMemorySnapshots(dotnetPath: string, outputDirectory: string, firstFile?: string): Promise<void> {
    const directory = await this.resolveOutputDirectory(outputDirectory);
    const snapshots = await listSnapshotFiles(directory);
    if (snapshots.length < 2) {
      void vscode.window.showWarningMessage(translate(
        'Monitor Dotnet: at least two memory snapshots are needed for comparison.',
      ));
      return;
    }

    const before = firstFile !== undefined && snapshots.some(snapshot => snapshot.file === firstFile)
      ? firstFile
      : await this.pickMemoryFile(snapshots, translate('Select the first snapshot'));
    if (before === undefined) {
      return;
    }

    const after = await this.pickMemoryFile(snapshots, translate('Select the second snapshot'), before);
    if (after === undefined) {
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: translate('Monitor Dotnet: comparing snapshots…'),
      },
      async progress => {
        const collect = async (file: string): Promise<ReturnType<typeof analyzeGcdumpOutput> | undefined> => {
          const output = await this.runTool(MEMORY_SNAPSHOT_TOOL, dotnetPath, ['report', file]);
          if (output === undefined) {
            return undefined;
          }

          const generatedAt = new Date();
          return analyzeGcdumpOutput(file, output, generatedAt, await this.memoryFileOptions(file));
        };

        progress.report({ message: translate('Analysing {0}…', path.basename(before)) });
        const beforeAnalysis = await collect(before);
        if (beforeAnalysis === undefined) {
          return;
        }

        progress.report({ message: translate('Analysing {0}…', path.basename(after)) });
        const afterAnalysis = await collect(after);
        if (afterAnalysis === undefined) {
          return;
        }

        this.logger.info(translate('Snapshot comparison of {0} and {1}', before, after));
        const generatedAt = new Date();
        const comparison = buildDumpComparison(beforeAnalysis, afterAnalysis);
        const textReport = formatComparisonReport(comparison, generatedAt);
        DumpAnalysisPanel.showComparison(this.extensionUri, comparison, textReport, this.logger);
      },
    );
  }

  /** Дампы и снимки памяти в каталоге результатов: для панели «Дампы». */
  async listDumps(outputDirectory: string): Promise<DumpFileInfo[]> {
    // Каталог не создаём: панель открывается при активации и не должна оставлять следов.
    const directory = outputDirectory.length === 0
      ? defaultOutputDirectory(currentWorkspaceFolder())
      : path.resolve(outputDirectory);
    return listMemoryFiles(directory);
  }

  /** Время и размер файла дампа для заголовка отчёта. */
  private async memoryFileOptions(file: string): Promise<{ takenAt?: Date; dumpBytes?: number }> {
    // Время снятия дампа берём у файла: внутри дампа удобной метки нет.
    const info = await stat(file).catch(() => undefined);
    return { takenAt: info?.mtime, dumpBytes: info?.size };
  }

  /** Выбор дампа для сравнения: свежие первыми. */
  private async pickMemoryFile(
    dumps: readonly DumpFileInfo[],
    title: string,
    exclude?: string,
  ): Promise<string | undefined> {
    const items = dumps
      .filter(dump => dump.file !== exclude)
      .map(dump => ({
        label: path.basename(dump.file),
        description: `${formatBytes(dump.bytes)} · ${new Date(dump.modifiedMs).toLocaleString(
          localeTag(),
          { dateStyle: 'short', timeStyle: 'short' },
        )}`,
        file: dump.file,
      }));

    if (items.length === 0) {
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: translate('Newest dumps first'),
    });
    return picked?.file;
  }

  /**
   * Выбор наборов анализа. Можно взять несколько: например, стек потоков
   * и статистику кучи из одного и того же дампа. Последний пункт — свои команды:
   * остальные наборы покрывают типовые вопросы, но SOS умеет больше.
   */
  private async pickAnalyses(): Promise<SosAnalysis[] | undefined> {
    interface AnalysisItem extends vscode.QuickPickItem {
      analysis?: SosAnalysis;
      /** Пункт «свои команды»: вместо набора открывает поле ввода. */
      custom?: boolean;
    }

    const items: AnalysisItem[] = SOS_ANALYSES.map(analysis => {
      const text = analysisText(analysis.id);
      return {
        label: text?.title ?? analysis.id,
        description: text?.description ?? '',
        picked: DEFAULT_ANALYSIS_IDS.includes(analysis.id),
        analysis,
      };
    });

    items.push({
      label: `$(edit) ${translate('Custom SOS commands…')}`,
      description: translate('Any SOS commands, one per line'),
      picked: false,
      custom: true,
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: translate('What to include in the report'),
      placeHolder: translate('Pick one or more items'),
      canPickMany: true,
    });
    if (picked === undefined) {
      return undefined;
    }

    const analyses = picked
      .map(item => item.analysis)
      .filter((analysis): analysis is SosAnalysis => analysis !== undefined);

    if (picked.some(item => item.custom === true)) {
      const input = await vscode.window.showInputBox({
        title: translate('Custom SOS commands'),
        prompt: translate('One command per line, for example dumpheap -stat'),
        placeHolder: 'clrstack -all',
      });

      const commands = input === undefined ? [] : commandsFromInput(input);
      if (commands.length > 0) {
        analyses.push({ id: 'custom', commands });
      }
    }

    if (analyses.length === 0) {
      void vscode.window.showWarningMessage(translate('Monitor Dotnet: nothing was selected for analysis.'));
      return undefined;
    }

    return analyses;
  }

  /**
   * Запускает запись профиля производительности.
   * Запись идёт до команды остановки — процесс `dotnet-trace` остаётся запущенным.
   * Если задана длительность, инструмент останавливается сам: это удобно для
   * воспроизводимого замера, который не зависит от реакции пользователя.
   */
  async startProfiling(
    pid: number,
    dotnetPath: string,
    outputDirectory: string,
    options: ProfilingOptions = {},
  ): Promise<string | undefined> {
    if (this.traceProcess !== undefined) {
      void vscode.window.showWarningMessage(translate('Monitor Dotnet: profiling is already running.'));
      return undefined;
    }

    const target = path.join(await this.resolveOutputDirectory(outputDirectory), `trace-${pid}-${timestamp()}.nettrace`);
    const available = await this.runTool(TRACE_TOOL, dotnetPath, ['--version']);
    if (available === undefined) {
      return undefined;
    }

    const executable = await this.locateTool(TRACE_TOOL, dotnetPath);
    if (executable === undefined) {
      return undefined;
    }

    const durationSeconds = options.durationSeconds ?? 0;
    const args = [
      'collect',
      '-p', pid.toString(),
      '-o', target,
      // Формат speedscope открывается в браузере и в VS Code без дополнительных инструментов.
      '--format', 'Speedscope',
    ];

    // `--profile default` не существует: набор по умолчанию — это отсутствие параметра.
    if (options.profile !== undefined && options.profile.length > 0 && options.profile !== 'default') {
      args.push('--profile', options.profile);
    }

    if (durationSeconds > 0) {
      args.push('--duration', formatToolDuration(durationSeconds));
    }

    this.logger.info(translate('Starting profiling: dotnet-trace collect -p {0} -o {1}', pid, target));
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    this.traceProcess = child;
    this.profilingChanged.fire(true);
    child.stdout?.on('data', data => this.logger.raw(String(data).trimEnd()));
    child.stderr?.on('data', data => this.logger.raw(String(data).trimEnd()));
    child.on('exit', code => {
      this.traceProcess = undefined;
      this.profilingChanged.fire(false);
      // `--format Speedscope` кладёт рядом готовый для speedscope.app файл.
      const speedscope = speedscopeFileFor(target);
      this.logger.info(translate(
        'Profiling finished (code {0}). Trace: {1}. Speedscope: {2}',
        code ?? 'n/a',
        target,
        speedscope,
      ));

      const open = translate('Open Speedscope profile');
      const reveal = translate('Reveal in Explorer');
      void vscode.window.showInformationMessage(
        translate('Profile saved: {0}', path.basename(target)),
        open,
        reveal,
      ).then(async action => {
        if (action === open) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(speedscope));
        } else if (action === reveal) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(target));
        }
      });
    });

    return target;
  }

  /** Останавливает запись профиля. */
  async stopProfiling(): Promise<void> {
    const child = this.traceProcess;
    if (child === undefined) {
      return;
    }

    this.logger.info(translate('Stopping profiling…'));
    child.kill('SIGINT');

    // Даём инструменту время записать файл, затем завершаем принудительно.
    const finished = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const timer = new Promise<void>(resolve => setTimeout(resolve, 5000));
    await Promise.race([finished, timer]);

    if (this.traceProcess !== undefined) {
      this.traceProcess.kill('SIGKILL');
    }
  }

  /**
   * Запускает внешний инструмент и возвращает его вывод.
   * Если инструмент не установлен, предлагает установить его одной командой.
   */
  private async runTool(
    tool: DotnetTool,
    dotnetPath: string,
    args: readonly string[],
  ): Promise<string | undefined> {
    const executable = await this.locateTool(tool, dotnetPath);
    if (executable === undefined) {
      return undefined;
    }

    try {
      // Глобальные инструменты — отдельные исполняемые файлы, а не подкоманды `dotnet`.
      const { stdout, stderr } = await execFileAsync(executable, args, { maxBuffer: 32 * 1024 * 1024 });
      const output = [stdout, stderr].filter(part => part.trim().length > 0).join('\n');
      if (output.trim().length === 0) {
        this.logger.warn(translate('Tool {0} returned no output', tool.command));
      }
      return output;
    } catch (error) {
      const text = describeError(error);
      this.logger.error(translate('Tool {0} failed', tool.command), error);
      void vscode.window.showErrorMessage(translate('Monitor Dotnet: {0} failed — {1}', tool.purpose, text));
      return undefined;
    }
  }

  /**
   * Ищет исполняемый файл инструмента и предлагает установку, если его нет.
   * Путь ищется в PATH и в каталоге глобальных инструментов: расширение VS Code
   * не наследует PATH терминала, поэтому полагаться только на него нельзя.
   */
  private async locateTool(tool: DotnetTool, dotnetPath: string): Promise<string | undefined> {
    const executable = resolveToolPath(tool);
    if (executable !== undefined) {
      this.logger.info(translate('Tool {0} found: {1}', tool.command, executable));
      return executable;
    }

    this.logger.warn(translate(
      'Tool {0} was not found in PATH or in the dotnet tools directory.',
      tool.command,
    ));
    await this.suggestInstall(tool, dotnetPath);
    return undefined;
  }

  /** Предлагает установить отсутствующий инструмент. */
  private async suggestInstall(tool: DotnetTool, dotnetPath: string): Promise<void> {
    const install = translate('Install');
    const learnMore = translate('Learn more');
    const action = await vscode.window.showWarningMessage(
      translate('Monitor Dotnet: tool {0} is not installed (needed for {1}).', tool.command, tool.purpose),
      install,
      learnMore,
    );

    if (action === install) {
      const terminal = vscode.window.createTerminal(translate('Monitor Dotnet: installing {0}', tool.command));
      terminal.show();
      // Кавычки нужны, если путь к dotnet содержит пробелы.
      terminal.sendText(`"${dotnetPath}" tool install --global ${tool.packageName}`);
    } else if (action === learnMore) {
      await vscode.env.openExternal(vscode.Uri.parse('https://learn.microsoft.com/dotnet/core/diagnostics/'));
    }
  }

  /** Каталог для файлов дампа и профилей: по умолчанию `.monitor-dotnet` в папке проекта. */
  private async resolveOutputDirectory(configured: string): Promise<string> {
    const directory = await prepareOutputDirectory(configured, currentWorkspaceFolder());
    this.logger.info(translate('Profiling output directory: {0}', directory));
    return directory;
  }
}

/** Папка проекта: в неё по умолчанию складываются результаты. */
function currentWorkspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Метка времени для имени файла: 2026-10-14-08-30-00. */
function timestamp(): string {
  const now = new Date();
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('-');
}
