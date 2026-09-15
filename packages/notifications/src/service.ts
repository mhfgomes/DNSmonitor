import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool } from 'mariadb';
import { databaseTime, errorCode, transaction } from '../../database/src/connection.js';
import { channelConfig, decrypt, encrypt, ruleConfig, type ChannelConfig, type RuleConfig } from './config.js';
import { deliver, DeliveryError } from './transport.js';

export interface DeliveryClaim { id: string; channel_id: string; encrypted_config: string; payload: string; attempts: number; token: string }
export class Notifications {
  constructor(readonly pool: Pool, private readonly key: Buffer) {}

  async createChannel(name: string, input: ChannelConfig): Promise<string> {
    const config = channelConfig.parse(input);
    const id = randomUUID();
    await this.pool.query('INSERT INTO notification_channels (id, name, type, encrypted_config) VALUES (?, ?, ?, ?)', [id, name, config.type, encrypt(config, this.key, id)]);
    return id;
  }
  async channels() {
    return this.pool.query('SELECT id, name, type, enabled, created_at FROM notification_channels ORDER BY created_at, id LIMIT 1000');
  }
  async createRule(name: string, input: RuleConfig): Promise<string> {
    const config = ruleConfig.parse(input);
    return transaction(this.pool, async connection => {
      for (const id of new Set(config.channelIds)) {
        if (!(await connection.query('SELECT id FROM notification_channels WHERE id = ?', [id])).length) throw new Error('Channel not found');
      }
      for (const id of new Set(config.monitorIds)) {
        if (!(await connection.query('SELECT id FROM monitors WHERE id = ? FOR UPDATE', [id])).length) throw new Error('Monitor not found');
      }
      const id = randomUUID();
      await connection.query('INSERT INTO alert_rules (id, name, config) VALUES (?, ?, ?)', [id, name, JSON.stringify(config)]);
      return id;
    });
  }
  async rules() {
    const rows = await this.pool.query<{ id: string; name: string; config: string; enabled: number }[]>('SELECT id, name, config, enabled FROM alert_rules ORDER BY created_at, id LIMIT 1000');
    return rows.map(row => ({ ...row, config: JSON.parse(row.config), enabled: Boolean(row.enabled) }));
  }
  async setChannelEnabled(id: string, enabled: boolean): Promise<void> {
    await transaction(this.pool, async connection => {
      const result = await connection.query('UPDATE notification_channels SET enabled = ? WHERE id = ?', [enabled, id]);
      if (result.affectedRows !== 1) throw new Error('Channel not found');
      if (!enabled) await connection.query("UPDATE notification_deliveries SET status = 'CANCELLED', lease_token = NULL, lease_expires_at = NULL WHERE channel_id = ? AND status IN ('PENDING', 'PROCESSING')", [id]);
    });
  }
  async setRuleEnabled(id: string, enabled: boolean): Promise<void> {
    const result = await this.pool.query('UPDATE alert_rules SET enabled = ? WHERE id = ?', [enabled, id]);
    if (result.affectedRows !== 1) throw new Error('Rule not found');
  }
  async testChannel(id: string): Promise<void> {
    const rows = await this.pool.query<{ encrypted_config: string }[]>('SELECT encrypted_config FROM notification_channels WHERE id = ? AND enabled = TRUE', [id]);
    if (!rows.length) throw new Error('Channel not found or disabled');
    await deliver(decrypt(rows[0]!.encrypted_config, this.key, id), randomUUID(), { type: 'TEST', message: 'DNSmonitor channel test' });
  }

  async routePending(): Promise<number> {
    return transaction(this.pool, async connection => {
      const jobs = await connection.query<{ id: string; payload: string; created_at: Date }[]>("SELECT id, payload, created_at FROM notification_jobs FORCE INDEX (outbox_due) WHERE status = 'PENDING' ORDER BY created_at, id LIMIT 25 FOR UPDATE SKIP LOCKED");
      if (!jobs.length) return 0;
      const rules = await connection.query<{ config: string; created_at: Date }[]>('SELECT config, created_at FROM alert_rules WHERE enabled = TRUE');
      const channels = await connection.query<{ id: string; encrypted_config: string; created_at: Date }[]>('SELECT id, encrypted_config, created_at FROM notification_channels WHERE enabled = TRUE');
      for (const job of jobs) {
        const payload = JSON.parse(job.payload) as { monitorId: string; event: { type: string } };
        const ids = new Set<string>();
        for (const row of rules) {
          if (row.created_at > job.created_at) continue; // New rules never replay old alerts.
          const rule = ruleConfig.parse(JSON.parse(row.config));
          if (rule.eventTypes.some(type => type === payload.event.type) && (!rule.monitorIds.length || rule.monitorIds.includes(payload.monitorId))) rule.channelIds.forEach(id => ids.add(id));
        }
        let count = 0;
        for (const channel of channels) {
          if (!ids.has(channel.id) || channel.created_at > job.created_at) continue;
          await connection.query('INSERT INTO notification_deliveries (id, job_id, channel_id, encrypted_config, payload, next_attempt_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))', [randomUUID(), job.id, channel.id, channel.encrypted_config, job.payload]);
          count++;
        }
        await connection.query('UPDATE notification_jobs SET status = ? WHERE id = ?', [count ? 'ROUTED' : 'IGNORED', job.id]);
      }
      return jobs.length;
    });
  }

