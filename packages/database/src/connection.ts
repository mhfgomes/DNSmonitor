import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import mariadb, { type Pool, type PoolConnection } from 'mariadb';

export function secret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file && process.env[name]) throw new Error(`Set either ${name} or ${name}_FILE`);
  return file ? readFileSync(file, 'utf8').trim() : process.env[name];
}

export function databasePool(url = secret('DATABASE_URL'), connectionLimit = 4): Pool {
  const parsed = url ? new URL(url) : undefined;
  if (parsed && !['mysql:', 'mariadb:'].includes(parsed.protocol)) throw new Error('Invalid database URL protocol');
  if (parsed?.search) throw new Error('Database URL query parameters are not supported');
  if (parsed && !/^\/[a-zA-Z0-9_]+$/.test(parsed.pathname)) throw new Error('Database URL must name a database');
  const host = parsed?.hostname ?? process.env.DATABASE_HOST;
  if (!host) throw new Error('Set DATABASE_URL, DATABASE_URL_FILE, or DATABASE_HOST with database credentials');
  return mariadb.createPool({
    host, port: Number(parsed?.port || process.env.DATABASE_PORT || 3306),
    user: parsed ? decodeURIComponent(parsed.username) : process.env.DATABASE_USER ?? 'dnsmonitor',
    password: parsed ? decodeURIComponent(parsed.password) : secret('DATABASE_PASSWORD'),
    database: parsed ? parsed.pathname.slice(1) : process.env.DATABASE_NAME ?? 'dnsmonitor', connectionLimit,
    timezone: '+00:00', autoJsonMap: false, bigIntAsNumber: true,
    connectTimeout: 5000, acquireTimeout: 10000, queryTimeout: 10000,
    sessionVariables: { innodb_lock_wait_timeout: 5, tx_isolation: 'READ-COMMITTED' },
  });
}

export async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      // Retry only known rolled-back transactions, never ambiguous commits or
      // network errors. Callbacks must contain database work only.
      if (attempt >= 2 || !['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(errorCode(error))) throw error;
    } finally { await connection.release(); }
    await sleep(10 * (attempt + 1));
  }
}

export async function databaseTime(connection: PoolConnection): Promise<Date> {
  const rows = await connection.query<{ now: Date }[]>('SELECT CURRENT_TIMESTAMP(3) AS now');
  return rows[0]!.now;
}

export function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : 'INTERNAL_ERROR';
}
