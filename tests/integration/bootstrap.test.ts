import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootstrap } from '../../apps/cli/src/bootstrap.js';
import { databasePool } from '../../packages/database/src/connection.js';

const url = process.env.INTEGRATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Use a disposable _test database');

test('orchestrator bootstrap serializes migrations and verifies schema', async t => {
  const previous = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  t.after(() => { if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous; });
  await Promise.all([bootstrap('migrate', new AbortController().signal), bootstrap('migrate', new AbortController().signal)]);
  await bootstrap('wait', new AbortController().signal);
  const pool = databasePool(url);
  try { assert.equal((await pool.query('SELECT COUNT(*) AS count FROM schema_migrations'))[0].count, 6); }
  finally { await pool.end(); }
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(bootstrap('migrate', cancelled.signal), /cancelled/);
  await assert.rejects(bootstrap('wait', new AbortController().signal, 0), /timeout/);
});
