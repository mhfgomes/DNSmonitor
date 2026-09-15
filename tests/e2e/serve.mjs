import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import packet from 'dns-packet';
import { databasePool } from '../../dist/packages/database/src/connection.js';
import { migrate } from '../../dist/packages/database/src/migrations.js';
import { Repository } from '../../dist/packages/database/src/repository.js';
import { Retention } from '../../dist/packages/database/src/retention.js';
import { Auth } from '../../dist/packages/auth/src/index.js';

const url = process.env.INTEGRATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Browser tests require an explicit disposable _test database');
const pool = databasePool(url);
await migrate(pool);
for (const table of ['monitor_hourly', 'notification_deliveries', 'alert_rules', 'notification_channels', 'sessions', 'login_limits', 'audit_events', 'users', 'notification_jobs', 'dns_events', 'monitor_states', 'incidents', 'check_runs', 'monitors', 'resolvers', 'resolver_groups', 'workers']) await pool.query(`DELETE FROM ${table}`);
if (process.env.E2E_SETUP !== '1') await new Auth(pool).setAdmin('admin@example.test', 'browser-test-password');
const dns = createSocket('udp4');
dns.on('message', (bytes, remote) => {
  const request = packet.decode(bytes); const question = request.questions[0];
  const data = { A: '192.0.2.10', AAAA: '2001:db8::10', CNAME: 'edge.example.test', MX: { preference: 10, exchange: 'mail.example.test' }, TXT: [Buffer.from('v=spf1 -all')] }[question.type];
  dns.send(packet.encode({ ...request, type: 'response', answers: data ? [{ name: question.name, type: question.type, ttl: 300, data }] : [] }), remote.port, remote.address);
});
await new Promise(resolve => dns.bind(15354, '127.0.0.1', resolve));
const webhook = createServer((request, response) => { request.resume(); request.on('end', () => response.end('ok')); });
await new Promise(resolve => webhook.listen(14001, '127.0.0.1', resolve));
const repository = new Repository(pool);
for (const [name, hostname, type, mode, expected] of [
  ['Public website', 'www.example.test', 'A', 'WATCH'],
  ['Production API', 'api.example.test', 'A', 'EXPECTED', ['192.0.2.10']],
  ['Mail routing', 'example.test', 'MX', 'WATCH'],
  ['Domain policy', 'example.test', 'TXT', 'EXPECTED', ['v=spf1 -all']],
  ['IPv6 edge', 'edge.example.test', 'AAAA', 'WATCH'],
  ['Application alias', 'app.example.test', 'CNAME', 'EXPECTED', ['edge.example.test']],
  ['Internal gateway', 'gateway.internal.test', 'A', 'EXPECTED', ['192.0.2.25']],
  ['Staging website', 'staging.example.test', 'A', 'WATCH'],
]) {
  const id = await repository.createMonitor({ name, config: { hostname, recordType: type, mode, ...(expected ? { expected, match: 'EXACT' } : {}), intervalSeconds: 300, timeoutMs: 1000, failureThreshold: 1, recoveryThreshold: 1, changeThreshold: 1, resolverIds: ['Test resolver'] }, resolvers: [{ id: 'Test resolver', server: '127.0.0.1', port: 15354, protocol: 'UDP' }] }, false);
  if (name === 'Public website') {
    const claim = (await repository.claimDue('archive-fixture', 1))[0];
    await repository.complete(claim, [{ resolverId: 'Test resolver', status: 'SUCCESS', answers: ['192.0.2.10'], latencyMs: 12, queriedAt: new Date().toISOString() }]);
    await pool.query('UPDATE check_runs SET started_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY), finished_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY) WHERE id = ?', [claim.token]);
  }
  if (name === 'Staging website') await repository.setEnabled(id, false);
}
await pool.query("UPDATE maintenance SET next_run_at = CURRENT_TIMESTAMP() WHERE name = 'retention'");
await new Retention(pool).sweep();
await pool.end();
const child = spawn(process.execPath, ['dist/apps/api/src/main.js'], { env: { ...process.env, DATABASE_URL: url, DATABASE_URL_FILE: '', ENCRYPTION_KEY: 'a'.repeat(64), ENCRYPTION_KEY_FILE: '', PUBLIC_URL: 'http://127.0.0.1:13000', COOKIE_SECURE: 'false', SETUP_TOKEN: process.env.E2E_SETUP === '1' ? 'browser-installation-token-1234567890' : '', SETUP_TOKEN_FILE: '', RUNTIME_ROLE: 'all', API_PORT: '13000' }, stdio: 'inherit' });
const stop = () => child.kill('SIGTERM');
process.once('SIGTERM', stop); process.once('SIGINT', stop);
child.once('exit', code => { dns.close(); webhook.close(); process.exitCode = code ?? 1; });
