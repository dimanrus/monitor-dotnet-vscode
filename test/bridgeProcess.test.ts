import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBridgeArguments, type BridgeLaunchOptions } from '../src/monitor/bridgeProcess.ts';

function options(overrides: Partial<BridgeLaunchOptions> = {}): BridgeLaunchOptions {
  return {
    dotnetPath: 'dotnet',
    bridgePath: '/app/dist/bridge/MonitorDotnet.Bridge.dll',
    pid: 4242,
    refreshIntervalSeconds: 1,
    counterProviders: ['System.Runtime'],
    metricProviders: ['*'],
    collectEnvironment: true,
    ...overrides,
  };
}

test('buildBridgeArguments: запускает сборку через dotnet с полным набором параметров', () => {
  const args = buildBridgeArguments(options());

  assert.deepEqual(args, [
    '/app/dist/bridge/MonitorDotnet.Bridge.dll',
    '--pid', '4242',
    '--refresh-interval', '1',
    '--counters', 'System.Runtime',
    '--metrics', '*',
  ]);
});

test('buildBridgeArguments: объединяет несколько провайдеров через запятую', () => {
  const args = buildBridgeArguments(options({
    counterProviders: ['System.Runtime', 'MyProvider[A,B]'],
    metricProviders: ['MeterA', 'MeterB'],
  }));

  const counters = args.indexOf('--counters');
  const metrics = args.indexOf('--metrics');

  assert.equal(args[counters + 1], 'System.Runtime,MyProvider[A,B]');
  assert.equal(args[metrics + 1], 'MeterA,MeterB');
});

test('buildBridgeArguments: исполняемый файл запускается напрямую', () => {
  const args = buildBridgeArguments(options({ bridgePath: '/app/dist/bridge/MonitorDotnet.Bridge' }));

  assert.equal(args[0], '--pid');
  assert.equal(args[1], '4242');
});

test('buildBridgeArguments: отсутствие окружения и пустые списки не передаются', () => {
  const args = buildBridgeArguments(options({
    collectEnvironment: false,
    counterProviders: [],
    metricProviders: [],
  }));

  assert.ok(args.includes('--no-environment'));
  assert.ok(!args.includes('--counters'));
  assert.ok(!args.includes('--metrics'));
});
