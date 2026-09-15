import type { Pool } from 'mariadb';
import { retentionConfig } from './retention.js';

/** Aggregate installation health. Recent payload reads are bounded and shared for 10s. */
export class Operations {
  private cached?: { expires: number; value: OperationsSnapshot };
  private pending?: Promise<OperationsSnapshot>;
  constructor(private readonly pool: Pool) {}
  snapshot(): Promise<OperationsSnapshot> {
    if (this.cached && this.cached.expires > Date.now()) return Promise.resolve(this.cached.value);
    if (this.pending) return this.pending;
    this.pending = this.collect().then(value => { this.cached = { value, expires: Date.now() + 10000 }; return value; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async collect() {
    const pool = this.pool;
    const workers = await pool.query("SELECT id, status, last_heartbeat, active_jobs, GREATEST(0,TIMESTAMPDIFF(SECOND,last_heartbeat,CURRENT_TIMESTAMP(3))) AS age_seconds FROM workers ORDER BY last_heartbeat DESC LIMIT 101");
    const workerCounts = (await pool.query("SELECT COALESCE(SUM(status='ONLINE' AND last_heartbeat > DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 15 SECOND)),0) AS online, COALESCE(SUM(status='ONLINE' AND last_heartbeat <= DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 15 SECOND)),0) AS stale FROM workers"))[0];
    const monitors = (await pool.query("SELECT COUNT(*) AS enabled, COALESCE(SUM(next_check_at < DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 30 SECOND) AND (lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP(3))),0) AS overdue, COALESCE(MAX(IF(lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP(3),GREATEST(0,TIMESTAMPDIFF(SECOND,next_check_at,CURRENT_TIMESTAMP(3))),0)),0) AS oldest_due_seconds FROM monitors WHERE enabled=TRUE"))[0];
    const deliveries = await pool.query('SELECT status, COUNT(*) AS count FROM notification_deliveries GROUP BY status');
    const queue: Record<string, number> = Object.fromEntries(deliveries.map((r: { status: string; count: number }) => [r.status, r.count]));
    const routing = (await pool.query("SELECT COUNT(*) AS count FROM notification_jobs WHERE status='PENDING'"))[0].count as number;
    const checks = await pool.query("SELECT status, JSON_EXTRACT(resolver_results, '$[*].status') AS resolver_statuses, GREATEST(0,TIMESTAMPDIFF(MICROSECOND,scheduled_at,started_at)/1000000) AS delay_seconds FROM check_runs WHERE finished_at >= DATE_SUB(CURRENT_TIMESTAMP(3),INTERVAL 15 MINUTE) ORDER BY finished_at DESC LIMIT 1001");
    const sample = checks.slice(0,1000);
    const delays = sample.map((r: { delay_seconds: number }) => Number(r.delay_seconds)).sort((a: number,b: number) => a-b);
    let queries = 0; let timeouts = 0;
    for (const row of sample) for (const result of JSON.parse(row.resolver_statuses ?? '[]')) { queries++; if (result === 'TIMEOUT') timeouts++; }
    const maintenance = (await pool.query("SELECT last_completed_at, next_run_at, last_result FROM maintenance WHERE name='retention'"))[0];
    const storage = (await pool.query('SELECT COALESCE(SUM(data_length+index_length),0) AS bytes FROM information_schema.tables WHERE table_schema=DATABASE()'))[0];
    const config = retentionConfig();
    return {
      collectedAt: new Date().toISOString(),
      workers: { online: Number(workerCounts.online), stale: Number(workerCounts.stale), truncated: workers.length > 100, items: workers.slice(0,100).map((r: { id: string; status: string; age_seconds: number; active_jobs: number }) => ({ id: r.id, status: r.status, ageSeconds: Number(r.age_seconds), activeJobs: r.active_jobs })) },
      monitors: { enabled: Number(monitors.enabled), overdue: Number(monitors.overdue), oldestDueSeconds: Number(monitors.oldest_due_seconds) },
      notifications: { routing, pending: queue.PENDING ?? 0, processing: queue.PROCESSING ?? 0, failed: queue.FAILED ?? 0 },
      recent: { windowSeconds: 900, checks: sample.length, truncated: checks.length > 1000, errors: sample.filter((r: { status: string }) => r.status === 'ERROR').length, queries, timeouts, timeoutRatio: queries ? timeouts / queries : null, delayP95Seconds: delays.length ? delays[Math.ceil(delays.length * .95)-1] as number : null, delayMaxSeconds: delays.length ? delays[delays.length-1] as number : null },
      retention: { enabled: config.enabled, lastCompletedAt: maintenance?.last_completed_at ? new Date(maintenance.last_completed_at).toISOString() : null, nextRunAt: maintenance?.next_run_at ? new Date(maintenance.next_run_at).toISOString() : null, late: config.enabled && (!maintenance?.last_completed_at || Date.now() - new Date(maintenance.last_completed_at).getTime() > Math.max(180, config.intervalSeconds * 3)*1000), checkHours: config.checkHours, summaryDays: config.summaryDays },
      database: { approximateBytes: Number(storage.bytes) },
    };
  }
}
export type OperationsSnapshot = Snapshot;
// Separate structural type keeps the client contract independent of the SQL driver.
interface Snapshot {
 collectedAt: string;
 workers: { online: number; stale: number; truncated: boolean; items: { id: string; status: string; ageSeconds: number; activeJobs: number }[] };
 monitors: { enabled: number; overdue: number; oldestDueSeconds: number };
 notifications: { routing: number; pending: number; processing: number; failed: number };
 recent: { windowSeconds: number; checks: number; truncated: boolean; errors: number; queries: number; timeouts: number; timeoutRatio: number | null; delayP95Seconds: number | null; delayMaxSeconds: number | null };
 retention: { enabled: boolean; lastCompletedAt: string | null; nextRunAt: string | null; late: boolean; checkHours: number; summaryDays: number };
 database: { approximateBytes: number };
}
export function prometheus(snapshot: OperationsSnapshot): string {
 const lines: string[] = [];
 const gauge = (name: string, help: string, value: number | null) => { if (value === null) return; lines.push(`# HELP dnsmonitor_${name} ${help}`, `# TYPE dnsmonitor_${name} gauge`, `dnsmonitor_${name} ${value}`); };
 gauge('snapshot_timestamp_seconds','Time this database snapshot was collected.',Date.parse(snapshot.collectedAt)/1000);
 gauge('workers_online','Workers with an ONLINE heartbeat newer than 15 seconds.',snapshot.workers.online);
 gauge('workers_stale','Recorded ONLINE workers with expired heartbeats; includes historical crashed workers.',snapshot.workers.stale);
 gauge('monitors_enabled','Enabled monitors.',snapshot.monitors.enabled);
 gauge('monitors_overdue','Eligible monitors more than 30 seconds past due; active leases excluded.',snapshot.monitors.overdue);
 gauge('scheduler_oldest_due_seconds','Age of oldest eligible due check.',snapshot.monitors.oldestDueSeconds);
 gauge('scheduler_delay_p95_seconds','P95 scheduling delay in the bounded recent sample.',snapshot.recent.delayP95Seconds);
 gauge('scheduler_delay_max_seconds','Maximum scheduling delay in the bounded recent sample.',snapshot.recent.delayMaxSeconds);
 for (const key of ['routing','pending','processing','failed'] as const) gauge(`notifications_${key}`,`Current ${key} notification jobs or deliveries.`,snapshot.notifications[key]);
 gauge('recent_checks','Checks sampled from the last 15 minutes, capped at 1000.',snapshot.recent.checks);
 gauge('recent_sample_truncated','One when more than 1000 recent checks exist.',Number(snapshot.recent.truncated));
 gauge('recent_check_errors','ERROR check runs in the recent sample.',snapshot.recent.errors);
 gauge('recent_dns_queries','Resolver results in the recent sample.',snapshot.recent.queries);
 gauge('recent_dns_timeouts','Resolver timeouts in the recent sample.',snapshot.recent.timeouts);
 gauge('recent_dns_timeout_ratio','Fraction of sampled resolver results that timed out.',snapshot.recent.timeoutRatio);
 gauge('database_approximate_bytes','Approximate allocated table and index bytes; excludes database system files.',snapshot.database.approximateBytes);
 gauge('retention_enabled','Whether retention is enabled.',Number(snapshot.retention.enabled));
 gauge('retention_late','Retention has not completed within its grace period.',Number(snapshot.retention.late));
 gauge('retention_last_completed_timestamp_seconds','Last successful retention completion.',snapshot.retention.lastCompletedAt ? Date.parse(snapshot.retention.lastCompletedAt)/1000 : null);
 return lines.join('\n')+'\n';
}
