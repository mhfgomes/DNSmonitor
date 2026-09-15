import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSocket } from 'node:dgram';
import { setTimeout as sleep } from 'node:timers/promises';
import packet from 'dns-packet';
import { SMTPServer } from 'smtp-server';
import { databasePool } from '../../packages/database/src/connection.js';
import { migrate } from '../../packages/database/src/migrations.js';
import { Repository, type MonitorInput } from '../../packages/database/src/repository.js';
import { Auth } from '../../packages/auth/src/index.js';
import { createApi } from '../../apps/api/src/server.js';
import { Notifications } from '../../packages/notifications/src/service.js';
import type { QueryResult } from '../../packages/dns-engine/src/query.js';
import { Worker } from '../../apps/worker/src/worker.js';

const url = process.env.INTEGRATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Set an explicit disposable _test database URL');
const pool = databasePool(url, 8);
const repository = new Repository(pool);
const key = randomBytes(32);
const notifications = new Notifications(pool, key);
const input: MonitorInput = { name: 'API fixture', config: { hostname: 'example.test', mode: 'EXPECTED', expected: ['192.0.2.1'], match: 'EXACT', recordType: 'A', intervalSeconds: 300, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, changeThreshold: 1, resolverIds: ['fixture'] }, resolvers: [{ id: 'fixture', server: '127.0.0.1', protocol: 'UDP' }] };
const results: QueryResult[] = [{ resolverId: 'fixture', answers: ['192.0.2.2'], status: 'SUCCESS', queriedAt: new Date().toISOString(), latencyMs: 1 }];
async function event() {
  const id = await repository.createMonitor(input, false);
  const claim = (await repository.claimDue('fixture', 1))[0]!;
  assert.equal(await repository.complete(claim, results), true);
  return id;
}

