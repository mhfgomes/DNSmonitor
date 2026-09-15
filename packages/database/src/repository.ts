import { normalize, normalizeHostname } from '../../dns-engine/src/records.js';
import { randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool } from 'mariadb';
import { evaluate, initialState, validateConfig, type MonitorConfig, type MonitorState } from '../../monitoring/src/index.js';
import type { QueryResult, ResolverConfig } from '../../dns-engine/src/query.js';
import { databaseTime, transaction } from './connection.js';

interface MonitorRow {
  id: string; name: string; config: string; resolver_group_id: string;
  config_revision: number; history_revision: number; enabled: number; next_check_at: Date;
  lease_token: string | null; lease_expires_at: Date | null;
}
export interface Claim {
  id: string; token: string; workerId: string; configRevision: number;
  config: MonitorConfig; resolvers: ResolverConfig[];
  scheduledAt: Date; startedAt: Date; leaseExpiresAt: Date;
}
export interface MonitorInput { name: string; config: MonitorConfig; resolvers: ResolverConfig[] }

export function validateInput(input: MonitorInput): void {
  if (!input || typeof input !== 'object' || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200) throw new Error('Invalid monitor name');
  validateConfig(input.config);
  if (!Array.isArray(input.resolvers) || input.resolvers.length !== input.config.resolverIds.length) throw new Error('Resolver configuration does not match monitor');
  const ids = new Set<string>();
  for (const resolver of input.resolvers) {
    if (!resolver || !input.config.resolverIds.includes(resolver.id) || ids.has(resolver.id)
      || typeof resolver.server !== 'string' || !isIP(resolver.server)
      || !['UDP', 'TCP'].includes(resolver.protocol)
      || (resolver.port !== undefined && (!Number.isInteger(resolver.port) || resolver.port < 1 || resolver.port > 65535))) throw new Error('Invalid resolver');
    ids.add(resolver.id);
  }
}

/** Skip missed slots, preserving cadence without accumulating catch-up work. */
export function nextSlot(scheduledAt: Date, finishedAt: Date, intervalSeconds: number): Date {
  const interval = intervalSeconds * 1000;
  const slots = Math.max(1, Math.floor((finishedAt.getTime() - scheduledAt.getTime()) / interval) + 1);
  return new Date(scheduledAt.getTime() + slots * interval);
}

export class Repository {
  constructor(readonly pool: Pool) {}

  async createMonitor(input: MonitorInput, stagger = true): Promise<string> {
    validateInput(input);
    return transaction(this.pool, async connection => {
      const id = randomUUID();
      const groupId = randomUUID();
      const now = await databaseTime(connection);
      const next = new Date(now.getTime() + (stagger ? randomInt(input.config.intervalSeconds * 1000) : 0));
      await connection.query('INSERT INTO resolver_groups (id, name) VALUES (?, ?)', [groupId, input.name]);
      for (const resolver of input.resolvers) {
        await connection.query('INSERT INTO resolvers (id, group_id, resolver_key, config) VALUES (?, ?, ?, ?)', [randomUUID(), groupId, resolver.id, JSON.stringify(resolver)]);
      }
      await connection.query('INSERT INTO monitors (id, name, config, resolver_group_id, next_check_at) VALUES (?, ?, ?, ?, ?)', [id, input.name, JSON.stringify(input.config), groupId, next]);
      await connection.query('INSERT INTO monitor_states (monitor_id, state) VALUES (?, ?)', [id, JSON.stringify(initialState())]);
      return id;
    });
  }

