/** Проверки разбора дампа памяти SOS-командами `dotnet-dump analyze`. */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analysisText,
  analyzeDumpOutput,
  buildAnalyzeArgs,
  buildDumpComparison,
  buildDumpReport,
  buildFindings,
  commandsFromInput,
  compareHeapTypes,
  DEFAULT_ANALYSIS_IDS,
  extractCommandOutput,
  findAnalysis,
  formatAnalysisReport,
  formatComparisonReport,
  formatTimestamp,
  normalizeSosCommand,
  parseAsyncStatistics,
  parseExceptionInfo,
  parseFinalizableReady,
  parseFinalizableSummary,
  parseFinalizableTypes,
  parseGcHeapSummary,
  parseGcSegments,
  parseHeapStatistics,
  parseHeapTypeMap,
  parseSyncBlockCount,
  parseSyncBlocks,
  parseThreadCount,
  parseThreadPoolSummary,
  parseThreadRows,
  parseThreadStacks,
  parseThreadSummary,
  SOS_ANALYSES,
  splitSessionOutput,
  type SosAnalysis,
} from './dumpAnalysis.ts';

const DUMPHEAP_OUTPUT = [
  'Statistics:',
  '              MT    Count    TotalSize Class Name',
  '00007f8b1c2d3e40      100      4000000 System.String',
  '00007f8b1c2d3e50       50      8000000 System.Byte[]',
  '00007f8b1c2d3e60        5         1000 System.Object',
  '00007f8b1c2d3e70      200      1000000 System.String',
  '00007f8b1c2d3e80    10000       120000 Free',
  'Total 10355 objects, fragmented blocks 12, are 120000 bytes, Fragmentation 1%.',
].join('\n');

test('аргументы dotnet-dump заканчиваются командой exit', () => {
  assert.deepEqual(
    buildAnalyzeArgs('/dumps/app.dmp', ['dumpheap -stat', 'clrstack -all']),
    ['analyze', '/dumps/app.dmp', '-c', 'dumpheap -stat', '-c', 'clrstack -all', '-c', 'exit'],
  );
  // Без дополнительных команд всё равно нужен exit, иначе сессия ждёт ввода.
  assert.deepEqual(buildAnalyzeArgs('app.dmp', []), ['analyze', 'app.dmp', '-c', 'exit']);
});

test('многострочный ввод превращается в отдельные команды', () => {
  assert.deepEqual(
    commandsFromInput('  > dumpheap -stat\n\n syncblk  \n'),
    ['dumpheap -stat', 'syncblk'],
  );
  assert.deepEqual(buildAnalyzeArgs('app.dmp', ['threadpool\nclrthreads']), [
    'analyze',
    'app.dmp',
    '-c',
    'threadpool',
    '-c',
    'clrthreads',
    '-c',
    'exit',
  ]);
});

test('пустая команда отбрасывается', () => {
  assert.equal(normalizeSosCommand('   '), undefined);
  assert.equal(normalizeSosCommand('>'), undefined);
  assert.equal(normalizeSosCommand(' > dumpheap -stat '), 'dumpheap -stat');
});

test('наборы анализа уникальны и содержат хотя бы одну команду', () => {
  assert.equal(new Set(SOS_ANALYSES.map(analysis => analysis.id)).size, SOS_ANALYSES.length);
  for (const analysis of SOS_ANALYSES) {
    assert.ok(analysis.commands.length > 0, `набор ${analysis.id} пуст`);
    assert.ok(analysis.commands.every(command => normalizeSosCommand(command) !== undefined));

    // У каждого набора есть название и подсказка для списка выбора.
    const text = analysisText(analysis.id);
    assert.ok((text?.title.length ?? 0) > 0, `у набора ${analysis.id} нет названия`);
    assert.ok((text?.description.length ?? 0) > 0, `у набора ${analysis.id} нет подсказки`);
  }

  for (const id of DEFAULT_ANALYSIS_IDS) {
    assert.notEqual(findAnalysis(id), undefined, `набор ${id} по умолчанию не найден`);
  }

  assert.equal(analysisText('unknown'), undefined);
});

