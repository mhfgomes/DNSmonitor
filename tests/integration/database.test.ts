import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import packet from 'dns-packet';
import { databasePool } from '../../packages/database/src/connection.js';
import { migrate } from '../../packages/database/src/migrations.js';
import { Repository, nextSlot, type MonitorInput } from '../../packages/database/src/repository.js';
import { Worker } from '../../apps/worker/src/worker.js';
import type { QueryResult } from '../../packages/dns-engine/src/query.js';

const url = process.env.INTEGRATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Set INTEGRATION_DATABASE_URL to a disposable database ending in _test');
const pool = databasePool(url, 8);
const repository = new Repository(pool);
const input: MonitorInput = {
  name: 'Fixture monitor',
  config: { hostname: 'example.test', recordType: 'A', mode: 'EXPECTED', expected: ['192.0.2.1'], match: 'EXACT', intervalSeconds: 1, timeoutMs: 200, failureThreshold: 1, recoveryThreshold: 1, changeThreshold: 1, resolverIds: ['fixture'] },
  resolvers: [{ id: 'fixture', server: '127.0.0.1', protocol: 'UDP', port: 15353 }],
};
const results = (ip = '192.0.2.2'): QueryResult[] => [{ resolverId: 'fixture', status: 'SUCCESS', answers: [ip], latencyMs: 1, queriedAt: new Date().toISOString() }];
async function until(predicate: () => Promise<boolean>, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(25); }
  throw new Error('Condition did not become true');
}

