/**
 * Сквозная проверка канала данных: настоящее приложение .NET → мост → разбор сообщений → состояние расширения.
 * Тест подтверждает, что расширение получает и корректно обрабатывает реальные данные мониторинга.
 *
 * Требуются собранные артефакты:
 *   npm run bridge:build        — сборка моста в media/bridge и dist/bridge
 *   dotnet build samples/SampleApp
 * Если их нет, тест пропускается: в свежем клоне репозитория он не должен падать.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { buildValueTicks, toChartPoint, toChartGcEvent } from '../src/core/chartData.ts';
import { MonitorState } from '../src/core/monitorState.ts';
import { parseBridgeMessage } from '../src/core/protocol.ts';

const projectRoot = path.resolve(import.meta.dirname, '..');
const bridgeDll = path.join(projectRoot, 'dist', 'bridge', 'MonitorDotnet.Bridge.dll');
const sampleDll = path.join(projectRoot, 'samples', 'SampleApp', 'bin', 'Debug', 'net10.0', 'SampleApp.dll');

const missingArtifacts = !existsSync(bridgeDll) || !existsSync(sampleDll);

test('мост отдаёт данные, которые состояние расширения принимает и отображает', { skip: missingArtifacts ? 'Нет dist/bridge или сборки SampleApp (см. комментарий в тесте).' : false }, async () => {
  const sample = spawn('dotnet', [sampleDll], { stdio: ['ignore', 'pipe', 'pipe'] });
  const sampleOutput = createInterface({ input: sample.stdout });

  try {
    const pid = await readSamplePid(sampleOutput);
    const state = new MonitorState();
    state.setMaxPoints(60);

    const bridge = spawn('dotnet', [
      bridgeDll,
      '--pid', pid.toString(),
      '--refresh-interval', '1',
      '--counters', 'System.Runtime,SampleApp',
      '--metrics', '*',
      '--duration-seconds', '6',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const reader = createInterface({ input: bridge.stdout });
    for await (const line of reader) {
      const message = parseBridgeMessage(line);
      if (message === null) {
        continue;
      }

      switch (message.type) {
        case 'hello':
          state.applyHello(message);
          break;
        case 'sample':
          state.applySample(message);
          break;
        case 'environment':
          state.applyEnvironment(message);
          break;
        case 'status':
          state.applyStatus(message);
          break;
        default:
          break;
      }
    }

    await new Promise<void>(resolve => bridge.once('exit', () => resolve()));

    // Состояние наполнилось реальными данными.
    assert.ok(state.series.length >= 3, `Ожидались срезы, получено ${state.series.length}`);
    assert.equal(state.status, 'stopped');
    assert.ok(state.hello?.pid === pid);

    const latest = state.latest!;
    assert.ok(latest.privateMemoryBytes > 0, 'Приватная память должна быть больше нуля');
    assert.ok(latest.threadCount > 0, 'Число потоков должно быть больше нуля');

    // Счётчики и метрики доехали до расширения.
    assert.ok([...state.counters.keys()].some(key => key.includes('cpu-usage')), 'Нет счётчика cpu-usage');
    assert.ok([...state.counters.keys()].some(key => key.includes('sample-queue')), 'Нет счётчика приложения-образца');
    assert.ok([...state.metrics.keys()].some(key => key.includes('app.requests')), 'Нет метрики app.requests');

    // Окружение и события GC.
    assert.ok((state.environment?.variables.length ?? 0) > 0, 'Переменные окружения не получены');
    assert.ok(state.gcEvents.length > 0, 'События GC не получены');

    // Данные годятся для графиков панели Performance.
    const chartPoints = state.series.map(toChartPoint);
    assert.equal(chartPoints.length, state.series.length);
    assert.ok(Number.isFinite(chartPoints.at(-1)!.cpu), 'Загрузка CPU должна быть числом');
    assert.ok(buildValueTicks(Math.max(...chartPoints.map(point => point.cpu))).length > 0);

    const chartGcEvents = state.gcEvents.map(toChartGcEvent).filter(event => event !== undefined);
    assert.ok(chartGcEvents.length > 0, 'События GC должны преобразовываться в отметки графика');
    assert.ok(chartGcEvents.every(event => Number.isFinite(event.t)));
  } finally {
    sampleOutput.close();
    if (!sample.killed) {
      sample.kill('SIGTERM');
    }
  }
});

/** Ждёт строку «PID:<номер>», которую печатает приложение-образец при старте. */
async function readSamplePid(reader: ReturnType<typeof createInterface>): Promise<number> {
  for await (const line of reader) {
    const match = /^PID:(\d+)$/.exec(line.trim());
    if (match !== null) {
      return Number(match[1]);
    }
  }

  throw new Error('Приложение-образец не сообщило свой PID.');
}