test('сводка кучи строится по строкам dumpheap -stat', () => {
  const summary = parseHeapStatistics(DUMPHEAP_OUTPUT);
  assert.notEqual(summary, undefined);
  assert.equal(summary?.totalCount, 355);
  assert.equal(summary?.totalSize, 13_001_000);
  // Крупнейший тип идёт первым, повторяющиеся типы складываются, Free пропускается.
  assert.deepEqual(summary?.entries.map(entry => entry.typeName), ['System.Byte[]', 'System.String', 'System.Object']);
  const strings = summary?.entries.find(entry => entry.typeName === 'System.String');
  assert.equal(strings?.count, 300);
  assert.equal(strings?.size, 5_000_000);
});

test('вывод без dumpheap -stat не даёт сводку', () => {
  assert.equal(parseHeapStatistics('Ready to process analysis commands.'), undefined);
  assert.equal(parseHeapStatistics(''), undefined);
});

test('раздел команды отделяется по приглашению `>`', () => {
  const session = '> clrthreads\nThread 1\n> dumpheap -stat\nStats line\n> syncblk\nBlocks';
  assert.equal(extractCommandOutput(session, /^>\s*dumpheap\b/i), 'Stats line');
  assert.equal(extractCommandOutput('без приглашений', /^>\s*dumpheap\b/i), undefined);
});

test('сводка кучи берётся только из раздела dumpheap -stat', () => {
  const session = [
    '> clrthreads',
    'Thread 1',
    '> dumpheap -stat',
    DUMPHEAP_OUTPUT,
    '> syncblk',
    '00007ff8a1b2c3d4      9      999 System.Fake',
  ].join('\n');
  const analysis: SosAnalysis = { id: 'overview', commands: ['clrthreads', 'dumpheap -stat', 'syncblk'] };
  const report = formatAnalysisReport('app.dmp', [analysis], session, new Date(2026, 0, 1));
  const summary = report.slice(0, report.indexOf('Output:'));

  assert.match(summary, /Managed heap summary/);
  assert.match(summary, /System\.Byte\[\]/);
  // Строка из вывода syncblk не должна попасть в сводку.
  assert.doesNotMatch(summary, /System\.Fake/);
});

test('отчёт содержит дамп, команды и сводку кучи', () => {
  const analysis: SosAnalysis = {
    id: 'memory',
    commands: ['dumpheap -stat'],
  };
  const report = formatAnalysisReport(
    '/dumps/app.dmp',
    [analysis, findAnalysis('locks') as SosAnalysis],
    DUMPHEAP_OUTPUT,
    new Date(2026, 10, 7, 9, 5, 3),
    { takenAt: new Date(2026, 10, 7, 8, 59, 0), dumpBytes: 123_456 },
  );

  assert.match(report, /Memory dump analysis/);
  assert.match(report, /Dump: \/dumps\/app\.dmp/);
  assert.match(report, /Dump taken: 2026-11-07 08:59:00/);
  assert.match(report, /Report created: 2026-11-07 09:05:03/);
  assert.match(report, /dumpheap -stat/);
  assert.match(report, /syncblk/);
  assert.match(report, /Managed heap summary/);
  assert.match(report, /System\.Byte\[\]/);
  assert.match(report, /Total: 355 objects/);
  assert.match(report, /Output:/);
});

