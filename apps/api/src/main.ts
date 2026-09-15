import { Operations } from '../../../packages/database/src/operations.js';
import { metricsServer } from './metrics.js';
import { bootstrap } from '../../cli/src/bootstrap.js';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { databasePool, errorCode, secret } from '../../../packages/database/src/connection.js';
import { requireSchema } from '../../../packages/database/src/migrations.js';
import { Retention, retentionConfig } from '../../../packages/database/src/retention.js';
import { Repository } from '../../../packages/database/src/repository.js';
import { encryptionKey } from '../../../packages/notifications/src/config.js';
import { Notifications } from '../../../packages/notifications/src/service.js';
import { Worker } from '../../worker/src/worker.js';
import { createApi } from './server.js';

const shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());
process.once('SIGINT', () => shutdown.abort());
let pool: ReturnType<typeof databasePool> | undefined;
let api: FastifyInstance | undefined;
let health: ReturnType<typeof createServer> | undefined;
let metrics: ReturnType<typeof metricsServer> | undefined;
const tasks: Promise<void>[] = [];
try {
  const role = process.env.RUNTIME_ROLE ?? 'all';
  if (!['all', 'api', 'worker'].includes(role)) throw new Error('Invalid runtime role');
  const retention = retentionConfig();
  const key = encryptionKey(secret('ENCRYPTION_KEY'));
  if (process.env.RUN_MIGRATIONS !== undefined && !['true', 'false'].includes(process.env.RUN_MIGRATIONS)) throw new Error('Invalid RUN_MIGRATIONS');
  if (process.env.RUN_MIGRATIONS === 'true') await bootstrap('migrate', shutdown.signal, Number(process.env.BOOTSTRAP_TIMEOUT_SECONDS ?? 300));
  pool = databasePool();
  await requireSchema(pool);
  let worker: Worker | undefined;
  if (role !== 'api') {
    worker = new Worker(new Repository(pool), { id: process.env.WORKER_ID ?? randomUUID(), concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) });
    tasks.push(worker.run(shutdown.signal), new Notifications(pool, key).run(shutdown.signal), new Retention(pool, retention).run(shutdown.signal));
  }
  if (role !== 'worker') {
    const operations = new Operations(pool);
    if (process.env.METRICS_ENABLED !== undefined && !['true','false'].includes(process.env.METRICS_ENABLED)) throw new Error('Invalid METRICS_ENABLED');
    if (process.env.METRICS_ENABLED !== 'false') {
      const port = Number(process.env.METRICS_PORT ?? 3002);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid METRICS_PORT');
      metrics = metricsServer(operations);
      await new Promise<void>((resolve, reject) => { metrics!.once('error',reject); metrics!.listen(port,process.env.METRICS_HOST ?? '127.0.0.1',resolve); });
    }
    api = await createApi(pool, { key, operations, secureCookies: process.env.COOKIE_SECURE !== 'false', origin: process.env.PUBLIC_URL ?? 'http://localhost:3000', ready: () => !shutdown.signal.aborted && (!worker || worker.ready) });
    await api.listen({ host: '0.0.0.0', port: Number(process.env.API_PORT ?? 3000) });
    console.log(JSON.stringify({ event: 'api_started', role }));
  } else {
    health = createServer((request, response) => {
      const exists = ['/health/live', '/health/ready'].includes(request.url ?? '');
      const ready = request.url === '/health/live' || worker!.ready;
      response.writeHead(!exists ? 404 : ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: !exists ? 'not_found' : ready ? 'ok' : 'not_ready' }));
    });
    await new Promise<void>((resolve, reject) => { health!.once('error', reject); health!.listen(Number(process.env.HEALTH_PORT ?? 3001), '0.0.0.0', resolve); });
  }
  if (!shutdown.signal.aborted) await new Promise<void>(resolve => shutdown.signal.addEventListener('abort', () => resolve(), { once: true }));
} catch (error) {
  console.error(JSON.stringify({ event: 'application_fatal', code: errorCode(error) }));
  process.exitCode = 1;
} finally {
  shutdown.abort();
  metrics?.close(); metrics?.closeAllConnections();
  await api?.close();
  health?.close(); health?.closeAllConnections();
  await Promise.allSettled(tasks);
  await pool?.end();
}
