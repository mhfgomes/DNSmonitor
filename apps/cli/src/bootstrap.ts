import { setTimeout as sleep } from 'node:timers/promises';
import { databasePool, errorCode } from '../../../packages/database/src/connection.js';
import { migrate, requireSchema } from '../../../packages/database/src/migrations.js';

/** Wait for dependencies without relying on orchestrator startup ordering. */
export async function bootstrap(mode: 'migrate' | 'wait', signal: AbortSignal, timeoutSeconds = 300): Promise<void> {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error('Invalid bootstrap timeout');
  const pool = databasePool(undefined, 1);
  const deadline = Date.now() + timeoutSeconds * 1000;
  try {
    while (!signal.aborted) {
      try {
        if (mode === 'wait') await requireSchema(pool);
        else await pool.query('SELECT 1');
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await sleep(Math.min(2000, Math.max(1, deadline - Date.now())), undefined, { signal });
      }
    }
    if (signal.aborted) throw new Error('Bootstrap cancelled');
    // Only connectivity is retried. Migration/checksum/DDL failures remain visible.
    if (mode === 'migrate') await migrate(pool);
    console.log(JSON.stringify({ event: 'bootstrap_completed', mode }));
  } finally { await pool.end(); }
}
// This module is also imported by the combined Swarm process.
if (process.argv[1]?.endsWith('/bootstrap.js')) {
  const signal = new AbortController();
  process.once('SIGTERM', () => signal.abort()); process.once('SIGINT', () => signal.abort());
  const mode = process.argv[2];
  try {
    if (mode !== 'migrate' && mode !== 'wait') throw new Error('Use bootstrap migrate|wait');
    await bootstrap(mode, signal.signal, Number(process.env.BOOTSTRAP_TIMEOUT_SECONDS ?? 300));
  } catch (error) { console.error(JSON.stringify({ event: 'bootstrap_failed', code: errorCode(error) })); process.exitCode = 1; }
}