test('без dumpheap -stat отчёт показывает только вывод инструмента', () => {
  const analysis: SosAnalysis = {
    id: 'threads',
    commands: ['clrstack -all'],
  };
  const report = formatAnalysisReport('app.dmp', [analysis], '   ', new Date(2026, 0, 2, 3, 4, 5));

  assert.doesNotMatch(report, /Managed heap summary/);
  assert.match(report, /\(no output\)/);
  assert.equal(formatTimestamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
});

test('вывод сессии делится на разделы по приглашениям', () => {
  assert.deepEqual(
    splitSessionOutput('> clrthreads\nThreadCount: 2\n> dumpheap -stat\nStats\n'),
    [
      { command: 'clrthreads', output: 'ThreadCount: 2' },
      { command: 'dumpheap -stat', output: 'Stats' },
    ],
  );
  // Другая версия инструмента может не печатать приглашения.
  assert.deepEqual(splitSessionOutput('без приглашений'), []);
});

test('счётчики разбираются из вывода SOS-команд', () => {
  assert.equal(parseThreadCount('ThreadCount:      12\nUnstartedThread:  0'), 12);
  assert.equal(parseThreadCount('ничего'), undefined);
  assert.deepEqual(
    parseThreadSummary([
      'ThreadCount:      12',
      'UnstartedThread:  1',
      'BackgroundThread: 10',
      'PendingThread:    0',
      'DeadThread:       2',
    ].join('\n')),
    { total: 12, background: 10, unstarted: 1, pending: 0, dead: 2 },
  );

  assert.deepEqual(
    parseThreadPoolSummary([
      'CPU utilization: 37%',
      'Workers Total: 8',
      'Workers Running: 6',
      'Workers Idle: 2',
      'Worker Max Limit: 32767',
      'Work Request in Queue: 1,234',
    ].join('\n')),
    { cpuUtilization: 37, workersTotal: 8, workersRunning: 6, workersIdle: 2, workerMaxLimit: 32767, workItems: 1234 },
  );
  assert.equal(parseThreadPoolSummary('ничего'), undefined);

  const asyncStats = parseAsyncStatistics([
    'MT               Count    Type',
    '00007ffbcfbe0970 1,234    (1) MyApp.SomeStateMachine',
    '00007ffbcfbe0980 12       MyApp.Other',
  ].join('\n'));
  assert.equal(asyncStats?.total, 1246);
  assert.deepEqual(asyncStats?.entries.map(entry => entry.typeName), [
    '(1) MyApp.SomeStateMachine',
    'MyApp.Other',
  ]);

  assert.deepEqual(
    parseFinalizableSummary([
      'generation 0 has 3 finalizable objects (1)',
      'generation 1 has 2 finalizable objects (2)',
      'generation 2 has 0 finalizable objects (3)',
    ].join('\n')),
    { total: 5, byGeneration: [3, 2, 0] },
  );
  // Реальный формат dotnet-dump 10: слово «finalizable» в строке не печатается.
  assert.deepEqual(
    parseFinalizableSummary([
      'generation 0 has 62 objects (5627f226caa0->5627f226cc90)',
      'generation 1 has 0 objects (5627f226caa0->5627f226caa0)',
    ].join('\n')),
    { total: 62, byGeneration: [62, 0] },
  );
  assert.equal(parseFinalizableSummary('ничего'), undefined);

  assert.deepEqual(
    parseGcHeapSummary([
      'GC Allocated Heap Size:    Size: 0x1201c (73756) bytes.',
      'GC Committed Heap Size:    Size: 0x20000 (131072) bytes.',
    ].join('\n')),
    { allocated: 73756, committed: 131072 },
  );
  assert.equal(parseGcHeapSummary('ничего'), undefined);

  assert.equal(parseSyncBlockCount('-----------------------------\nTotal           264\nFree            0'), 264);
  assert.equal(parseSyncBlockCount('Total 4 objects'), undefined);
});

test('асинхронные операции собираются в сводку dumpasync --stats', () => {
  assert.deepEqual(SOS_ANALYSES.find(analysis => analysis.id === 'async')?.commands, [
    'dumpasync --stats',
    'threadpool',
  ]);
});

test('отчёт для панели собирает данные из разделов сессии', () => {
  const session = [
    '> clrthreads',
    'ThreadCount:      7',
    'BackgroundThread: 6',
    '> eeheap -gc',
    'GC Allocated Heap Size:    Size: 0x1201c (14001000) bytes.',
    'GC Committed Heap Size:    Size: 0x20000 (20000000) bytes.',
    '> dumpheap -stat',
    DUMPHEAP_OUTPUT,
    '> dumpasync --stats',
    'MT               Count    Type',
    '00007ffbcfbe0970 1,234    (1) MyApp.SomeStateMachine',
    '> threadpool',
    'CPU utilization: 12%',
    'Workers Total: 8',
    'Workers Running: 6',
    'Workers Idle: 2',
    '> finalizequeue',
    'generation 0 has 3 finalizable objects (1)',
    'generation 1 has 2 finalizable objects (2)',
    '> dumpheap -stat -type Exception',
    'Statistics:',
    '              MT    Count    TotalSize Class Name',
    '00007f8b1c2d3e90       4       1024 System.Exception',
    '> syncblk',
    'SyncBlock Table',
    '-----------------------------',
    'Total           12',
  ].join('\n');

  const analyses: SosAnalysis[] = [
    { id: 'overview', commands: ['clrthreads', 'eeheap -gc', 'dumpheap -stat', 'syncblk'] },
    { id: 'async', commands: ['dumpasync --stats', 'threadpool'] },
    { id: 'finalizers', commands: ['finalizequeue'] },
    { id: 'exceptions', commands: ['dumpheap -stat -type Exception'] },
  ];

  const report = buildDumpReport(
    '/dumps/app.dmp',
    analyses,
    session,
    new Date(2026, 10, 7, 9, 5, 3),
    { takenAt: new Date(2026, 10, 7, 8, 59, 0), dumpBytes: 987_654 },
  );
  assert.equal(report.heap?.totalCount, 355);
  assert.equal(report.heap?.totalSize, 13_001_000);
  assert.equal(report.typeCount, 3);
  assert.equal(report.threads?.total, 7);
  assert.equal(report.threads?.background, 6);
  assert.equal(report.async?.total, 1234);
  assert.equal(report.threadPool?.workersRunning, 6);
  assert.equal(report.gcHeap?.allocated, 14_001_000);
  assert.equal(report.gcHeap?.committed, 20_000_000);
  assert.equal(report.syncBlockCount, 12);
  assert.equal(report.finalizable?.total, 5);
  assert.equal(report.exceptions?.totalCount, 4);
  assert.equal(report.sections[0].title, 'Overview');
  assert.match(report.sections[0].output, /ThreadCount/);
  assert.equal(report.sections[1].title, 'Async and thread pool');
  assert.match(report.sections[1].output, /SomeStateMachine/);
  assert.equal(report.generatedAt, '2026-11-07 09:05:03');
  assert.equal(report.takenAt, '2026-11-07 08:59:00');
  assert.equal(report.dumpBytes, 987_654);
  // В куче преобладают байтовые массивы, а асинхронных машин больше тысячи.
  assert.ok(report.findings.some(finding => finding.title === 'Large byte arrays'));
  assert.ok(report.findings.some(finding => finding.title === 'Many pending async state machines'));
});

test('наблюдения срабатывают на подозрительных данных', () => {
  const findings = buildFindings({
    heap: {
      totalCount: 1000,
      totalSize: 1000,
      entries: [
        { typeName: 'System.Byte[]', count: 10, size: 600 },
        { typeName: 'System.String', count: 10, size: 300 },
      ],
    },
    threads: { total: 150 },
    threadPool: { workItems: 500 },
    async: { total: 2000, entries: [] },
    exceptions: { totalCount: 2000, totalSize: 10, entries: [] },
    syncBlockCount: 200,
    finalizable: { total: 3000, byGeneration: [3000] },
  });

  const titles = findings.map(finding => finding.title);
  assert.ok(titles.includes('One type dominates the heap'));
  assert.ok(titles.includes('Large byte arrays'));
  assert.ok(titles.includes('Many managed threads'));
  assert.ok(titles.includes('Thread pool queue is growing'));
  assert.ok(titles.includes('Many pending async state machines'));
  assert.ok(titles.includes('Many exception objects'));
  assert.ok(titles.includes('Lock contention'));
  assert.ok(titles.includes('Large finalization queue'));
  assert.equal(findings.find(finding => finding.title === 'Large byte arrays')?.level, 'warning');
});

test('без приглашений данные разбираются из всего вывода', () => {
  const report = buildDumpReport(
    'app.dmp',
    [{ id: 'memory', commands: ['dumpheap -stat'] }],
    DUMPHEAP_OUTPUT,
    new Date(2026, 0, 1),
  );

  assert.equal(report.heap?.totalCount, 355);
  assert.equal(report.sections[0].output, DUMPHEAP_OUTPUT);
});

test('каждый набор получает собственный вывод без приглашений', () => {
  const threadsOutput = [
    'ThreadCount:      7',
    'BackgroundThread: 6',
  ].join('\n');
  const report = buildDumpReport(
    'app.dmp',
    [
      { id: 'memory', commands: ['dumpheap -stat'] },
      { id: 'threads', commands: ['clrthreads'] },
    ],
    [DUMPHEAP_OUTPUT, threadsOutput],
    new Date(2026, 0, 1),
  );

  assert.deepEqual(report.sections.map(section => section.id), ['memory', 'threads']);
  assert.equal(report.sections[0].output, DUMPHEAP_OUTPUT);
  assert.equal(report.sections[1].output, threadsOutput);
  assert.equal(report.heap?.totalCount, 355);
  assert.equal(report.threads?.total, 7);

  const text = formatAnalysisReport(
    'app.dmp',
    [
      { id: 'memory', commands: ['dumpheap -stat'] },
      { id: 'threads', commands: ['clrthreads'] },
    ],
    [DUMPHEAP_OUTPUT, threadsOutput],
    new Date(2026, 0, 1),
  );
  assert.match(text, /=== .*\(dumpheap -stat\) ===/);
  assert.match(text, /=== .*\(clrthreads\) ===/);
});

test('фильтр по типам не подменяет общую статистику кучи', () => {
  const exceptionsOutput = [
    'Statistics:',
    '              MT    Count    TotalSize Class Name',
    '00007f8b1c2d3e60        5         1000 System.Exception',
  ].join('\n');
  const report = buildDumpReport(
    'app.dmp',
    [{ id: 'exceptions', commands: ['pe -nested', 'dumpheap -stat -type Exception'] }],
    [exceptionsOutput],
    new Date(2026, 0, 1),
  );

  assert.equal(report.heap, undefined);
  assert.equal(report.exceptions?.totalCount, 5);
  assert.equal(report.sections[0].output, exceptionsOutput);
});

test('пустой вывод инструмента виден в отчёте', () => {
  const report = buildDumpReport(
    'app.dmp',
    [{ id: 'memory', commands: ['dumpheap -stat'] }],
    ['', '   '],
    new Date(2026, 0, 1),
  );

  assert.ok(report.sections.every(section => section.output.length === 0));
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].title, 'The analysis produced no output');
});