test('MariaDB persistence and worker integration', { timeout: 60000 }, async t => {
  t.after(() => pool.end());
  await Promise.all([migrate(pool), migrate(pool)]);
  t.beforeEach(async () => {
    for (const table of ['monitor_hourly', 'notification_deliveries', 'alert_rules', 'notification_channels', 'sessions', 'login_limits', 'audit_events', 'users', 'notification_jobs', 'dns_events', 'monitor_states', 'incidents', 'check_runs', 'monitors', 'resolvers', 'resolver_groups', 'workers']) {
      await pool.query(`DELETE FROM ${table}`);
    }
  });

  await t.test('migrations serialize and remain idempotent', async () => {
    await migrate(pool);
    const rows = await pool.query('SELECT * FROM schema_migrations');
    assert.equal(rows.length, 6);
  });

  await t.test('two workers claim disjoint monitors and retries do not duplicate transitions', async () => {
    for (let i = 0; i < 6; i++) await repository.createMonitor(input, false);
    const [a, b] = await Promise.all([repository.claimDue('worker-a', 3), repository.claimDue('worker-b', 3)]);
    assert.equal(a.length + b.length, 6);
    assert.equal(new Set([...a, ...b].map(claim => claim.id)).size, 6);
    assert.equal((await repository.claimDue('worker-c', 10)).length, 0);
    const claim = a[0]!;
    assert.equal(await repository.complete(claim, results()), true);
    assert.equal(await repository.complete(claim, results()), false);
    assert.equal((await pool.query('SELECT * FROM incidents')).length, 1);
    assert.equal((await pool.query('SELECT * FROM notification_jobs')).length, 1);
  });

  await t.test('expired ownership is fenced and a replacement recovers the execution', async () => {
    await repository.createMonitor(input, false);
    const old = (await repository.claimDue('old-worker', 1))[0]!;
    await pool.query('UPDATE monitors SET lease_expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?', [old.id]);
    assert.equal(await repository.complete(old, results()), false);
    const fresh = (await repository.claimDue('new-worker', 1))[0]!;
    assert.notEqual(old.token, fresh.token);
    assert.equal(await repository.complete(old, results()), false);
    assert.equal(await repository.complete(fresh, results()), true);
    const checks = await pool.query('SELECT status FROM check_runs ORDER BY started_at');
    assert.deepEqual(checks.map((row: { status: string }) => row.status).sort(), ['ABANDONED', 'COMPLETED']);
  });

  await t.test('repeated 25-monitor batches remain disjoint across five workers', async () => {
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 25; i++) await repository.createMonitor({ ...input, config: { ...input.config, intervalSeconds: 300 } }, false);
      const batches = await Promise.all(Array.from({ length: 5 }, (_, index) => repository.claimDue(`stress-${index}`, 5)));
      const claims = batches.flat();
      assert.equal(claims.length, 25);
      assert.equal(new Set(claims.map(claim => claim.id)).size, 25);
      assert.ok((await Promise.all(claims.map(claim => repository.complete(claim, results())))).every(Boolean));
    }
    assert.equal((await pool.query('SELECT * FROM incidents')).length, 100);
    assert.equal((await pool.query('SELECT * FROM notification_jobs')).length, 100);
  });

  await t.test('pause/resume and revision changes reject an in-flight result', async () => {
    const id = await repository.createMonitor(input, false);
    const claim = (await repository.claimDue('worker', 1))[0]!;
    await repository.setEnabled(id, false);
    assert.equal(await repository.complete(claim, results()), false);
    assert.equal((await repository.claimDue('worker', 1)).length, 0);
    await repository.setEnabled(id, true);
    const fresh = (await repository.claimDue('worker', 1))[0]!;
    await pool.query('UPDATE monitors SET config_revision = config_revision + 1 WHERE id = ?', [id]);
    assert.equal(await repository.complete(fresh, results()), false);
    assert.equal((await pool.query('SELECT * FROM incidents')).length, 0);
  });

  await t.test('state, incident, history and notification outbox roll back together', async () => {
    await repository.createMonitor(input, false);
    const claim = (await repository.claimDue('worker', 1))[0]!;
    await pool.query("CREATE TRIGGER reject_notification BEFORE INSERT ON notification_jobs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test failure'");
    try { await assert.rejects(repository.complete(claim, results())); }
    finally { await pool.query('DROP TRIGGER reject_notification'); }
    assert.equal((await pool.query('SELECT * FROM incidents')).length, 0);
    assert.equal((await pool.query('SELECT * FROM dns_events')).length, 0);
    assert.equal((await pool.query('SELECT status FROM check_runs'))[0].status, 'RUNNING');
    assert.equal(JSON.parse((await pool.query('SELECT state FROM monitor_states'))[0].state).incidentOpen, false);
    assert.equal(await repository.complete(claim, results()), true);
    assert.equal((await pool.query('SELECT * FROM notification_jobs')).length, 1);
  });

  await t.test('infrastructure errors do not count as DNS failures and cadence skips missed slots', async () => {
    await repository.createMonitor(input, false);
    const claim = (await repository.claimDue('worker', 1))[0]!;
    await repository.fail(claim, 'TEST_ERROR');
    assert.equal(JSON.parse((await pool.query('SELECT state FROM monitor_states'))[0].state).failures, 0);
    assert.equal((await pool.query('SELECT status FROM check_runs'))[0].status, 'ERROR');
    assert.equal(nextSlot(new Date(0), new Date(16000), 5).getTime(), 20000);
    assert.equal(nextSlot(new Date(0), new Date(15000), 5).getTime(), 20000);
  });

  await t.test('real DNS changes drive both modes with two live workers', async t => {
    let address = '192.0.2.1';
    const dns = createSocket('udp4');
    dns.on('message', (bytes, remote) => {
      const request = packet.decode(bytes);
      dns.send(packet.encode({ ...request, type: 'response', answers: [{ name: 'example.test', type: 'A', ttl: 300, data: address }] }), remote.port, remote.address);
    });
    await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve));
    const resolvers = [{ ...input.resolvers[0]!, port: dns.address().port }];
    const watch = await repository.createMonitor({ ...input, name: 'Watch', resolvers, config: { ...input.config, mode: 'WATCH', changeThreshold: 2 } }, false);
    const expected = await repository.createMonitor({ ...input, name: 'Expected', resolvers, config: { ...input.config, failureThreshold: 2, recoveryThreshold: 2 } }, false);
    const stop = new AbortController();
    const workers = ['a', 'b'].map(id => new Worker(repository, { id, concurrency: 1, pollMs: 25, log: () => undefined }));
    const running = workers.map(worker => worker.run(stop.signal));
    t.after(async () => { stop.abort(); await Promise.all(running); dns.close(); });
    await until(async () => (await repository.list()).every(monitor => monitor.state.status === 'HEALTHY'));
    address = '192.0.2.2';
    await until(async () => {
      const monitors = await repository.list();
      return monitors.find(m => m.id === watch)?.state.baseline?.[0] === address && monitors.find(m => m.id === expected)?.state.incidentOpen;
    });
    address = '192.0.2.1';
    await until(async () => (await repository.list()).every(monitor => monitor.state.status === 'HEALTHY'));
    const incidents = await pool.query('SELECT * FROM incidents WHERE monitor_id = ?', [expected]);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].status, 'RESOLVED');
    assert.equal((await pool.query("SELECT * FROM dns_events WHERE monitor_id = ? AND type = 'VALUE_CHANGED'", [watch])).length, 2);
    assert.equal((await pool.query('SELECT * FROM notification_jobs')).length, 4);
    assert.equal((await pool.query("SELECT * FROM check_runs WHERE status = 'ERROR'")).length, 0);
  });

  await t.test('SIGKILL recovery and SIGTERM shutdown work across actual processes', async t => {
    const dns = createSocket('udp4');
    let respond = false;
    dns.on('message', (bytes, remote) => {
      if (!respond) return;
      const request = packet.decode(bytes);
      dns.send(packet.encode({ ...request, type: 'response', answers: [{ name: 'example.test', type: 'A', ttl: 300, data: '192.0.2.1' }] }), remote.port, remote.address);
    });
    await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve));
    t.after(() => dns.close());
    const id = await repository.createMonitor({ ...input, config: { ...input.config, timeoutMs: 5000 }, resolvers: [{ ...input.resolvers[0]!, port: dns.address().port }] }, false);
    const start = (workerId: string) => spawn(process.execPath, ['dist/apps/worker/src/main.js'], { env: { ...process.env, DATABASE_URL: url, DATABASE_URL_FILE: '', WORKER_ID: workerId, HEALTH_PORT: '0', ENCRYPTION_KEY: 'a'.repeat(64), ENCRYPTION_KEY_FILE: '' }, stdio: 'ignore' });
    const killed = start('killed-worker');
    t.after(() => { if (killed.exitCode === null) killed.kill('SIGKILL'); });
    const killedExit = once(killed, 'exit');
    await until(async () => (await pool.query("SELECT * FROM check_runs WHERE worker_id = 'killed-worker' AND status = 'RUNNING'")).length === 1);
    killed.kill('SIGKILL');
    await killedExit;
    // Advance only this test lease instead of waiting 20 seconds for real expiry.
    await pool.query('UPDATE monitors SET lease_expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id = ?', [id]);
    respond = true;
    const replacement = start('replacement-worker');
    t.after(() => { if (replacement.exitCode === null) replacement.kill('SIGKILL'); });
    const replacementExit = once(replacement, 'exit');
    await until(async () => (await pool.query("SELECT * FROM check_runs WHERE worker_id = 'replacement-worker' AND status = 'COMPLETED'")).length >= 1);
    replacement.kill('SIGTERM');
    const [code] = await replacementExit;
    assert.equal(code, 0);
    assert.equal((await pool.query("SELECT status FROM workers WHERE id = 'replacement-worker'"))[0].status, 'STOPPED');
    assert.equal((await pool.query("SELECT status FROM check_runs WHERE worker_id = 'killed-worker'"))[0].status, 'ABANDONED');
  });
});