  async claimDue(workerId: string, capacity: number): Promise<Claim[]> {
    if (!workerId || workerId.length > 100 || !Number.isInteger(capacity) || capacity < 1 || capacity > 100) throw new Error('Invalid claim parameters');
    return transaction(this.pool, async connection => {
      const now = await databaseTime(connection);
      const rows = await connection.query<MonitorRow[]>(`SELECT * FROM monitors FORCE INDEX (due_monitors)
        WHERE enabled = TRUE AND next_check_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY next_check_at, id LIMIT ? FOR UPDATE SKIP LOCKED`, [now, now, capacity]);
      const claims: Claim[] = [];
      for (const row of rows) {
        if (row.lease_token) await connection.query("UPDATE check_runs SET status = 'ABANDONED', finished_at = ? WHERE id = ? AND status = 'RUNNING'", [now, row.lease_token]);
        const config = validateConfig(JSON.parse(row.config) as MonitorConfig);
        const resolverRows = await connection.query<{ config: string }[]>('SELECT config FROM resolvers WHERE group_id = ? ORDER BY resolver_key', [row.resolver_group_id]);
        const resolvers = resolverRows.map(item => JSON.parse(item.config) as ResolverConfig);
        validateInput({ name: row.name, config, resolvers });
        const token = randomUUID();
        // Each monitor queries resolvers sequentially. The lease covers the entire
        // DNS budget plus time to persist; no unbounded resolver queue precedes I/O.
        const leaseExpiresAt = new Date(now.getTime() + config.timeoutMs * resolvers.length + 15000);
        await connection.query('UPDATE monitors SET lease_token = ?, lease_expires_at = ? WHERE id = ?', [token, leaseExpiresAt, row.id]);
        await connection.query(`INSERT INTO check_runs (id, monitor_id, worker_id, config_revision, scheduled_at, started_at, status)
          VALUES (?, ?, ?, ?, ?, ?, 'RUNNING')`, [token, row.id, workerId, row.config_revision, row.next_check_at, now]);
        claims.push({ id: row.id, token, workerId, configRevision: row.config_revision, config, resolvers, scheduledAt: row.next_check_at, startedAt: now, leaseExpiresAt });
      }
      return claims;
    });
  }