const CLRTHREADS_OUTPUT = [
  'ThreadCount:      9',
  'UnstartedThread:  0',
  'BackgroundThread: 8',
  'PendingThread:    0',
  'DeadThread:       0',
  'Hosted Runtime:   no',
  ' DBG   ID     OSID ThreadOBJ           State GC Mode     GC Alloc Context                  Domain           Count Apt Exception',
  '   0    1    30eb4 000055C102A425C0  2020020 Preemptive  0000000000000000:0000000000000000 000055C102A199F0 -00001 Ukn ',
  '   5    2    30eb9 000055C102A44C40    21220 Preemptive  00007EF079800298:00007EF0798019E0 000055C102A199F0 -00001 Ukn (Finalizer) ',
].join('\n');

const CLRSTACK_OUTPUT = [
  'OS Thread Id: 0x30eb4',
  '        Child SP               IP Call Site',
  '00007FFFF6A1E680 00007EFFFC29903E System.Threading.Monitor.Wait(System.Object, Int32) [/_/src/runtime/System.Threading/Monitor.CoreCLR.cs @ 312]',
  '00007FFFF6A1E8B0 00007EFFFD0818BC Program.<Main>(System.String[])',
  'OS Thread Id: 0x30eb9',
  '        Child SP               IP Call Site',
  '00007EFFF9F41D00 00007f007b8a6efe [DebuggerU2MCatchHandlerFrame: 00007efff9f41d00] ',
].join('\n');

