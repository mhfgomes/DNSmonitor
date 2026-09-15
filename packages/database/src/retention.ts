import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool, PoolConnection } from 'mariadb';
import { databaseTime, errorCode, transaction } from './connection.js';

export interface RetentionConfig {
  enabled: boolean; checkHours: number; summaryDays: number; eventDays: number;
  incidentDays: number; deliveryDays: number; auditDays: number; batchSize: number; intervalSeconds: number;
}
export function retentionConfig(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const number = (key: string, fallback: number, max: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  if (env.RETENTION_ENABLED !== undefined && !['true', 'false'].includes(env.RETENTION_ENABLED)) throw new Error('Invalid RETENTION_ENABLED');
  const config = {
    enabled: env.RETENTION_ENABLED !== 'false',
    checkHours: number('RETENTION_CHECK_HOURS', 24, 87600),
    summaryDays: number('RETENTION_SUMMARY_DAYS', 90, 3650),
    eventDays: number('RETENTION_EVENT_DAYS', 30, 3650),
    incidentDays: number('RETENTION_INCIDENT_DAYS', 90, 3650),
    deliveryDays: number('RETENTION_DELIVERY_DAYS', 30, 3650),
    auditDays: number('RETENTION_AUDIT_DAYS', 90, 3650),
    batchSize: number('RETENTION_BATCH_SIZE', 250, 1000),
    intervalSeconds: number('RETENTION_INTERVAL_SECONDS', 60, 3600),
  };
  if (config.summaryDays * 24 <= config.checkHours) throw new Error('Summary retention must exceed detailed check retention');
  return config;
}
interface CheckRow { id: string; monitor_id: string; config_revision: number; started_at: Date; status: string; observation: string | null; resolver_results: string | null }
interface Summary { monitor: string; hour: Date; revision: number; checks: number; completed: number; healthy: number; warning: number; critical: number; unknown: number; errors: number; abandoned: number; sum: number; samples: number; max: number }
const before = (now: Date, days: number) => new Date(now.getTime() - days * 86400000);

export class Retention {
  constructor(readonly pool: Pool, readonly config = retentionConfig()) {}

  /** Rollups and raw deletion share a transaction: a crash can never count a check twice. */
  async sweep(): Promise<Record<string, number> | null> {
    if (!this.config.enabled) return null;
    return transaction(this.pool, async connection => {
      const now = await databaseTime(connection);
      const lease = await connection.query("SELECT name FROM maintenance WHERE name = 'retention' AND next_run_at <= ? FOR UPDATE SKIP LOCKED", [now]);
      if (!lease.length) return null;
      const { batchSize: limit } = this.config;
      const counts: Record<string, number> = {};
      // RUNNING checks have no finished_at and must be recovered by the scheduler.
      const rows = await connection.query<CheckRow[]>(`SELECT id, monitor_id, config_revision, started_at, status, observation, resolver_results
        FROM check_runs FORCE INDEX (retention) WHERE finished_at < ? AND status IN ('COMPLETED', 'ERROR', 'ABANDONED')
        ORDER BY finished_at, id LIMIT ? FOR UPDATE`, [before(now, this.config.checkHours / 24), limit]);
      const summaries = new Map<string, Summary>();
      for (const row of rows) {
        const hour = new Date(row.started_at); hour.setUTCMinutes(0, 0, 0);
        // Very old backlog is outside the summary window too.
        if (hour < before(now, this.config.summaryDays)) continue;
        const key = `${row.monitor_id}/${hour.toISOString()}/${row.config_revision}`;
        const summary = summaries.get(key) ?? { monitor: row.monitor_id, hour, revision: row.config_revision, checks: 0, completed: 0, healthy: 0, warning: 0, critical: 0, unknown: 0, errors: 0, abandoned: 0, sum: 0, samples: 0, max: 0 };
        summary.checks++;
        if (row.status === 'COMPLETED') {
          summary.completed++;
          const status = row.observation ? (JSON.parse(row.observation) as { status?: string }).status : undefined;
          if (status === 'HEALTHY') summary.healthy++;
          else if (status === 'WARNING') summary.warning++;
          else if (status === 'CRITICAL') summary.critical++;
          else summary.unknown++; // Legacy observations cannot be re-evaluated with today's config.
          const results = row.resolver_results ? JSON.parse(row.resolver_results) as { status: string; latencyMs: number }[] : [];
          for (const result of results) if (result.status === 'SUCCESS' && Number.isFinite(result.latencyMs) && result.latencyMs >= 0) {
            summary.sum += result.latencyMs; summary.samples++; summary.max = Math.max(summary.max, result.latencyMs);
          }
        } else if (row.status === 'ERROR') summary.errors++;
        else summary.abandoned++;
        summaries.set(key, summary);
      }
      for (const s of summaries.values()) await connection.query(`INSERT INTO monitor_hourly
        (monitor_id, hour_at, config_revision, checks, completed, healthy, warning, critical, unknown_count, errors, abandoned, latency_sum, latency_count, latency_max)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE checks=checks+VALUES(checks), completed=completed+VALUES(completed), healthy=healthy+VALUES(healthy),
        warning=warning+VALUES(warning), critical=critical+VALUES(critical), unknown_count=unknown_count+VALUES(unknown_count),
        errors=errors+VALUES(errors), abandoned=abandoned+VALUES(abandoned), latency_sum=latency_sum+VALUES(latency_sum),
        latency_count=latency_count+VALUES(latency_count), latency_max=GREATEST(latency_max, VALUES(latency_max))`,
      [s.monitor, s.hour, s.revision, s.checks, s.completed, s.healthy, s.warning, s.critical, s.unknown, s.errors, s.abandoned, s.sum, s.samples, s.max]);
      counts.checks = await removeIds(connection, 'check_runs', rows.map(row => row.id));
      counts.summaryBuckets = summaries.size;
      const prune = async (table: string, where: string, params: unknown[]) => {
        const result = await connection.query(`DELETE FROM ${table} WHERE ${where} LIMIT ?`, [...params, limit]);
        counts[table] = result.affectedRows;
      };
      await prune('monitor_hourly', 'hour_at < ?', [before(now, this.config.summaryDays)]);
      // Lock only terminal deliveries. Retry changes the row back to PENDING, which is protected.
      await prune('notification_deliveries', "status IN ('SENT', 'CANCELLED', 'FAILED') AND COALESCE(sent_at, next_attempt_at) < ?", [before(now, this.config.deliveryDays)]);
      await prune('notification_jobs', "status IN ('ROUTED', 'IGNORED', 'CANCELLED') AND created_at < ? AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.job_id = notification_jobs.id)", [before(now, this.config.deliveryDays)]);
      await prune('dns_events', `created_at < ? AND NOT EXISTS (SELECT 1 FROM notification_jobs j WHERE j.event_id = dns_events.id)
        AND (incident_id IS NULL OR EXISTS (SELECT 1 FROM incidents i WHERE i.id = dns_events.incident_id AND i.status = 'RESOLVED'))`, [before(now, this.config.eventDays)]);
      await prune('incidents', `status = 'RESOLVED' AND resolved_at < ? AND NOT EXISTS (SELECT 1 FROM dns_events e WHERE e.incident_id = incidents.id)
        AND NOT EXISTS (SELECT 1 FROM monitor_states s WHERE s.active_incident_id = incidents.id)`, [before(now, this.config.incidentDays)]);
      await prune('audit_events', 'created_at < ?', [before(now, this.config.auditDays)]);
      await prune('sessions', 'expires_at < ?', [now]);
      await prune('login_limits', 'expires_at < ?', [now]);
      await prune('workers', 'last_heartbeat < ?', [before(now, 7)]);
      await connection.query("UPDATE maintenance SET next_run_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND), last_completed_at = CURRENT_TIMESTAMP(3), last_result = ? WHERE name = 'retention'", [this.config.intervalSeconds, JSON.stringify(counts)]);
      return counts;
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.config.enabled) return;
    while (!signal.aborted) {
      try { const counts = await this.sweep(); if (counts) console.log(JSON.stringify({ event: 'retention_completed', ...counts })); }
      catch (error) { console.error(JSON.stringify({ event: 'retention_error', code: errorCode(error) })); }
      await sleep(this.config.intervalSeconds * 1000, undefined, { signal }).catch(() => undefined);
    }
  }
}
async function removeIds(connection: PoolConnection, table: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const result = await connection.query(`DELETE FROM ${table} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  return result.affectedRows;
}
