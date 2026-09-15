import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { databasePool } from '../../packages/database/src/connection.js';
import { migrate } from '../../packages/database/src/migrations.js';
import { Auth } from '../../packages/auth/src/index.js';
import { createApi } from '../../apps/api/src/server.js';
const url=process.env.INTEGRATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Use a disposable _test database');
const pool=databasePool(url);const token='test-only-installation-token-1234567890';
test('first administrator and self-service passwords',async t=>{
 t.after(()=>pool.end());await migrate(pool);
 for(const table of ['monitor_hourly','notification_deliveries','alert_rules','notification_channels','sessions','login_limits','audit_events','users','notification_jobs','dns_events','monitor_states','incidents','check_runs','monitors','resolvers','resolver_groups','workers']) await pool.query(`DELETE FROM ${table}`);
 const previous=process.env.SETUP_TOKEN;process.env.SETUP_TOKEN=token;
 t.after(()=>{if(previous===undefined)delete process.env.SETUP_TOKEN;else process.env.SETUP_TOKEN=previous;});
 const app=await createApi(pool,{key:randomBytes(32),origin:'http://localhost:3000'});t.after(()=>app.close());
 const setup={email:'owner@example.test',password:'initial-owner-password',token};
 await t.test('first setup requires owner proof and rejects cross-origin requests',async()=>{
  assert.deepEqual((await app.inject('/api/v1/auth/setup')).json(),{required:true,enabled:true});
  assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/setup',payload:{...setup,token:'wrong'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/setup',headers:{origin:'https://other.example'},payload:setup})).statusCode,403);
  assert.equal((await pool.query('SELECT COUNT(*) AS n FROM users'))[0].n,0);
 });
 await t.test('concurrent setup across API replicas creates only one administrator',async()=>{
  const second=await createApi(pool,{key:randomBytes(32),origin:'http://localhost:3000'});
  try{
   const results=await Promise.all([app.inject({method:'POST',url:'/api/v1/auth/setup',payload:setup}),second.inject({method:'POST',url:'/api/v1/auth/setup',payload:{...setup,email:'second@example.test'}})]);
   assert.deepEqual(results.map(r=>r.statusCode).sort(),[201,409]);
   assert.equal((await pool.query('SELECT COUNT(*) AS n FROM users'))[0].n,1);
   assert.equal((await app.inject('/api/v1/auth/setup')).json().required,false);
   assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/setup',payload:setup})).statusCode,409);
  }finally{await second.close();}
 });
 const email=(await pool.query('SELECT email FROM users'))[0].email;
 const login=()=>app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email,password:setup.password}});
 const first=await login();const second=await login();
 const cookie=String(first.headers['set-cookie']).split(';')[0]!;
 const otherCookie=String(second.headers['set-cookie']).split(';')[0]!;
 const headers={cookie,'x-csrf-token':first.json().csrfToken};
 await t.test('changing a password requires CSRF and the current password',async()=>{
  assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/password',headers:{cookie},payload:{currentPassword:setup.password,newPassword:'replacement-owner-password'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/password',headers,payload:{currentPassword:'incorrect-password',newPassword:'replacement-owner-password'}})).statusCode,400);
  assert.equal((await app.inject({url:'/api/v1/auth/session',headers:{cookie}})).statusCode,200);
 });
 await t.test('viewers can change their own password and every old session is revoked',async()=>{
  await pool.query("UPDATE users SET role='VIEWER'");
  const changed=await app.inject({method:'POST',url:'/api/v1/auth/password',headers,payload:{currentPassword:setup.password,newPassword:'replacement-owner-password'}});
  assert.equal(changed.statusCode,204);
  for(const sessionCookie of [cookie,otherCookie])assert.equal((await app.inject({url:'/api/v1/auth/session',headers:{cookie:sessionCookie}})).statusCode,401);
  assert.equal((await login()).statusCode,401);
  assert.ok(await new Auth(pool).login(email,'replacement-owner-password','fixture'));
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM audit_events WHERE action='PASSWORD_CHANGED'"))[0].n,1);
 });
});
