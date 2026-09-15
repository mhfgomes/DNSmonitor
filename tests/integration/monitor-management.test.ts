import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { databasePool } from '../../packages/database/src/connection.js';
import { migrate } from '../../packages/database/src/migrations.js';
import { Repository, RevisionConflict, type MonitorInput } from '../../packages/database/src/repository.js';
import { Notifications } from '../../packages/notifications/src/service.js';
import { Auth } from '../../packages/auth/src/index.js';
import { createApi } from '../../apps/api/src/server.js';
const url = process.env.INTEGRATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Use a disposable _test database');
const pool = databasePool(url, 8); const repo = new Repository(pool); const key = randomBytes(32); const notifications = new Notifications(pool, key);
const input: MonitorInput = { name: 'Managed monitor', config: { hostname: 'example.test', recordType: 'A', mode: 'EXPECTED', expected: ['192.0.2.1'], match: 'EXACT', intervalSeconds: 300, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, changeThreshold: 1, resolverIds: ['fixture'] }, resolvers: [{ id: 'fixture', server: '127.0.0.1', protocol: 'UDP' }] };
const results = [{ resolverId: 'fixture', status: 'SUCCESS' as const, answers: ['192.0.2.2'], latencyMs: 1, queriedAt: new Date().toISOString() }];
async function failing() { const id = await repo.createMonitor(input, false); const claim = (await repo.claimDue('fixture', 1))[0]!; await repo.complete(claim, results); return id; }
async function rule(monitorIds: string[]) { const channel = await notifications.createChannel('Fixture', { type: 'WEBHOOK', url: 'http://127.0.0.1:1/unused' }); const id = await notifications.createRule('Fixture', { eventTypes: ['INCIDENT_OPENED'], monitorIds, channelIds: [channel] }); return id; }
test('monitor editing and deletion', { timeout: 60000 }, async t => {
  t.after(() => pool.end()); await migrate(pool);
  t.beforeEach(async () => {
    for (const table of ['monitor_hourly', 'notification_deliveries', 'alert_rules', 'notification_channels', 'sessions', 'login_limits', 'audit_events', 'users', 'notification_jobs', 'dns_events', 'monitor_states', 'incidents', 'check_runs', 'monitors', 'resolvers', 'resolver_groups', 'workers']) await pool.query(`DELETE FROM ${table}`);
  });
  await t.test('query edits fence old checks, close incidents without recovery alerts and cancel obsolete deliveries', async () => {
    await rule([]); const id = await failing();
    await notifications.routePending(); const delivery = (await notifications.claim())!;
    await repo.checkNow(id); const stale = (await repo.claimDue('fixture', 1))[0]!;
    await repo.updateMonitor(id, { ...input, config: { ...input.config, hostname: 'new.example.test' } }, 1);
    assert.equal(await repo.complete(stale, results), false);
    const detail = await repo.inspect(id);
    assert.equal(detail.configRevision, 2); assert.equal(detail.state.status, 'UNKNOWN'); assert.equal(detail.currentValue, null); assert.equal(detail.checks.length, 0);
    const incident = (await pool.query('SELECT * FROM incidents'))[0]; assert.equal(incident.status, 'RESOLVED'); assert.equal(incident.closure_reason, 'CONFIGURATION_CHANGED');
    assert.equal((await pool.query('SELECT type FROM dns_events WHERE type = ?', ['INCIDENT_RESOLVED'])).length, 0);
    assert.equal((await pool.query('SELECT status FROM notification_deliveries'))[0].status, 'CANCELLED');
    await notifications.send(delivery); assert.equal(await notifications.finish(delivery), false); await assert.rejects(notifications.retry(delivery.id));
    assert.equal(await notifications.routePending(), 0);
    const fresh = (await repo.claimDue('new-worker', 1))[0]!; assert.equal(fresh.config.hostname, 'new.example.test');
    assert.equal(await repo.complete(fresh, results), true); assert.equal((await repo.inspect(id)).checks.length, 1);
    assert.equal((await pool.query('SELECT * FROM resolver_groups')).length, 1);
  });
  await t.test('name-only and normalized equivalent edits preserve WATCH baseline and history', async () => {
    const watch: MonitorInput = { ...input, config: { ...input.config, mode: 'WATCH' } };
    const id = await repo.createMonitor(watch, false); const claim = (await repo.claimDue('fixture', 1))[0]!; await repo.complete(claim, results);
    const before = await repo.inspect(id);
    await repo.updateMonitor(id, { ...watch, name: 'Renamed monitor', config: { ...watch.config, hostname: 'EXAMPLE.TEST.' }, resolvers: [{ ...watch.resolvers[0]!, port: 53 }] }, 1);
    const after = await repo.inspect(id); assert.deepEqual(after.state, before.state); assert.equal(after.name, 'Renamed monitor'); assert.equal(after.checks.length, 1);
    await assert.rejects(repo.updateMonitor(id, watch, 1), RevisionConflict); await assert.rejects(repo.deleteMonitor(id, 1), RevisionConflict);
    await repo.setEnabled(id, false); const revision = (await repo.inspect(id)).configRevision;
    await repo.updateMonitor(id, { ...watch, config: { ...watch.config, recordType: 'TXT' } }, revision);
    assert.equal((await repo.inspect(id)).enabled, false); assert.equal((await repo.inspect(id)).state.baseline, undefined);
    assert.equal((await repo.claimDue('fixture', 1)).length, 0);
  });
  await t.test('timing edits preserve incidents and failed edit transactions leave monitoring intact', async () => {
    const id = await failing();
    await repo.updateMonitor(id, { ...input, config: { ...input.config, failureThreshold: 3 } }, 1);
    const before = await repo.inspect(id); assert.equal(before.state.incidentOpen, true);
    await pool.query("CREATE TRIGGER reject_monitor_edit BEFORE INSERT ON dns_events FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture rollback'");
    try { await assert.rejects(repo.updateMonitor(id, { ...input, config: { ...input.config, hostname: 'new.test' } }, 2)); }
    finally { await pool.query('DROP TRIGGER reject_monitor_edit'); }
    assert.deepEqual(await repo.inspect(id), before);
    assert.equal((await pool.query('SELECT status FROM notification_jobs'))[0].status, 'PENDING');
  });
  await t.test('deletion cleans dependencies without broadening scoped rules and fences work in flight', async () => {
    const id = await failing(); const other = await repo.createMonitor({ ...input, name: 'Other monitor' });
    const only = await rule([id]); const shared = await rule([id, other]); const all = await rule([]);
    // Make the jobs eligible for the fixture rules created after the first event.
    await pool.query('UPDATE notification_jobs SET created_at = CURRENT_TIMESTAMP(3)'); await notifications.routePending();
    await repo.checkNow(id); const stale = (await repo.claimDue('fixture', 1))[0]!;
    await pool.query("INSERT INTO monitor_hourly (monitor_id,hour_at,config_revision,checks,completed,healthy,warning,critical,unknown_count,errors,abandoned,latency_sum,latency_count,latency_max) VALUES (?,CURRENT_TIMESTAMP(),1,1,1,0,0,1,0,0,0,1,1,1)", [id]);
    await pool.query("CREATE TRIGGER reject_monitor_delete BEFORE DELETE ON monitors FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'fixture rollback'");
    try { await assert.rejects(repo.deleteMonitor(id, 1)); assert.equal((await repo.inspect(id)).checks.length, 2); assert.ok((await pool.query('SELECT * FROM notification_jobs')).length); }
    finally { await pool.query('DROP TRIGGER reject_monitor_delete'); }
    await repo.deleteMonitor(id, 1); assert.equal(await repo.complete(stale, results), false); await repo.fail(stale, 'STALE');
    await assert.rejects(repo.inspect(id), /Monitor not found/);
    for (const table of ['check_runs', 'monitor_states', 'monitor_hourly', 'incidents', 'dns_events']) assert.equal((await pool.query(`SELECT * FROM ${table} WHERE monitor_id = ?`, [id])).length, 0);
    assert.equal((await pool.query('SELECT * FROM notification_jobs')).length, 0); assert.equal((await pool.query('SELECT * FROM notification_deliveries')).length, 0);
    const rules = await notifications.rules(); assert.ok(!rules.some(r => r.id === only)); assert.deepEqual(rules.find(r => r.id === shared)!.config.monitorIds, [other]); assert.deepEqual(rules.find(r => r.id === all)!.config.monitorIds, []);
    assert.equal((await pool.query('SELECT * FROM resolver_groups')).length, 1); assert.equal((await repo.inspect(other)).name, 'Other monitor');
  });
  await t.test('API requires admin, CSRF, revision and explicit deletion name', async t => {
    const id = await repo.createMonitor(input); await new Auth(pool).setAdmin('manage@example.test', 'management-test-password');
    const api = await createApi(pool, { key, secureCookies: false, origin: 'http://localhost:3000' }); t.after(() => api.close());
    const login = await api.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'manage@example.test', password: 'management-test-password' } });
    const cookie = login.headers['set-cookie']!.toString().split(';')[0]!; const headers = { cookie, 'x-csrf-token': login.json().csrfToken };
    const put = { method: 'PUT' as const, url: `/api/v1/monitors/${id}`, payload: { ...input, name: 'API renamed', revision: 1 } };
    assert.equal((await api.inject(put)).statusCode, 401); assert.equal((await api.inject({ ...put, headers: { cookie } })).statusCode, 403);
    assert.equal((await api.inject({ ...put, headers })).statusCode, 200); assert.equal((await api.inject({ ...put, headers })).statusCode, 409);
    const del = { method: 'DELETE' as const, url: `/api/v1/monitors/${id}`, headers, payload: { revision: 2, confirmName: 'wrong' } };
    assert.equal((await api.inject(del)).statusCode, 400);
    await pool.query("UPDATE users SET role = 'VIEWER'"); assert.equal((await api.inject({ ...del, payload: { revision: 2, confirmName: 'API renamed' } })).statusCode, 403);
    await pool.query("UPDATE users SET role = 'ADMIN'"); assert.equal((await api.inject({ ...del, payload: { revision: 2, confirmName: 'API renamed' } })).statusCode, 204);
    assert.equal((await api.inject({ url: `/api/v1/monitors/${id}`, headers })).statusCode, 404);
    assert.equal((await pool.query("SELECT * FROM audit_events WHERE action = 'MONITOR_DELETED'")).length, 1);
  });
});