test('authenticated API and notification delivery', { timeout: 60000 }, async t => {
  t.after(() => pool.end());
  await migrate(pool);
  t.beforeEach(async () => {
    for (const table of ['monitor_hourly', 'notification_deliveries', 'alert_rules', 'notification_channels', 'sessions', 'login_limits', 'audit_events', 'users', 'notification_jobs', 'dns_events', 'monitor_states', 'incidents', 'check_runs', 'monitors', 'resolvers', 'resolver_groups', 'workers']) await pool.query(`DELETE FROM ${table}`);
  });

  await t.test('login, CSRF, per-monitor editing, roles, logout and reset', async t => {
    const auth = new Auth(pool);
    await auth.setAdmin('admin@example.test', 'a-strong-test-password');
    const app = await createApi(pool, { key, origin: 'http://localhost:3000' });
    t.after(() => app.close());
    assert.equal((await app.inject('/api/v1/monitors')).statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'admin@example.test', password: 'a-strong-test-password' } });
    assert.equal(login.statusCode, 200);
    const setCookie = String(login.headers['set-cookie']);
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(';')[0]!;
    const headers = { cookie, 'x-csrf-token': login.json().csrfToken };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: { cookie }, payload: input })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/monitors', headers: { ...headers, origin: 'https://attacker.test' }, payload: input })).statusCode, 403);
    const added = await app.inject({ method: 'POST', url: '/api/v1/monitors', headers, payload: input });
    assert.equal(added.statusCode, 201);
    const id = added.json().id;
    await repository.checkNow(id);
    const claim = (await repository.claimDue('old-config', 1))[0]!;
    const edit = await app.inject({ method: 'PATCH', url: `/api/v1/monitors/${id}`, headers, payload: { intervalSeconds: 17, failureThreshold: 3, recoveryThreshold: 2 } });
    assert.equal(edit.statusCode, 204);
    assert.equal(await repository.complete(claim, results), false);
    const details = (await app.inject({ url: `/api/v1/monitors/${id}`, headers })).json();
    assert.equal(details.config.intervalSeconds, 17); assert.equal(details.config.failureThreshold, 3);
    assert.equal((await app.inject({ url: '/api/v1/monitors?limit=10000', headers })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/monitors/${id}`, headers, payload: { timeoutMs: 0 } })).statusCode, 400);
    await pool.query("UPDATE users SET role = 'VIEWER'");
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/monitors/${id}/pause`, headers })).statusCode, 403);
    await pool.query("UPDATE users SET role = 'ADMIN'");
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers })).statusCode, 204);
    assert.equal((await app.inject({ url: '/api/v1/auth/session', headers })).statusCode, 401);
    const second = await auth.login('admin@example.test', 'a-strong-test-password', 'reset-test');
    await auth.setAdmin('admin@example.test', 'new-strong-test-password');
    assert.equal(await auth.session(second!.token), undefined);
    assert.ok((await pool.query('SELECT * FROM audit_events')).length >= 3);
  });

  await t.test('login limits persist across Auth instances and expired sessions fail', async () => {
    const first = new Auth(pool); const second = new Auth(pool);
    await first.setAdmin('admin@example.test', 'a-strong-test-password');
    const session = await first.login('admin@example.test', 'a-strong-test-password', '127.0.0.1');
    await pool.query('UPDATE sessions SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)');
    assert.equal(await second.session(session!.token), undefined);
    for (let i = 0; i < 9; i++) assert.equal(await first.login('admin@example.test', 'wrong-password', '127.0.0.1'), undefined);
    await assert.rejects(second.login('admin@example.test', 'wrong-password', '127.0.0.1'), /Too many/);
  });

  await t.test('API never returns channel secrets and validates destinations', async t => {
    const auth = new Auth(pool); await auth.setAdmin('admin@example.test', 'a-strong-test-password');
    const session = (await auth.login('admin@example.test', 'a-strong-test-password', '127.0.0.1'))!;
    const app = await createApi(pool, { key, origin: 'http://localhost:3000' }); t.after(() => app.close());
    const headers = { cookie: `dnsmonitor_session=${session.token}`, 'x-csrf-token': session.session.csrfToken };
    const added = await app.inject({ method: 'POST', url: '/api/v1/notification-channels', headers, payload: { name: 'Hook', config: { type: 'WEBHOOK', url: 'https://example.test/very-secret-path', signingSecret: 'a-very-secret-signing-key' } } });
    assert.equal(added.statusCode, 201);
    const listed = await app.inject({ url: '/api/v1/notification-channels', headers });
    assert.ok(!listed.body.includes('secret')); assert.ok(!listed.body.includes('encrypted_config'));
    const rows = await pool.query('SELECT encrypted_config FROM notification_channels');
    assert.ok(!rows[0].encrypted_config.includes('very-secret'));
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/notification-channels', headers, payload: { name: 'Bad', config: { type: 'WEBHOOK', url: 'file:///etc/passwd' } } })).statusCode, 400);
  });

  await t.test('SMTP and signed webhooks deliver once per channel despite overlapping rules', async t => {
    let receivedBody = ''; let signature = ''; let deliveryId = ''; let mail = '';
    const hook = createServer((request, response) => {
      request.on('data', data => { receivedBody += data; });
      request.on('end', () => { signature = String(request.headers['x-dnsmonitor-signature']); deliveryId = String(request.headers['idempotency-key']); response.end('ok'); });
    });
    await new Promise<void>(resolve => hook.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => hook.close(() => resolve())));
    const smtp = new SMTPServer({ disabledCommands: ['AUTH', 'STARTTLS'], onData(stream, _, callback) { stream.on('data', data => { mail += data; }); stream.on('end', () => callback()); } });
    await new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => smtp.close(() => resolve())));
    const webhook = await notifications.createChannel('Webhook', { type: 'WEBHOOK', url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`, signingSecret: 'test-signing-secret' });
    const email = await notifications.createChannel('Email', { type: 'SMTP', host: '127.0.0.1', port: (smtp.server.address() as AddressInfo).port, secure: false, requireTLS: false, from: 'dns@example.test', to: ['ops@example.test'] });
    await notifications.createRule('Both', { eventTypes: ['INCIDENT_OPENED'], channelIds: [webhook, email], monitorIds: [] });
    await notifications.createRule('Overlap', { eventTypes: ['INCIDENT_OPENED'], channelIds: [webhook], monitorIds: [] });
    await event();
    assert.equal(await notifications.routePending(), 1); assert.equal(await notifications.routePending(), 0);
    assert.equal((await pool.query('SELECT * FROM notification_deliveries')).length, 2);
    const claims = await Promise.all([notifications.claim(), notifications.claim()]);
    // A short lock skip can leave a claimant empty; the next poll picks up remaining work.
    for (const claim of claims) if (claim) await notifications.send(claim);
    const remaining = await notifications.claim(); if (remaining) await notifications.send(remaining);
    assert.equal((await pool.query("SELECT * FROM notification_deliveries WHERE status = 'SENT'")).length, 2);
    assert.equal(signature, 'sha256=' + createHmac('sha256', 'test-signing-secret').update(receivedBody).digest('hex'));
    assert.match(deliveryId, /^[a-f0-9-]{36}$/);
    assert.match(mail, /DNSmonitor notification/);
    assert.equal(JSON.parse(receivedBody).event.type, 'INCIDENT_OPENED');
  });

  await t.test('delivery leases, bounded retries, manual retry, and disabled channels', async t => {
    const hook = createServer((_, response) => { response.writeHead(503); response.end('private-provider-error'); });
    await new Promise<void>(resolve => hook.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => hook.close(() => resolve())));
    const channel = await notifications.createChannel('Failing', { type: 'WEBHOOK', url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}` });
    await notifications.createRule('Failures', { eventTypes: ['INCIDENT_OPENED'], channelIds: [channel], monitorIds: [] });
    await event(); await notifications.routePending();
    const stale = (await notifications.claim())!;
    await pool.query('UPDATE notification_deliveries SET lease_expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND)');
    const fresh = (await notifications.claim())!;
    assert.equal(fresh.id, stale.id); assert.notEqual(fresh.token, stale.token);
    assert.equal(await notifications.finish(stale), false);
    await notifications.send(fresh);
    let row = (await pool.query('SELECT * FROM notification_deliveries'))[0];
    assert.equal(row.status, 'PENDING'); assert.equal(row.last_error, 'HTTP_503');
    const delay = (await pool.query('SELECT TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP(3), next_attempt_at) AS seconds FROM notification_deliveries'))[0].seconds;
    assert.ok(delay >= 119 && delay <= 120);
    for (let attempt = 3; attempt <= 5; attempt++) {
      await pool.query('UPDATE notification_deliveries SET next_attempt_at = CURRENT_TIMESTAMP(3)');
      await notifications.send((await notifications.claim())!);
    }
    row = (await pool.query('SELECT * FROM notification_deliveries'))[0];
    assert.equal(row.status, 'FAILED'); assert.equal(row.attempts, 5);
    await notifications.retry(row.id);
    await notifications.setChannelEnabled(channel, false);
    assert.equal((await pool.query('SELECT status FROM notification_deliveries'))[0].status, 'CANCELLED');
    assert.equal(await notifications.claim(), undefined);
  });

  await t.test('new rules do not replay historical events', async () => {
    await event();
    await pool.query('UPDATE notification_jobs SET created_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)');
    const channel = await notifications.createChannel('New', { type: 'WEBHOOK', url: 'http://127.0.0.1:9999' });
    await notifications.createRule('New', { eventTypes: ['INCIDENT_OPENED'], channelIds: [channel], monitorIds: [] });
    await notifications.routePending();
    assert.equal((await pool.query('SELECT status FROM notification_jobs'))[0].status, 'IGNORED');
    assert.equal((await pool.query('SELECT * FROM notification_deliveries')).length, 0);
  });

  await t.test('API-created WATCH and EXPECTED monitors alert and recover through live workers', async t => {
    let address = '192.0.2.1';
    const received: { monitorId: string; event: { type: string } }[] = [];
    const dns = createSocket('udp4');
    dns.on('message', (bytes, remote) => {
      dns.send(packet.encode({ ...packet.decode(bytes), type: 'response', answers: [{ name: 'example.test', type: 'A', ttl: 300, data: address }] }), remote.port, remote.address);
    });
    await new Promise<void>(resolve => dns.bind(0, '127.0.0.1', resolve));
    const hook = createServer((request, response) => {
      let body = ''; request.on('data', chunk => { body += chunk; });
      request.on('end', () => { received.push(JSON.parse(body)); response.end('ok'); });
    });
    await new Promise<void>(resolve => hook.listen(0, '127.0.0.1', resolve));
    const app = await createApi(pool, { key, origin: 'http://localhost:3000' });
    const stop = new AbortController();
    const running: Promise<void>[] = [];
    t.after(async () => { stop.abort(); await Promise.all(running); await app.close(); dns.close(); await new Promise<void>(resolve => hook.close(() => resolve())); });
    const auth = new Auth(pool); await auth.setAdmin('admin@example.test', 'a-strong-test-password');
    const session = (await auth.login('admin@example.test', 'a-strong-test-password', '127.0.0.1'))!;
    const headers = { cookie: `dnsmonitor_session=${session.token}`, 'x-csrf-token': session.session.csrfToken };
    const post = async (path: string, payload: Record<string, unknown>) => {
      const response = await app.inject({ method: 'POST', url: `/api/v1/${path}`, headers, payload });
      assert.equal(response.statusCode, 201, response.body); return response.json().id as string;
    };
    const channel = await post('notification-channels', { name: 'Local receiver', config: { type: 'WEBHOOK', url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}` } });
    await post('alert-rules', { name: 'All changes', config: { eventTypes: ['VALUE_CHANGED', 'INCIDENT_OPENED', 'INCIDENT_RESOLVED'], channelIds: [channel] } });
    const resolvers = [{ ...input.resolvers[0]!, port: dns.address().port }];
    const expected = await post('monitors', { ...input, resolvers, config: { ...input.config, intervalSeconds: 1 } });
    const watch = await post('monitors', { ...input, resolvers, config: { ...input.config, mode: 'WATCH', intervalSeconds: 1 } });
    running.push(new Worker(repository, { id: 'end-to-end', concurrency: 2, pollMs: 25, log: () => undefined }).run(stop.signal), notifications.run(stop.signal));
    const until = async (predicate: () => Promise<boolean>) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { if (await predicate()) return; await sleep(50); }
      throw new Error('End-to-end condition timed out');
    };
    await until(async () => (await repository.list()).every(item => item.state.status === 'HEALTHY'));
    address = '192.0.2.2';
    await until(async () => received.length >= 2);
    const incident = (await pool.query('SELECT id FROM incidents WHERE monitor_id = ?', [expected]))[0];
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/incidents/${incident.id}/acknowledge`, headers })).statusCode, 204);
    const history = await pool.query('SELECT observation FROM check_runs WHERE monitor_id = ? AND status = ? ORDER BY started_at DESC', [expected, 'COMPLETED']);
    assert.ok(history.some((check: { observation: string }) => JSON.parse(check.observation).status === 'CRITICAL'));
    address = '192.0.2.1';
    await until(async () => received.length >= 4);
    assert.equal(received.filter(item => item.monitorId === watch && item.event.type === 'VALUE_CHANGED').length, 2);
    assert.equal(received.filter(item => item.monitorId === expected && item.event.type === 'INCIDENT_OPENED').length, 1);
    assert.equal(received.filter(item => item.monitorId === expected && item.event.type === 'INCIDENT_RESOLVED').length, 1);
    const recovered = (await pool.query('SELECT status, acknowledged_at FROM incidents WHERE id = ?', [incident.id]))[0];
    assert.equal(recovered.status, 'RESOLVED'); assert.ok(recovered.acknowledged_at);
  });
});
