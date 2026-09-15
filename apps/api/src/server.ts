import { versionInfo } from './version.js';
import { Operations } from '../../../packages/database/src/operations.js';
import { retentionConfig } from '../../../packages/database/src/retention.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import staticFiles from '@fastify/static';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import type { Pool } from 'mariadb';
import { Auth, AuthError, equalToken, emailSchema, passwordSchema, type Session } from '../../../packages/auth/src/index.js';
import { Repository, RevisionConflict, validateInput, type MonitorInput } from '../../../packages/database/src/repository.js';
import { errorCode, secret } from '../../../packages/database/src/connection.js';
import { Notifications } from '../../../packages/notifications/src/service.js';
import { channelConfig, ruleConfig } from '../../../packages/notifications/src/config.js';
import { DeliveryError } from '../../../packages/notifications/src/transport.js';

declare module 'fastify' { interface FastifyRequest { session?: Session } }
const page = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).max(100000).default(0) });
const idParams = z.object({ id: z.uuid() });
const named = { name: z.string().trim().min(1).max(200) };

export async function createApi(pool: Pool, options: { key: Buffer; secureCookies?: boolean; origin: string; ready?: () => boolean; operations?: Operations }) {
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024, requestTimeout: 15000, trustProxy: false });
  const setupToken = secret('SETUP_TOKEN') || undefined;
  if (setupToken !== undefined && (setupToken.length < 32 || setupToken.length > 256)) throw new Error('SETUP_TOKEN must contain 32 to 256 characters');
  const operations = options.operations ?? new Operations(pool);
  const auth = new Auth(pool);
  const repository = new Repository(pool);
  const notifications = new Notifications(pool, options.key);
  const origin = new URL(options.origin).origin;
  await app.register(cookie);
  app.decorateRequest('session', undefined);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');
    const path = request.url.split('?')[0];
    if (['GET', 'HEAD'].includes(request.method) && (path === '/' || path?.startsWith('/assets/'))) return;
    if (path === '/health/live' || path === '/health/ready') return;
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send({ error: 'Origin not allowed' });
    if (path === '/api/v1/auth/login' && request.method === 'POST') return;
    if (path === '/api/v1/auth/setup' && ['GET','POST'].includes(request.method)) return;
    request.session = await auth.session(request.cookies.dnsmonitor_session);
    if (!request.session) return reply.code(401).send({ error: 'Authentication required' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (request.session.role !== 'ADMIN' && !['/api/v1/auth/logout','/api/v1/auth/password'].includes(path ?? '')) return reply.code(403).send({ error: 'Admin access required' });
      if (!equalToken(request.headers['x-csrf-token'], request.session.csrfToken)) return reply.code(403).send({ error: 'Invalid CSRF token' });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', fields: error.issues.map(issue => issue.path.join('.')) });
    if (error instanceof RevisionConflict) return reply.code(409).send({ error: error.message });
    if (error instanceof AuthError) return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof DeliveryError) return reply.code(502).send({ error: error.code });
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({ error: 'Invalid request' });
    if (error instanceof Error && !('sql' in error) && /^(Monitor not found|Channel not found|Rule not found)/.test(error.message)) return reply.code(404).send({ error: error.message });
    if (error instanceof Error && !('sql' in error) && /^(Invalid |Use 1|Resolver |EXPECTED |Monitor missing|Delivery not failed)/.test(error.message)) return reply.code(400).send({ error: error.message });
    console.error(JSON.stringify({ event: 'api_error', requestId: request.id, code: errorCode(error) }));
    return reply.code(500).send({ error: 'Internal server error', requestId: request.id });
  });
  const audit = async (session: Session, action: string, entityId?: string) => {
    // Audit persistence failure must not turn a committed mutation into a retryable
    // 500. Log it explicitly without secrets; domain writes retain their own transactions.
    try { await pool.query('INSERT INTO audit_events (id, user_id, action, entity_id) VALUES (?, ?, ?, ?)', [randomUUID(), session.userId, action, entityId ?? null]); }
    catch (error) { console.error(JSON.stringify({ event: 'audit_write_failed', action, code: errorCode(error) })); }
  };

  app.get('/api/v1/version', async () => versionInfo);
  app.get('/api/v1/operations', async () => operations.snapshot());
  app.get('/health/live', async () => ({ status: 'ok' }));
  const webRoot = resolve('dist/web');
  if (existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(staticFiles, { root: resolve(webRoot, 'assets'), prefix: '/assets/' });
    app.get('/', async (_, reply) => {
      reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return reply.sendFile('index.html', webRoot);
    });
  }
  app.get('/health/ready', async (_, reply) => {
    try { await pool.query('SELECT 1'); if (options.ready && !options.ready()) throw new Error('Not ready'); return { status: 'ok' }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.get('/api/v1/auth/setup', async () => ({ required: await auth.setupRequired(), enabled: Boolean(setupToken) }));
  app.post('/api/v1/auth/setup', async (request, reply) => {
    const body = z.object({ email: emailSchema, password: passwordSchema, token: z.string().max(256) }).strict().parse(request.body);
    await auth.setup(body.email, body.password, body.token, setupToken, request.ip);
    return reply.code(201).send({ created: true });
  });
  app.post('/api/v1/auth/password', async (request, reply) => {
    const body = z.object({ currentPassword: z.string().min(1).max(256), newPassword: passwordSchema }).strict().parse(request.body);
    await auth.changePassword(request.session!, body.currentPassword, body.newPassword, request.ip);
    reply.clearCookie('dnsmonitor_session', { path: '/', secure: options.secureCookies ?? true, httpOnly: true, sameSite: 'strict' });
    return reply.code(204).send();
  });
  app.post('/api/v1/auth/login', async (request, reply) => {
    const body = z.object({ email: emailSchema, password: z.string().min(1).max(256) }).strict().parse(request.body);
    const result = await auth.login(body.email, body.password, request.ip);
    if (!result) return reply.code(401).send({ error: 'Invalid email or password' });
    reply.setCookie('dnsmonitor_session', result.token, { httpOnly: true, secure: options.secureCookies ?? true, sameSite: 'strict', path: '/', maxAge: 43200 });
    return { email: result.session.email, role: result.session.role, csrfToken: result.session.csrfToken };
  });
  app.get('/api/v1/auth/session', async request => ({ email: request.session!.email, role: request.session!.role, csrfToken: request.session!.csrfToken }));
  app.post('/api/v1/auth/logout', async (request, reply) => {
    await auth.logout(request.session!);
    reply.clearCookie('dnsmonitor_session', { path: '/', secure: options.secureCookies ?? true, httpOnly: true, sameSite: 'strict' });
    return reply.code(204).send();
  });
  app.get('/api/v1/monitors', async request => {
    const { limit, offset, search, mode } = page.extend({ search: z.string().max(100).optional(), mode: z.enum(['WATCH', 'EXPECTED']).optional() }).parse(request.query);
    return { items: await repository.list(limit, offset, { search, mode }), total: await repository.count({ search, mode }), limit, offset };
  });
  app.get('/api/v1/dashboard', async () => {
    const rows = await pool.query<{ status: string; count: number }[]>(`SELECT CASE WHEN m.enabled = FALSE THEN 'PAUSED' ELSE JSON_UNQUOTE(JSON_EXTRACT(s.state, '$.status')) END AS status, COUNT(*) AS count
      FROM monitors m JOIN monitor_states s ON s.monitor_id = m.id GROUP BY status`);
    const states = Object.fromEntries(rows.map(row => [row.status, row.count]));
    const events = await pool.query<{ payload: string }[]>(`SELECT e.*, m.name AS monitor_name FROM dns_events e JOIN monitors m ON m.id = e.monitor_id ORDER BY e.created_at DESC, e.id LIMIT 10`);
    const workers = await pool.query<{ online: number; total: number }[]>("SELECT COALESCE(SUM(status = 'ONLINE' AND last_heartbeat > DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 15 SECOND)), 0) AS online, COUNT(*) AS total FROM workers");
    return { total: rows.reduce((sum, row) => sum + row.count, 0), states, workers: workers[0], recentEvents: events.map(event => ({ ...event, payload: JSON.parse(event.payload) })) };
  });
  app.post('/api/v1/monitors', async (request, reply) => {
    const input = z.object({ ...named, config: z.unknown(), resolvers: z.array(z.unknown()).min(1).max(16) }).strict().parse(request.body) as MonitorInput;
    validateInput(input);
    const id = await repository.createMonitor(input);
    await audit(request.session!, 'MONITOR_CREATED', id);
    return reply.code(201).send({ id });
  });
  app.get('/api/v1/retention', async () => {
    const rows = await pool.query("SELECT next_run_at, last_completed_at, last_result FROM maintenance WHERE name = 'retention'");
    const tables = await pool.query(`SELECT TABLE_NAME AS name, TABLE_ROWS AS approximateRows, DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`);
    return { config: retentionConfig(), ...rows[0], last_result: rows[0]?.last_result ? JSON.parse(rows[0].last_result) : null, storage: { approximate: true, tables } };
  });
  app.get('/api/v1/monitors/:id/hourly', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    const { limit, offset } = page.parse(request.query);
    if (!(await pool.query('SELECT id FROM monitors WHERE id = ?', [id])).length) return reply.code(404).send({ error: 'Monitor not found' });
    const items = await pool.query(`SELECT monitor_id, hour_at, config_revision, checks, completed, healthy, warning, critical, unknown_count, errors, abandoned,
      latency_sum / NULLIF(latency_count, 0) AS averageLatencyMs, IF(latency_count > 0, latency_max, NULL) AS maxLatencyMs
      FROM monitor_hourly WHERE monitor_id = ? ORDER BY hour_at DESC, config_revision DESC LIMIT ? OFFSET ?`, [id, limit, offset]);
    return { items, limit, offset };
  });
  app.get('/api/v1/monitors/:id', async request => repository.inspect(idParams.parse(request.params).id));
  app.put('/api/v1/monitors/:id', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    const { revision, ...input } = z.object({ ...named, config: z.unknown(), resolvers: z.array(z.unknown()).min(1).max(16), revision: z.number().int().positive() }).strict().parse(request.body);
    await repository.updateMonitor(id, input as MonitorInput, revision); await audit(request.session!, 'MONITOR_UPDATED', id);
    return reply.send({ id });
  });
  app.delete('/api/v1/monitors/:id', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    const { revision, confirmName } = z.object({ revision: z.number().int().positive(), confirmName: z.string() }).strict().parse(request.body);
    const monitor = await repository.inspect(id);
    if (monitor.configRevision !== revision) throw new RevisionConflict();
    if (confirmName !== monitor.name) return reply.code(400).send({ error: 'Enter the monitor name to confirm deletion.' });
    await repository.deleteMonitor(id, revision); await audit(request.session!, 'MONITOR_DELETED', id);
    return reply.code(204).send();
  });
  app.patch('/api/v1/monitors/:id', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    const threshold = z.number().int().min(1).max(1000).optional();
    const changes = z.object({ intervalSeconds: z.number().int().min(1).max(604800).optional(), timeoutMs: z.number().int().min(1).max(60000).optional(), failureThreshold: threshold, recoveryThreshold: threshold, changeThreshold: threshold }).strict().refine(value => Object.keys(value).length > 0).parse(request.body);
    await repository.updateTiming(id, changes); await audit(request.session!, 'MONITOR_TIMING_UPDATED', id);
    return reply.code(204).send();
  });
  for (const action of ['pause', 'resume', 'check'] as const) app.post(`/api/v1/monitors/:id/${action}`, async (request, reply) => {
    const id = idParams.parse(request.params).id;
    if (action === 'check') await repository.checkNow(id); else await repository.setEnabled(id, action === 'resume');
    await audit(request.session!, `MONITOR_${action.toUpperCase()}`, id);
    return reply.code(202).send({ id });
  });
  app.get('/api/v1/incidents', async request => {
    const { limit, offset, status = '' } = page.extend({ status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED']).optional() }).parse(request.query);
    const rows = await pool.query<{ initial_value: string | null; current_value: string | null }[]>('SELECT i.*, m.name AS monitor_name FROM incidents i JOIN monitors m ON m.id = i.monitor_id WHERE (? = \'\' OR i.status = ?) ORDER BY i.opened_at DESC, i.id LIMIT ? OFFSET ?', [status, status, limit, offset]);
    return { items: rows.map(row => ({ ...row, initial_value: row.initial_value ? JSON.parse(row.initial_value) : null, current_value: row.current_value ? JSON.parse(row.current_value) : null })), limit, offset };
  });
  app.post('/api/v1/incidents/:id/acknowledge', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    const result = await pool.query("UPDATE incidents SET status = 'ACKNOWLEDGED', acknowledged_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'OPEN'", [id]);
    if (result.affectedRows !== 1) return reply.code(409).send({ error: 'Incident is not open' });
    await audit(request.session!, 'INCIDENT_ACKNOWLEDGED', id);
    return reply.code(204).send();
  });
  app.get('/api/v1/notification-channels', async () => ({ items: await notifications.channels() }));
  app.post('/api/v1/notification-channels', async (request, reply) => {
    const body = z.object({ ...named, config: channelConfig }).strict().parse(request.body);
    const id = await notifications.createChannel(body.name, body.config); await audit(request.session!, 'CHANNEL_CREATED', id);
    return reply.code(201).send({ id });
  });
  app.patch('/api/v1/notification-channels/:id', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    await notifications.setChannelEnabled(id, z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled);
    await audit(request.session!, 'CHANNEL_ENABLED_CHANGED', id); return reply.code(204).send();
  });
  app.post('/api/v1/notification-channels/:id/test', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    await notifications.testChannel(id); await audit(request.session!, 'CHANNEL_TESTED', id); return reply.code(204).send();
  });
  app.get('/api/v1/alert-rules', async () => ({ items: await notifications.rules() }));
  app.post('/api/v1/alert-rules', async (request, reply) => {
    const body = z.object({ ...named, config: ruleConfig }).strict().parse(request.body);
    const id = await notifications.createRule(body.name, body.config); await audit(request.session!, 'RULE_CREATED', id);
    return reply.code(201).send({ id });
  });
  app.patch('/api/v1/alert-rules/:id', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    await notifications.setRuleEnabled(id, z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled);
    await audit(request.session!, 'RULE_ENABLED_CHANGED', id); return reply.code(204).send();
  });
  app.get('/api/v1/notification-deliveries', async request => {
    const { limit, offset } = page.parse(request.query);
    return { items: await pool.query('SELECT id, job_id, channel_id, status, attempts, next_attempt_at, last_error, sent_at FROM notification_deliveries ORDER BY next_attempt_at DESC, id LIMIT ? OFFSET ?', [limit, offset]), limit, offset };
  });
  app.post('/api/v1/notification-deliveries/:id/retry', async (request, reply) => {
    const id = idParams.parse(request.params).id;
    await notifications.retry(id); await audit(request.session!, 'DELIVERY_RETRIED', id); return reply.code(202).send({ id });
  });
  const cleanup = setInterval(() => { void auth.cleanup().catch(error => console.error(JSON.stringify({ event: 'auth_cleanup_error', code: errorCode(error) }))); }, 60000);
  cleanup.unref();
  app.addHook('onClose', async () => { clearInterval(cleanup); });
  return app;
}
