import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { databasePool } from '../../packages/database/src/connection.js';
import { migrate } from '../../packages/database/src/migrations.js';
import { Repository } from '../../packages/database/src/repository.js';
import { Operations, prometheus } from '../../packages/database/src/operations.js';
import { Auth } from '../../packages/auth/src/index.js';
import { createApi } from '../../apps/api/src/server.js';
import { metricsServer } from '../../apps/api/src/metrics.js';
const url = process.env.INTEGRATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Use a disposable _test database');
const pool = databasePool(url);
test('operational snapshots, privacy and bounded metrics', async t => {
 t.after(() => pool.end()); await migrate(pool);
 for (const table of ['monitor_hourly','notification_deliveries','alert_rules','notification_channels','sessions','login_limits','audit_events','users','notification_jobs','dns_events','monitor_states','incidents','check_runs','monitors','resolvers','resolver_groups','workers']) await pool.query(`DELETE FROM ${table}`);
 await t.test('empty sample does not invent rates or successful retention', async () => {
  await pool.query("UPDATE maintenance SET last_completed_at=NULL WHERE name='retention'");
  const data = await new Operations(pool).snapshot();
  assert.equal(data.recent.timeoutRatio,null); assert.equal(data.recent.delayP95Seconds,null);
  assert.equal(data.retention.late,true); assert.equal(data.workers.online,0);
  assert.doesNotMatch(prometheus(data), /NaN|Infinity|dnsmonitor_recent_dns_timeout_ratio /);
 });
 const repository = new Repository(pool);
 const id = await repository.createMonitor({name:'Private hostname',config:{hostname:'secret.example.test',recordType:'A',mode:'WATCH',intervalSeconds:300,timeoutMs:1000,failureThreshold:2,recoveryThreshold:2,changeThreshold:2,resolverIds:['fixture']},resolvers:[{id:'fixture',server:'127.0.0.1',protocol:'UDP'}]},false);
 await t.test('expired heartbeats and overdue eligibility differ from active work', async () => {
  await repository.heartbeat('online-private-id',1);
  await repository.heartbeat('stale-private-id',0);
  await pool.query("UPDATE workers SET last_heartbeat=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 20 SECOND) WHERE id='stale-private-id'");
  await pool.query('UPDATE monitors SET next_check_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 60 SECOND)');
  let data = await new Operations(pool).snapshot();
  assert.equal(data.workers.online,1); assert.equal(data.workers.stale,1); assert.equal(data.monitors.overdue,1);
  await pool.query('UPDATE monitors SET lease_expires_at=DATE_ADD(CURRENT_TIMESTAMP(3),INTERVAL 30 SECOND)');
  assert.equal((await new Operations(pool).snapshot()).monitors.overdue,0);
  await pool.query('UPDATE monitors SET lease_expires_at=NULL');
  const claim = (await repository.claimDue('online-private-id',1))[0]!;
  await repository.complete(claim,[{resolverId:'fixture',status:'TIMEOUT',answers:[],latencyMs:1000,queriedAt:new Date().toISOString()}]);
  data = await new Operations(pool).snapshot();
  assert.equal(data.recent.queries,1); assert.equal(data.recent.timeoutRatio,1); assert.ok(data.recent.delayP95Seconds!>=60);
 });
 await t.test('scrapes share snapshots and expose no monitor or worker identifiers', async () => {
  const operations = new Operations(pool);
  const [a,b] = await Promise.all([operations.snapshot(),operations.snapshot()]);assert.equal(a,b);
  const metrics = prometheus(a);
  assert.match(metrics,/dnsmonitor_recent_dns_timeout_ratio 1\n/);
  assert.doesNotMatch(metrics,/secret\.example|private-id|Private hostname/);
  const server = metricsServer(operations);
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
   const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
   const response = await fetch(`${base}/metrics`);assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/version=0.0.4/);
   assert.equal((await fetch(`${base}/elsewhere`)).status,404);
   assert.equal((await fetch(`${base}/metrics`,{method:'POST'})).status,404);
  } finally { server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve())); }
 });
 await t.test('system API requires login and public web server has no metrics route', async () => {
  await new Auth(pool).setAdmin('operations@example.test','operations-test-password');
  const api = await createApi(pool,{key:randomBytes(32),origin:'http://localhost:3000'});
  try {
   assert.equal((await api.inject('/api/v1/operations')).statusCode,401);
   const login = await api.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'operations@example.test',password:'operations-test-password'}});
   const cookie = String(login.headers['set-cookie']).split(';')[0]!;
   assert.equal((await api.inject({url:'/api/v1/operations',headers:{cookie}})).statusCode,200);
   assert.equal((await api.inject({url:'/metrics',headers:{cookie}})).statusCode,404);
  } finally { await api.close(); }
 });
 await t.test('collection failure returns unavailable instead of false healthy metrics', async () => {
  const closed = databasePool(url); await closed.end();
  const server = metricsServer(new Operations(closed));
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try {
   const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/metrics`);
   assert.equal(response.status,503); assert.equal(await response.text(),'Metrics unavailable\n');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
 });
 await t.test('recent payload reads are capped and old history is excluded', async () => {
  await pool.query('UPDATE check_runs SET finished_at=DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 16 MINUTE)');
  assert.equal((await new Operations(pool).snapshot()).recent.checks,0);
  await pool.batch("INSERT INTO check_runs(id,monitor_id,worker_id,config_revision,scheduled_at,started_at,finished_at,status,resolver_results) VALUES (?,?,'fixture',1,CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),CURRENT_TIMESTAMP(3),'COMPLETED','[]')",Array.from({length:1001},()=>[randomUUID(),id]));
  const data = await new Operations(pool).snapshot();assert.equal(data.recent.checks,1000);assert.equal(data.recent.truncated,true);
 });
});