const EEHEAP_OUTPUT = [
  'Number of GC Heaps: 1',
  'Small object heap',
  'generation 0:',
  '    7ef0587526a0     7ef079800028     7ef079818de0     7ef079821000 0x18db8 (101816)     0x21000 (135168)',
  'generation 2:',
  '    7ef058752dd8     7ef07c400028     7ef07c400028     7ef07c401000                      0x1000 (4096)',
  'Large object heap',
  '    7ef058752898     7ef07a400028     7ef07c3e37f0     7ef07c3e4000 0x1fe37c8 (33437640) 0x1fe4000 (33439744)',
  'GC Allocated Heap Size:    Size: 0x3d0e800 (64022528) bytes.',
].join('\n');

const SYNCBLK_OUTPUT = [
  'Index         SyncBlock MonitorHeld Recursion Owning Thread Info          SyncBlock Owner',
  '   41 000000000143D038          603         1 00007F2B542D28C0 1dc1d  20   00007f2e90080fb8 System.Object',
  '-----------------------------',
  'Total           1',
  'Free            0',
].join('\n');

const PE_OUTPUT = [
  'Exception object: 00007fb18c038590',
  'Exception type:   System.Reflection.TargetInvocationException',
  'Message:          Exception has been thrown by the target of an invocation.',
  'InnerException:   System.Exception, Use !PrintException 00007FB18C038368 to see more.',
  'StackTrace (generated):',
  '    SP               IP               Function',
  '    00007FF6A1E698   00007F007B8A6EFE App.Program.Main(System.String[]) [C:\\src\\Program.cs @ 12]',
  '    00007FF6A1E700   00007F007B8A6F00 System.RuntimeMethodHandle.InvokeMethod(System.Object, System.Object[], System.Signature, Boolean, Boolean)',
  'HResult: 80131604',
].join('\n');

