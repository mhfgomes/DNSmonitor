import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { databasePool } from '../../packages/database/src/connection.js';
import { migrate } from '../../packages/database/src/migrations.js';
import { Repository, type MonitorInput } from '../../packages/database/src/repository.js';
import { Retention, retentionConfig } from '../../packages/database/src/retention.js';
import { Auth } from '../../packages/auth/src/index.js';
import { createApi } from '../../apps/api/src/server.js';
const url = process.env.INTEGRATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Use a disposable _test database');
const pool = databasePool(url, 8);
const repository = new Repository(pool);
const config = retentionConfig({ RETENTION_BATCH_SIZE: '3' });
const retention = new Retention(pool, config);
const input: MonitorInput = { name: 'Retention fixture', config: { hostname: 'example.test', recordType: 'A', mode: 'EXPECTED', expected: ['192.0.2.1'], match: 'EXACT', intervalSeconds: 300, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, changeThreshold: 1, resolverIds: ['fixture'] }, resolvers: [{ id: 'fixture', server: '127.0.0.1', protocol: 'UDP' }] };
const due = () => pool.query("UPDATE maintenance SET next_run_at = '2000-01-01' WHERE name = 'retention'");
async function check(monitor: string, status: string, state?: string, days = 2, revision = 1) {
  const id = randomUUID();
  await pool.query(`INSERT INTO check_runs (id, monitor_id, worker_id, config_revision, scheduled_at, started_at, finished_at, status, observation, resolver_results)
    VALUES (?, ?, 'fixture', ?, DATE_SUB(CURRENT_DATE(), INTERVAL ? DAY), DATE_SUB(CURRENT_DATE(), INTERVAL ? DAY), IF(? = 'RUNNING', NULL, DATE_SUB(CURRENT_DATE(), INTERVAL ? DAY)), ?, ?, ?)`,
  [id, monitor, revision, days, days, status, days, status, JSON.stringify(state ? { status: state } : {}), JSON.stringify([{ status: 'SUCCESS', latencyMs: 10 }, { status: 'SUCCESS', latencyMs: 30 }, { status: 'TIMEOUT', latencyMs: 1000 }])]);
  return id;
}
test('bounded retention and atomic hourly archives', { timeout: 60000 }, async t => {
  t.after(() => pool.end()); await migrate(pool);
  t.beforeEach(async () => {
    for (const table of ['monitor_hourly', 'notification_deliveries', 'alert_rules', 'notification_channels', 'sessions', 'login_limits', 'audit_events', 'users', 'notification_jobs', 'dns_events', 'monitor_states', 'incidents', 'check_runs', 'monitors', 'resolvers', 'resolver_groups', 'workers']) await pool.query(`DELETE FROM ${table}`);
    await due();
  });
  await t.test('competing sweepers count once, respect batch limits and keep recent/running checks', async () => {
    const id = await repository.createMonitor(input);
    for (const state of ['HEALTHY', 'WARNING', 'CRITICAL', undefined]) await check(id, 'COMPLETED', state);
    await check(id, 'ERROR'); await check(id, 'ABANDONED');
    const running = await check(id, 'RUNNING'); const recent = await check(id, 'COMPLETED', 'HEALTHY', 0);
    const results = await Promise.all([retention.sweep(), retention.sweep()]);
    assert.equal(results.filter(Boolean).length, 1); assert.equal(results.find(Boolean)!.checks, 3);
    await due(); assert.equal((await retention.sweep())!.checks, 3);
    await due(); assert.equal((await retention.sweep())!.checks, 0);
    const rows = await pool.query('SELECT * FROM monitor_hourly'); assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.checks, 6); assert.equal(row.completed, 4);
    for (const key of ['healthy', 'warning', 'critical', 'unknown_count', 'errors', 'abandoned']) assert.equal(row[key], 1);
    assert.equal(row.latency_sum, 160); assert.equal(row.latency_count, 8); assert.equal(row.latency_max, 30);
    assert.deepEqual((await pool.query('SELECT id FROM check_runs')).map((r: { id: string }) => r.id).sort(), [recent, running].sort());
  });
  await t.test('a failed deletion rolls back summaries and scheduling; retry is safe', async () => {
    const id = await repository.createMonitor(input); await check(id, 'COMPLETED', 'CRITICAL');
    await pool.query("CREATE TRIGGER reject_retention BEFORE DELETE ON check_runs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture rollback'");
    try { await assert.rejects(retention.sweep()); assert.equal((await pool.query('SELECT * FROM monitor_hourly')).length, 0); }
    finally { await pool.query('DROP TRIGGER reject_retention'); }
    assert.equal((await retention.sweep())!.checks, 1);
    await due(); assert.equal((await retention.sweep())!.checks, 0);
    assert.equal((await pool.query('SELECT checks FROM monitor_hourly'))[0].checks, 1);
  });
  await t.test('revision separation, expired summaries and disabled cleanup', async () => {
    const id = await repository.createMonitor(input);
    await check(id, 'COMPLETED', 'HEALTHY', 2, 1); await check(id, 'COMPLETED', 'CRITICAL', 2, 2); await check(id, 'ERROR', undefined, 100);
    assert.equal(await new Retention(pool, { ...config, enabled: false }).sweep(), null);
    assert.equal((await retention.sweep())!.checks, 3);
    const rows = await pool.query('SELECT * FROM monitor_hourly ORDER BY config_revision'); assert.equal(rows.length, 2);
    assert.equal(rows[0].healthy, 1); assert.equal(rows[1].critical, 1);
    await pool.query('UPDATE monitor_hourly SET hour_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY)');
    await due(); assert.equal((await retention.sweep())!.monitor_hourly, 2);
  });
  await t.test('active incidents and queued notifications survive dependency-aware cleanup', async () => {
    const id = await repository.createMonitor(input, false); const claim = (await repository.claimDue('fixture', 1))[0]!;
    await repository.complete(claim, [{ resolverId: 'fixture', status: 'SUCCESS', answers: ['192.0.2.2'], latencyMs: 1, queriedAt: new Date().toISOString() }]);
    await pool.query('UPDATE check_runs SET finished_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY), started_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY)');
    await pool.query('UPDATE dns_events SET created_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY)');
    await pool.query('UPDATE notification_jobs SET created_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY)');
    await pool.query('UPDATE incidents SET opened_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY)');
    await retention.sweep();
    assert.equal((await pool.query('SELECT check_run_id FROM dns_events'))[0].check_run_id, null);
    assert.equal((await pool.query('SELECT * FROM notification_jobs')).length, 1);
    await pool.query("UPDATE notification_jobs SET status = 'IGNORED'"); await due(); await retention.sweep();
    assert.equal((await pool.query('SELECT * FROM notification_jobs')).length, 0);
    assert.equal((await pool.query('SELECT * FROM dns_events')).length, 1);
    await pool.query("UPDATE incidents SET status = 'RESOLVED', resolved_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY)");
    await pool.query('UPDATE monitor_states SET active_incident_id = NULL'); await due(); await retention.sweep();
    assert.equal((await pool.query('SELECT * FROM dns_events')).length, 0); assert.equal((await pool.query('SELECT * FROM incidents')).length, 0);
  });
  await t.test('only terminal deliveries expire; queued and processing payloads remain', async () => {
    const monitor = await repository.createMonitor(input); const channel = randomUUID();
    await pool.query("INSERT INTO notification_channels (id, name, type, encrypted_config) VALUES (?, 'Fixture', 'WEBHOOK', 'fixture')", [channel]);
    for (const status of ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'CANCELLED']) {
      const event = randomUUID(); const job = randomUUID();
      await pool.query("INSERT INTO dns_events (id, monitor_id, type, payload, created_at) VALUES (?, ?, 'VALUE_CHANGED', '{}', DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY))", [event, monitor]);
      await pool.query("INSERT INTO notification_jobs (id, event_id, payload, status, next_attempt_at, created_at) VALUES (?, ?, '{}', 'ROUTED', CURRENT_TIMESTAMP(), DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY))", [job, event]);
      await pool.query("INSERT INTO notification_deliveries (id, job_id, channel_id, encrypted_config, payload, status, next_attempt_at) VALUES (?, ?, ?, 'fixture', '{}', ?, DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 100 DAY))", [randomUUID(), job, channel, status]);
    }
    const result = await retention.sweep(); assert.equal(result!.notification_deliveries, 3);
    assert.deepEqual((await pool.query('SELECT status FROM notification_deliveries ORDER BY status')).map((r: { status: string }) => r.status), ['PENDING', 'PROCESSING']);
    assert.equal((await pool.query('SELECT * FROM notification_jobs')).length, 2);
    assert.equal((await pool.query('SELECT * FROM dns_events')).length, 2);
  });
  await t.test('authenticated API exposes archive counts, latency and cleanup status', async t => {
    const id = await repository.createMonitor(input); await check(id, 'COMPLETED', 'HEALTHY'); await retention.sweep();
    await new Auth(pool).setAdmin('retention@example.test', 'retention-test-password');
    const api = await createApi(pool, { key: Buffer.alloc(32, 1), secureCookies: false, origin: "http://localhost:3000" }); t.after(() => api.close());
    assert.equal((await api.inject(`/api/v1/monitors/${id}/hourly`)).statusCode, 401);
    const login = await api.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'retention@example.test', password: 'retention-test-password' } });
    const headers = { cookie: login.headers['set-cookie']!.toString().split(';')[0]! };
    const response = await api.inject({ url: `/api/v1/monitors/${id}/hourly?limit=1`, headers });
    assert.equal(response.statusCode, 200); assert.equal(response.json().items[0].averageLatencyMs, 20);
    assert.equal((await api.inject({ url: `/api/v1/monitors/${id}/hourly?limit=1001`, headers })).statusCode, 400);
    const status = await api.inject({ url: '/api/v1/retention', headers }); assert.equal(status.statusCode, 200);
    assert.ok(status.json().last_completed_at); assert.equal(status.json().storage.approximate, true);
  });
});