  async complete(claim: Claim, results: QueryResult[]): Promise<boolean> {
    return transaction(this.pool, async connection => {
      const rows = await connection.query<MonitorRow[]>('SELECT * FROM monitors WHERE id = ? FOR UPDATE', [claim.id]);
      const row = rows[0];
      const now = await databaseTime(connection);
      if (!row || !row.enabled || row.lease_token !== claim.token || row.config_revision !== claim.configRevision || !row.lease_expires_at || row.lease_expires_at <= now) return false;
      const states = await connection.query<{ state: string; active_incident_id: string | null }[]>('SELECT state, active_incident_id FROM monitor_states WHERE monitor_id = ? FOR UPDATE', [claim.id]);
      const previous = JSON.parse(states[0]!.state) as MonitorState;
      const evaluated = evaluate(claim.config, previous, results, now);
      let incidentId = states[0]!.active_incident_id;
      await connection.query("UPDATE check_runs SET status = 'COMPLETED', finished_at = ?, resolver_results = ?, observation = ? WHERE id = ?", [now, JSON.stringify(results), JSON.stringify({ ...evaluated.observation, status: evaluated.state.status }), claim.token]);
      for (const event of evaluated.events) {
        if (event.type === 'INCIDENT_OPENED') {
          if (incidentId) throw new Error('Active incident invariant violated');
          incidentId = randomUUID();
          await connection.query("INSERT INTO incidents (id, monitor_id, status, reason, opened_at, initial_value, current_value) VALUES (?, ?, 'OPEN', ?, ?, ?, ?)", [incidentId, claim.id, event.reason, now, JSON.stringify(event.newValue ?? null), JSON.stringify(event.newValue ?? null)]);
        }
        const eventId = randomUUID();
        await connection.query('INSERT INTO dns_events (id, monitor_id, check_run_id, incident_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [eventId, claim.id, claim.token, incidentId, event.type, JSON.stringify(event), now]);
        if (event.type !== 'BASELINE_ESTABLISHED') {
          // Durable event outbox. Channel fan-out and delivery are the next increment.
          await connection.query('INSERT INTO notification_jobs (id, event_id, payload, next_attempt_at, created_at) VALUES (?, ?, ?, ?, ?)', [randomUUID(), eventId, JSON.stringify({ eventId, monitorId: claim.id, monitorName: row.name, incidentId, event }), now, now]);
        }
        if (event.type === 'INCIDENT_RESOLVED') {
          if (!incidentId) throw new Error('Missing active incident');
          await connection.query("UPDATE incidents SET status = 'RESOLVED', resolved_at = ?, current_value = ? WHERE id = ?", [now, JSON.stringify(event.newValue ?? null), incidentId]);
          incidentId = null;
        }
      }
      if (incidentId) await connection.query('UPDATE incidents SET current_value = ? WHERE id = ?', [JSON.stringify(evaluated.observation.value ?? null), incidentId]);
      await connection.query('UPDATE monitor_states SET state = ?, current_value = ?, active_incident_id = ? WHERE monitor_id = ?', [JSON.stringify(evaluated.state), JSON.stringify(evaluated.observation.value ?? null), incidentId, claim.id]);
      await connection.query('UPDATE monitors SET lease_token = NULL, lease_expires_at = NULL, next_check_at = ? WHERE id = ?', [nextSlot(claim.scheduledAt, now, claim.config.intervalSeconds), claim.id]);
      return true;
    });
  }

  /** Infrastructure errors must not count as DNS failures. Retry after a short delay. */
  async fail(claim: Claim, code: string): Promise<void> {
    await transaction(this.pool, async connection => {
      const rows = await connection.query<MonitorRow[]>('SELECT * FROM monitors WHERE id = ? FOR UPDATE', [claim.id]);
      if (rows[0]?.lease_token !== claim.token) return;
      await connection.query("UPDATE check_runs SET status = 'ERROR', error_code = ?, finished_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'RUNNING'", [code.slice(0, 100), claim.token]);
      await connection.query('UPDATE monitors SET lease_token = NULL, lease_expires_at = NULL, next_check_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 5 SECOND) WHERE id = ?', [claim.id]);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await transaction(this.pool, async connection => {
      const rows = await connection.query<MonitorRow[]>('SELECT * FROM monitors WHERE id = ? FOR UPDATE', [id]);
      if (!rows.length) throw new Error('Monitor not found');
      if (rows[0]!.lease_token) await connection.query("UPDATE check_runs SET status = 'ABANDONED', finished_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'RUNNING'", [rows[0]!.lease_token]);
      const states = await connection.query<{ state: string }[]>('SELECT state FROM monitor_states WHERE monitor_id = ? FOR UPDATE', [id]);
      const state = JSON.parse(states[0]!.state) as MonitorState;
      state.failures = 0;
      state.successes = 0;
      state.candidate = undefined;
      state.candidateCount = 0;
      state.status = state.incidentOpen ? 'CRITICAL' : 'UNKNOWN';
      await connection.query('UPDATE monitor_states SET state = ? WHERE monitor_id = ?', [JSON.stringify(state), id]);
      await connection.query('UPDATE monitors SET enabled = ?, config_revision = config_revision + 1, lease_token = NULL, lease_expires_at = NULL, next_check_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [enabled, id]);
    });
  }

  async checkNow(id: string): Promise<void> {
    const result = await this.pool.query('UPDATE monitors SET next_check_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND enabled = TRUE AND lease_token IS NULL', [id]);
    if (result.affectedRows !== 1) throw new Error('Monitor missing, paused, or already running');
  }

  async heartbeat(workerId: string, active: number, status = 'ONLINE'): Promise<void> {
    await this.pool.query(`INSERT INTO workers (id, status, last_heartbeat, active_jobs) VALUES (?, ?, CURRENT_TIMESTAMP(3), ?)
      ON DUPLICATE KEY UPDATE status = VALUES(status), last_heartbeat = VALUES(last_heartbeat), active_jobs = VALUES(active_jobs)`, [workerId, status, active]);
  }

  async list(limit = 1000, offset = 0, filters: { search?: string; mode?: string } = {}) {
    const search = filters.search ?? ''; const mode = filters.mode ?? '';
    const rows = await this.pool.query<(MonitorRow & { state: string })[]>(`SELECT m.*, s.state FROM monitors m JOIN monitor_states s ON s.monitor_id = m.id
      WHERE (? = '' OR INSTR(LOWER(m.name), LOWER(?)) > 0 OR INSTR(LOWER(JSON_UNQUOTE(JSON_EXTRACT(m.config, '$.hostname'))), LOWER(?)) > 0)
      AND (? = '' OR JSON_UNQUOTE(JSON_EXTRACT(m.config, '$.mode')) = ?)
      ORDER BY m.created_at, m.id LIMIT ? OFFSET ?`, [search, search, search, mode, mode, limit, offset]);
    return rows.map(row => ({ id: row.id, name: row.name, enabled: Boolean(row.enabled), config: JSON.parse(row.config), state: JSON.parse(row.state), nextCheckAt: row.next_check_at, leaseExpiresAt: row.lease_expires_at }));
  }

  async count(filters: { search?: string; mode?: string } = {}): Promise<number> {
    const search = filters.search ?? ''; const mode = filters.mode ?? '';
    const rows = await this.pool.query<{ total: number }[]>(`SELECT COUNT(*) AS total FROM monitors m
      WHERE (? = '' OR INSTR(LOWER(m.name), LOWER(?)) > 0 OR INSTR(LOWER(JSON_UNQUOTE(JSON_EXTRACT(m.config, '$.hostname'))), LOWER(?)) > 0)
      AND (? = '' OR JSON_UNQUOTE(JSON_EXTRACT(m.config, '$.mode')) = ?)`, [search, search, search, mode, mode]);
    return rows[0]!.total;
  }

  async updateTiming(id: string, changes: Partial<Pick<MonitorConfig, 'intervalSeconds' | 'timeoutMs' | 'failureThreshold' | 'recoveryThreshold' | 'changeThreshold'>>): Promise<void> {
    await transaction(this.pool, async connection => {
      const rows = await connection.query<MonitorRow[]>('SELECT * FROM monitors WHERE id = ? FOR UPDATE', [id]);
      if (!rows.length) throw new Error('Monitor not found');
      const row = rows[0]!;
      const config = validateConfig({ ...JSON.parse(row.config), ...changes } as MonitorConfig);
      if (row.lease_token) await connection.query("UPDATE check_runs SET status = 'ABANDONED', finished_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'RUNNING'", [row.lease_token]);
      const states = await connection.query<{ state: string }[]>('SELECT state FROM monitor_states WHERE monitor_id = ? FOR UPDATE', [id]);
      const state = JSON.parse(states[0]!.state) as MonitorState;
      state.failures = 0; state.successes = 0; state.candidate = undefined; state.candidateCount = 0;
      state.status = state.incidentOpen ? 'CRITICAL' : 'UNKNOWN';
      await connection.query('UPDATE monitor_states SET state = ? WHERE monitor_id = ?', [JSON.stringify(state), id]);
      await connection.query('UPDATE monitors SET config = ?, config_revision = config_revision + 1, lease_token = NULL, lease_expires_at = NULL, next_check_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [JSON.stringify(config), id]);
    });
  }

  async updateMonitor(id: string, input: MonitorInput, revision: number): Promise<void> {
    validateInput(input);
    await transaction(this.pool, async connection => {
      const rows = await connection.query<MonitorRow[]>('SELECT * FROM monitors WHERE id = ? FOR UPDATE', [id]);
      const row = rows[0]; if (!row) throw new Error('Monitor not found');
      if (row.config_revision !== revision) throw new RevisionConflict();
      const previousResolvers = await connection.query<{ config: string }[]>('SELECT config FROM resolvers WHERE group_id = ?', [row.resolver_group_id]);
      const previous = JSON.parse(row.config) as MonitorConfig;
      const changed = queryIdentity(input.config, input.resolvers) !== queryIdentity(previous, previousResolvers.map(r => JSON.parse(r.config)));
      const timingChanged = ['intervalSeconds', 'timeoutMs', 'failureThreshold', 'recoveryThreshold', 'changeThreshold'].some(key => input.config[key as keyof MonitorConfig] !== previous[key as keyof MonitorConfig]);
      const states = await connection.query<{ state: string; active_incident_id: string | null }[]>('SELECT state, active_incident_id FROM monitor_states WHERE monitor_id = ? FOR UPDATE', [id]);
      if (row.lease_token) await connection.query("UPDATE check_runs SET status = 'ABANDONED', finished_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND status = 'RUNNING'", [row.lease_token]);
      if (changed) {
        // Lock jobs before cancelling deliveries, matching the outbox routing order.
        await connection.query('SELECT j.id FROM notification_jobs j JOIN dns_events e ON e.id = j.event_id WHERE e.monitor_id = ? FOR UPDATE', [id]);
        await connection.query("UPDATE notification_jobs j JOIN dns_events e ON e.id = j.event_id SET j.status = 'CANCELLED' WHERE e.monitor_id = ?", [id]);
        await connection.query("UPDATE notification_deliveries d JOIN notification_jobs j ON j.id = d.job_id JOIN dns_events e ON e.id = j.event_id SET d.status = 'CANCELLED', d.lease_token = NULL, d.lease_expires_at = NULL WHERE e.monitor_id = ? AND d.status IN ('PENDING', 'PROCESSING', 'FAILED')", [id]);
        if (states[0]!.active_incident_id) await connection.query("UPDATE incidents SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP(3), closure_reason = 'CONFIGURATION_CHANGED' WHERE id = ?", [states[0]!.active_incident_id]);
        await connection.query('UPDATE monitor_states SET state = ?, current_value = NULL, active_incident_id = NULL WHERE monitor_id = ?', [JSON.stringify(initialState()), id]);
        await connection.query("INSERT INTO dns_events (id, monitor_id, incident_id, type, payload, created_at) VALUES (?, ?, ?, 'CONFIGURATION_CHANGED', ?, CURRENT_TIMESTAMP(3))", [randomUUID(), id, states[0]!.active_incident_id, JSON.stringify({ type: 'CONFIGURATION_CHANGED', previousRevision: revision, revision: revision + 1 })]);
      } else if (timingChanged) {
        const state = JSON.parse(states[0]!.state) as MonitorState;
        state.failures = 0; state.successes = 0; state.candidate = undefined; state.candidateCount = 0;
        state.status = state.incidentOpen ? 'CRITICAL' : 'UNKNOWN';
        await connection.query('UPDATE monitor_states SET state = ? WHERE monitor_id = ?', [JSON.stringify(state), id]);
      }
      // Replace the private resolver group; never mutate a potentially shared group.
      const group = randomUUID();
      await connection.query('INSERT INTO resolver_groups (id, name) VALUES (?, ?)', [group, input.name]);
      for (const resolver of input.resolvers) await connection.query('INSERT INTO resolvers (id, group_id, resolver_key, config) VALUES (?, ?, ?, ?)', [randomUUID(), group, resolver.id, JSON.stringify(resolver)]);
      await connection.query('UPDATE monitors SET name = ?, config = ?, resolver_group_id = ?, config_revision = config_revision + 1, history_revision = IF(?, ?, history_revision), lease_token = NULL, lease_expires_at = NULL, next_check_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [input.name, JSON.stringify(input.config), group, changed, revision + 1, id]);
      await removeUnusedGroup(connection, row.resolver_group_id);
    });
  }

  async deleteMonitor(id: string, revision: number): Promise<void> {
    await transaction(this.pool, async connection => {
      const rows = await connection.query<MonitorRow[]>('SELECT * FROM monitors WHERE id = ? FOR UPDATE', [id]);
      if (!rows[0]) throw new Error('Monitor not found');
      if (rows[0].config_revision !== revision) throw new RevisionConflict();
      await connection.query('SELECT j.id FROM notification_jobs j JOIN dns_events e ON e.id = j.event_id WHERE e.monitor_id = ? FOR UPDATE', [id]);
      await connection.query('DELETE d FROM notification_deliveries d JOIN notification_jobs j ON j.id = d.job_id JOIN dns_events e ON e.id = j.event_id WHERE e.monitor_id = ?', [id]);
      await connection.query('DELETE j FROM notification_jobs j JOIN dns_events e ON e.id = j.event_id WHERE e.monitor_id = ?', [id]);
      for (const table of ['dns_events', 'monitor_states', 'incidents', 'check_runs', 'monitor_hourly']) await connection.query(`DELETE FROM ${table} WHERE monitor_id = ?`, [id]);
      const rules = await connection.query<{ id: string; config: string }[]>('SELECT id, config FROM alert_rules FOR UPDATE');
      for (const rule of rules) {
        const config = JSON.parse(rule.config) as { monitorIds: string[] };
        if (!config.monitorIds.includes(id)) continue;
        config.monitorIds = config.monitorIds.filter(value => value !== id);
        // Empty scope means ALL monitors, so remove an exhausted targeted rule.
        if (!config.monitorIds.length) await connection.query('DELETE FROM alert_rules WHERE id = ?', [rule.id]);
        else await connection.query('UPDATE alert_rules SET config = ? WHERE id = ?', [JSON.stringify(config), rule.id]);
      }
      await connection.query('DELETE FROM monitors WHERE id = ?', [id]);
      await removeUnusedGroup(connection, rows[0].resolver_group_id);
    });
  }

  async inspect(id: string) {
    const rows = await this.pool.query<(MonitorRow & { state: string; current_value: string })[]>('SELECT m.*, s.state, s.current_value FROM monitors m JOIN monitor_states s ON s.monitor_id = m.id WHERE m.id = ?', [id]);
    if (!rows.length) throw new Error('Monitor not found');
    const row = rows[0]!;
    const checks = await this.pool.query('SELECT * FROM check_runs WHERE monitor_id = ? AND config_revision >= ? ORDER BY started_at DESC LIMIT 20', [id, row.history_revision]);
    const resolverRows = await this.pool.query<{ config: string }[]>('SELECT config FROM resolvers WHERE group_id = ? ORDER BY resolver_key', [row.resolver_group_id]);
    const events = await this.pool.query('SELECT * FROM dns_events WHERE monitor_id = ? ORDER BY created_at DESC LIMIT 20', [id]);
    const incidents = await this.pool.query('SELECT * FROM incidents WHERE monitor_id = ? ORDER BY opened_at DESC LIMIT 20', [id]);
    const decode = (value: string | null) => value === null ? null : JSON.parse(value);
    return { id, configRevision: row.config_revision, resolvers: resolverRows.map(r => JSON.parse(r.config)), name: row.name, enabled: Boolean(row.enabled), config: JSON.parse(row.config), state: JSON.parse(row.state), currentValue: decode(row.current_value), nextCheckAt: row.next_check_at, leaseExpiresAt: row.lease_expires_at,
      checks: checks.map((check: { resolver_results: string | null; observation: string | null }) => ({ ...check, resolver_results: decode(check.resolver_results), observation: decode(check.observation) })),
      events: events.map((event: { payload: string }) => ({ ...event, payload: decode(event.payload) })),
      incidents: incidents.map((incident: { initial_value: string | null; current_value: string | null }) => ({ ...incident, initial_value: decode(incident.initial_value), current_value: decode(incident.current_value) })),
    };
  }
}

export class RevisionConflict extends Error {
  readonly statusCode = 409;
  constructor() { super('Monitor changed. Reload it before saving or deleting.'); }
}
function queryIdentity(config: MonitorConfig, resolvers: ResolverConfig[]): string {
  return JSON.stringify({ hostname: normalizeHostname(config.hostname), recordType: config.recordType, mode: config.mode,
    expected: config.mode === 'EXPECTED' ? normalize(config.recordType, config.expected) : null,
    match: config.mode === 'EXPECTED' ? config.match : null,
    resolvers: resolvers.map(r => ({ id: r.id, server: r.server, port: r.port ?? 53, protocol: r.protocol })).sort((a,b) => a.id.localeCompare(b.id)) });
}
async function removeUnusedGroup(connection: import('mariadb').PoolConnection, group: string): Promise<void> {
  if ((await connection.query('SELECT id FROM monitors WHERE resolver_group_id = ?', [group])).length) return;
  await connection.query('DELETE FROM resolvers WHERE group_id = ?', [group]);
  await connection.query('DELETE FROM resolver_groups WHERE id = ?', [group]);
}