const FINALIZEQUEUE_OUTPUT = [
  'Heap 0',
  'generation 0 has 62 objects (5627f226caa0->5627f226cc90)',
  'generation 1 has 0 objects (5627f226caa0->5627f226caa0)',
  'generation 2 has 0 objects (5627f226caa0->5627f226caa0)',
  'Ready for finalization 0 objects (5627f226cca8->5627f226cca8)',
  '------------------------------',
  'Statistics for all finalizable objects (including all objects ready for finalization):',
  '         Address               MT           Size',
  '    7f674e0094b8     7f76cfd2ebe8            184 ',
  '    7f674e009728     7f76cfd300f0             64 ',
  '    7f674e009790     7f76cfd300f0             64 ',
].join('\n');

test('потоки разбираются в таблицу clrthreads', () => {
  const rows = parseThreadRows(CLRTHREADS_OUTPUT);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    debugId: 0,
    id: 1,
    osId: '0x30eb4',
    state: '2020020',
    gcMode: 'Preemptive',
    lockCount: -1,
  });
  assert.equal(rows[1].kind, '(Finalizer)');
});

test('стеки потоков разбираются из clrstack -all', () => {
  const threads = parseThreadStacks(CLRSTACK_OUTPUT);
  assert.equal(threads.length, 2);
  assert.equal(threads[0].osId, '0x30eb4');
  assert.equal(threads[0].frames.length, 2);
  assert.equal(threads[0].frames[0].method, 'System.Threading.Monitor.Wait(System.Object, Int32)');
  assert.equal(threads[0].frames[0].system, true);
  assert.match(threads[0].frames[0].location ?? '', /Monitor\.CoreCLR\.cs @ 312/);
  assert.equal(threads[0].frames[1].method, 'Program.<Main>(System.String[])');
  assert.equal(threads[0].frames[1].system, false);
  assert.equal(threads[1].frames[0].system, true);
  assert.match(threads[1].frames[0].method, /^\[DebuggerU2MCatchHandlerFrame/);
});

test('syncblk отдаёт занятые блоки и итоги', () => {
  const parsed = parseSyncBlocks(SYNCBLK_OUTPUT);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0], {
    index: 41,
    monitorHeld: 603,
    recursion: 1,
    osId: '0x1dc1d',
    typeName: 'System.Object',
  });
  assert.deepEqual(parsed.totals, { total: 1, free: 0 });
  assert.deepEqual(parseSyncBlocks('Total           1\nFree            0').rows, []);
});