  async claim(): Promise<DeliveryClaim | undefined> {
    return transaction(this.pool, async connection => {
      const now = await databaseTime(connection);
      await connection.query("UPDATE notification_deliveries SET status = 'FAILED', last_error = 'LEASE_RETRIES_EXHAUSTED', lease_token = NULL WHERE status = 'PROCESSING' AND attempts >= 5 AND lease_expires_at <= ?", [now]);
      const rows = await connection.query<Omit<DeliveryClaim, 'token'>[]>(`SELECT id, channel_id, encrypted_config, payload, attempts FROM notification_deliveries
        WHERE attempts < 5 AND next_attempt_at <= ? AND (status = 'PENDING' OR (status = 'PROCESSING' AND lease_expires_at <= ?))
        ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now, now]);
      if (!rows.length) return;
      const row = rows[0]!;
      const token = randomUUID();
      await connection.query("UPDATE notification_deliveries SET status = 'PROCESSING', attempts = attempts + 1, lease_token = ?, lease_expires_at = DATE_ADD(?, INTERVAL 45 SECOND) WHERE id = ?", [token, now, row.id]);
      return { ...row, attempts: row.attempts + 1, token };
    });
  }

  async finish(claim: DeliveryClaim, failure?: string): Promise<boolean> {
    const delays = [30, 120, 600, 1800];
    const result = await this.pool.query(`UPDATE notification_deliveries SET status = ?, last_error = ?, sent_at = IF(?, NULL, CURRENT_TIMESTAMP(3)),
      next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND), lease_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND status = 'PROCESSING' AND lease_token = ? AND lease_expires_at > CURRENT_TIMESTAMP(3)`,
    [failure ? claim.attempts >= 5 ? 'FAILED' : 'PENDING' : 'SENT', failure ?? null, Boolean(failure), delays[Math.min(claim.attempts - 1, 3)], claim.id, claim.token]);
    return result.affectedRows === 1;
  }
  async retry(id: string): Promise<void> {
    const result = await this.pool.query("UPDATE notification_deliveries d JOIN notification_channels c ON c.id = d.channel_id SET d.status = 'PENDING', d.attempts = 0, d.next_attempt_at = CURRENT_TIMESTAMP(3), d.last_error = NULL WHERE d.id = ? AND d.status = 'FAILED' AND c.enabled = TRUE", [id]);
    if (result.affectedRows !== 1) throw new Error('Delivery not failed or channel disabled');
  }
  async send(claim: DeliveryClaim, signal?: AbortSignal): Promise<void> {
    let failure: string | undefined;
    try {
      const channel = await this.pool.query<{ enabled: number }[]>(`SELECT c.enabled FROM notification_channels c JOIN notification_deliveries d ON d.channel_id = c.id
        WHERE d.id = ? AND d.status = 'PROCESSING' AND d.lease_token = ? AND d.lease_expires_at > CURRENT_TIMESTAMP(3)`, [claim.id, claim.token]);
      if (!channel.length) return;
      if (!channel[0]!.enabled) {
        await this.pool.query("UPDATE notification_deliveries SET status = 'CANCELLED', lease_token = NULL, lease_expires_at = NULL WHERE id = ? AND lease_token = ?", [claim.id, claim.token]);
        return;
      }
      await deliver(decrypt(claim.encrypted_config, this.key, claim.channel_id), claim.id, JSON.parse(claim.payload), signal);
    } catch (error) { failure = error instanceof DeliveryError ? error.code : 'INVALID_CHANNEL_CONFIGURATION'; }
    await this.finish(claim, failure);
  }
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.routePending();
        if (signal.aborted) break;
        const claim = await this.claim();
        if (claim) await this.send(claim, signal);
      } catch (error) { console.error(JSON.stringify({ event: 'notification_worker_error', code: errorCode(error) })); }
      await sleep(500, undefined, { signal }).catch(() => undefined);
    }
  }
}
