import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, initialState, type MonitorConfig, type MonitorState, validateConfig } from '../packages/monitoring/src/index.js';
import { normalize, hash } from '../packages/dns-engine/src/records.js';
import type { QueryResult } from '../packages/dns-engine/src/query.js';

const config: MonitorConfig = { hostname: 'example.test', recordType: 'A', mode: 'WATCH', intervalSeconds: 300, timeoutMs: 1000, failureThreshold: 2, recoveryThreshold: 2, changeThreshold: 2, resolverIds: ['one', 'two', 'three'] };
const answers = (ip = '192.0.2.1'): QueryResult[] => config.resolverIds.map(resolverId => ({ resolverId, status: 'SUCCESS', answers: [ip], latencyMs: 1, queriedAt: new Date(0).toISOString() }));
function runner(c: MonitorConfig) {
  let state: MonitorState = initialState();
  let tick = 0;
  return (results = answers()) => {
    const result = evaluate(c, state, results, new Date(++tick * c.intervalSeconds * 1000));
    state = result.state;
    return result;
  };
}
test('WATCH confirms baseline and each stable change exactly once', () => {
  const run = runner(config);
  assert.equal(run().state.status, 'UNKNOWN');
  assert.equal(run().events[0]?.type, 'BASELINE_ESTABLISHED');
  assert.equal(run(answers('192.0.2.2')).events.length, 0);
  assert.equal(run(answers('192.0.2.2')).events[0]?.type, 'VALUE_CHANGED');
  assert.equal(run(answers('192.0.2.2')).events.length, 0);
});
test('EXPECTED failure and recovery thresholds are independent and deduplicated', () => {
  const run = runner({ ...config, mode: 'EXPECTED', expected: ['192.0.2.1'], match: 'EXACT' });
  assert.equal(run(answers('192.0.2.2')).state.status, 'WARNING');
  assert.equal(run(answers('192.0.2.2')).events[0]?.type, 'INCIDENT_OPENED');
  assert.equal(run(answers('192.0.2.2')).events.length, 0);
  assert.equal(run().state.status, 'CRITICAL');
  assert.equal(run().events[0]?.type, 'INCIDENT_RESOLVED');
  assert.equal(run().events.length, 0);
});
test('failed checks reset WATCH candidates but preserve accepted baseline', () => {
  const run = runner(config);
  run(); run(); run(answers('192.0.2.2'));
  run([]);
  assert.equal(run(answers('192.0.2.2')).events.length, 0);
  assert.equal(run(answers('192.0.2.2')).events[0]?.type, 'VALUE_CHANGED');
});
test('quorum counts missing resolvers and cannot be inflated by duplicates', () => {
  const run = runner(config);
  assert.equal(run(answers().slice(0, 1)).state.failures, 1);
  assert.equal(run(answers().slice(0, 2)).observation.degraded, true);
  const result = answers()[0]!;
  assert.throws(() => run([result, result]), /duplicate/);
});
test('per-monitor timing and thresholds take effect', () => {
  const result = evaluate({ ...config, intervalSeconds: 17, failureThreshold: 1 }, initialState(), [], new Date(1000));
  assert.equal(result.nextCheckAt.getTime(), 18000);
  assert.equal(result.state.status, 'CRITICAL');
  assert.throws(() => validateConfig({ ...config, intervalSeconds: 0 }), /intervalSeconds/);
  assert.throws(() => evaluate(config, result.state, [], new Date(1000)), /newer/);
});
test('EXPECTED contains permits additional values; exact rejects them', () => {
  const results = answers().map(result => ({ ...result, answers: ['192.0.2.1', '192.0.2.2'] }));
  assert.equal(runner({ ...config, mode: 'EXPECTED', expected: ['192.0.2.1'], match: 'CONTAINS' })(results).state.status, 'HEALTHY');
  assert.equal(runner({ ...config, mode: 'EXPECTED', expected: ['192.0.2.1'], match: 'EXACT' })(results).state.status, 'WARNING');
});
test('canonical values ignore record ordering, DNS name case, duplicates and IPv6 spelling', () => {
  assert.equal(hash(normalize('MX', [{ priority: 20, host: 'MX2.TEST.' }, { priority: 10, host: 'mx1.test' }])), hash(normalize('MX', [{ priority: 10, host: 'MX1.TEST.' }, { priority: 20, host: 'mx2.test' }])));
  assert.deepEqual(normalize('AAAA', ['2001:0db8:0:0:0:0:0:1', '2001:db8::1']), ['2001:db8::1']);
  assert.deepEqual(normalize('CNAME', ['TARGET.TEST.', 'target.test']), ['target.test']);
  assert.notEqual(hash(normalize('TXT', ['ABC '])), hash(normalize('TXT', ['abc'])));
  assert.throws(() => normalize('A', ['999.1.1.1']));
});