test('сегменты кучи разбираются из eeheap -gc', () => {
  const parsed = parseGcSegments(EEHEAP_OUTPUT);
  assert.equal(parsed.heapCount, 1);
  assert.deepEqual(parsed.segments.map(segment => segment.label), [
    'Gen 0',
    'Gen 2',
    'Large object heap',
  ]);
  assert.deepEqual(parsed.segments[0], { label: 'Gen 0', allocated: 101816, committed: 135168 });
  // У поколения 2 занятая часть отсутствует: остаётся только committed.
  assert.deepEqual(parsed.segments[1], { label: 'Gen 2', allocated: 0, committed: 4096 });
  assert.equal(parsed.segments[2].allocated, 33437640);
});

test('исключение и его стек разбираются из pe', () => {
  const entries = parseExceptionInfo(PE_OUTPUT);
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.typeName, 'System.Reflection.TargetInvocationException');
  assert.match(entry.message ?? '', /target of an invocation/);
  assert.match(entry.inner ?? '', /System\.Exception/);
  assert.equal(entry.hresult, '80131604');
  assert.equal(entry.frames.length, 2);
  assert.equal(entry.frames[0].system, false);
  assert.equal(entry.frames[1].system, true);
  assert.deepEqual(parseExceptionInfo('There is no current managed exception on this thread'), []);
});

test('очередь финализации разбирается по поколениям и таблицам методов', () => {
  assert.equal(parseFinalizableReady(FINALIZEQUEUE_OUTPUT), 0);
  const types = parseFinalizableTypes(FINALIZEQUEUE_OUTPUT);
  assert.deepEqual(types, [
    { methodTable: '7f76cfd2ebe8', count: 1, size: 184 },
    { methodTable: '7f76cfd300f0', count: 2, size: 128 },
  ]);

  // Если в том же запуске был dumpheap -stat, MT превращается в имя типа.
  const names = parseHeapTypeMap(DUMPHEAP_OUTPUT);
  assert.equal(names.size, 4);
  assert.equal(names.get('00007f8b1c2d3e40'), 'System.String');
  assert.equal(names.get('00007f8b1c2d3e50'), 'System.Byte[]');
  const named = parseFinalizableTypes(FINALIZEQUEUE_OUTPUT, new Map([['7f76cfd300f0', 'System.Gen2GcCallback']]));
  assert.equal(named[1].typeName, 'System.Gen2GcCallback');

  assert.deepEqual(parseFinalizableSummary(FINALIZEQUEUE_OUTPUT), {
    total: 62,
    byGeneration: [62, 0, 0],
  });
});

test('панели строятся по командам без дублей', () => {
  const overviewOutput = [CLRTHREADS_OUTPUT, EEHEAP_OUTPUT, DUMPHEAP_OUTPUT, SYNCBLK_OUTPUT].join('\n');
  const report = buildDumpReport(
    'app.dmp',
    [{ id: 'overview', commands: ['clrthreads', 'eeheap -gc', 'dumpheap -stat', 'syncblk'] }],
    [overviewOutput],
    new Date(2026, 0, 1),
  );

  const views = report.views ?? [];
  assert.deepEqual(views.map(view => view.title), [
    'Threads',
    'GC heap segments',
    'Heap by type',
    'Sync blocks',
  ]);
  assert.deepEqual(views.map(view => view.blocks.map(block => block.kind)), [
    ['table'],
    ['metrics', 'bar', 'table'],
    ['heapTypes'],
    ['metrics', 'table'],
  ]);

  const threads = views[0].blocks[0];
  assert.equal(threads.kind, 'table');
  if (threads.kind === 'table') {
    assert.equal(threads.rows.length, 2);
    assert.equal(threads.columns[1].label, 'OS thread');
  }

  const stacksReport = buildDumpReport(
    'app.dmp',
    [{ id: 'threads', commands: ['clrstack -all'] }],
    [CLRSTACK_OUTPUT],
    new Date(2026, 0, 1),
  );
  const stacks = stacksReport.views?.[0].blocks[0];
  assert.equal(stacks?.kind, 'stacks');
  if (stacks?.kind === 'stacks') {
    assert.equal(stacks.threads.length, 2);
  }
});

test('общие команды не дублируются при нескольких наборах', () => {
  const overviewOutput = [CLRTHREADS_OUTPUT, EEHEAP_OUTPUT, DUMPHEAP_OUTPUT, SYNCBLK_OUTPUT].join('\n');
  const report = buildDumpReport(
    'app.dmp',
    [
      { id: 'overview', commands: ['clrthreads', 'eeheap -gc', 'dumpheap -stat', 'syncblk'] },
      { id: 'memory', commands: ['dumpheap -stat'] },
      { id: 'locks', commands: ['syncblk'] },
    ],
    [overviewOutput, DUMPHEAP_OUTPUT, SYNCBLK_OUTPUT],
    new Date(2026, 0, 1),
  );

  // dumpheap и syncblk уже показаны в «Обзоре»: отдельных панелей для них нет.
  assert.deepEqual((report.views ?? []).map(view => view.command), [
    'clrthreads',
    'eeheap -gc',
    'dumpheap -stat',
    'syncblk',
  ]);
});

test('сравнение куч считает рост и сокращение по типам', () => {
  const changes = compareHeapTypes(
    {
      totalCount: 100,
      totalSize: 1000,
      entries: [
        { typeName: 'System.String', count: 60, size: 600 },
        { typeName: 'System.Byte[]', count: 40, size: 400 },
      ],
    },
    {
      totalCount: 150,
      totalSize: 1600,
      entries: [
        { typeName: 'System.String', count: 50, size: 500 },
        { typeName: 'System.Byte[]', count: 100, size: 1100 },
      ],
    },
  );

  assert.deepEqual(changes.map(change => change.typeName), ['System.Byte[]', 'System.String']);
  assert.equal(changes[0].sizeDelta, 700);
  assert.equal(changes[0].countDelta, 60);
  assert.equal(changes[1].sizeDelta, -100);
  assert.equal(compareHeapTypes(undefined, undefined).length, 0);
});

test('сравнение дампов строит наблюдения и текстовый отчёт', () => {
  const before = [
    '> dumpheap -stat',
    'Statistics:',
    '              MT    Count    TotalSize Class Name',
    '00007f8b1c2d3e50       10      5000000 System.Byte[]',
  ].join('\n');
  const after = [
    '> dumpheap -stat',
    'Statistics:',
    '              MT    Count    TotalSize Class Name',
    '00007f8b1c2d3e50       40     25000000 System.Byte[]',
  ].join('\n');
  const analyses: SosAnalysis[] = [{ id: 'memory', commands: ['dumpheap -stat'] }];
  const date = new Date(2026, 10, 7, 9, 0, 0);

  const comparison = buildDumpComparison(
    analyzeDumpOutput('/dumps/before.dmp', analyses, before, date, { takenAt: date }),
    analyzeDumpOutput('/dumps/after.dmp', analyses, after, date, { takenAt: date }),
  );

  assert.equal(comparison.before.heap?.totalSize, 5_000_000);
  assert.equal(comparison.after.heap?.totalSize, 25_000_000);
  assert.ok(comparison.findings.some(finding => finding.title === 'Managed heap grew'));
  assert.ok(comparison.findings.some(finding => finding.title === 'Largest growth by type'));

  const report = formatComparisonReport(comparison, date);
  assert.match(report, /Dump comparison/);
  assert.match(report, /before\.dmp/);
  assert.match(report, /after\.dmp/);
  assert.match(report, /Type changes:/);
  assert.match(report, /System\.Byte\[\]/);
});
