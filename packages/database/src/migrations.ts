import { createHash } from 'node:crypto';
import type { Pool } from 'mariadb';

// DDL commits implicitly in MariaDB. Each statement is restartable, and a database
// advisory lock serializes migration runners. Never edit an applied migration.
const migrations = [{ version: 1, statements: [
  `CREATE TABLE IF NOT EXISTS resolver_groups (
    id CHAR(36) PRIMARY KEY, name VARCHAR(200) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS resolvers (
    id CHAR(36) PRIMARY KEY, group_id CHAR(36) NOT NULL,
    resolver_key VARCHAR(100) COLLATE utf8mb4_bin NOT NULL, config JSON NOT NULL,
    UNIQUE KEY group_resolver (group_id, resolver_key),
    FOREIGN KEY (group_id) REFERENCES resolver_groups(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS monitors (
    id CHAR(36) PRIMARY KEY, name VARCHAR(200) NOT NULL, config JSON NOT NULL,
    resolver_group_id CHAR(36) NOT NULL, config_revision INT NOT NULL DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT TRUE, next_check_at DATETIME(3) NOT NULL,
    lease_token CHAR(36) NULL, lease_expires_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX due_monitors (enabled, next_check_at, lease_expires_at),
    FOREIGN KEY (resolver_group_id) REFERENCES resolver_groups(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS monitor_states (
    monitor_id CHAR(36) PRIMARY KEY, state JSON NOT NULL,
    current_value JSON NULL, active_incident_id CHAR(36) NULL,
    FOREIGN KEY (monitor_id) REFERENCES monitors(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS check_runs (
    id CHAR(36) PRIMARY KEY, monitor_id CHAR(36) NOT NULL,
    worker_id VARCHAR(100) NOT NULL, config_revision INT NOT NULL,
    scheduled_at DATETIME(3) NOT NULL, started_at DATETIME(3) NOT NULL,
    finished_at DATETIME(3) NULL, status VARCHAR(20) NOT NULL,
    resolver_results JSON NULL, observation JSON NULL, error_code VARCHAR(100) NULL,
    INDEX monitor_history (monitor_id, started_at), INDEX retention (finished_at),
    FOREIGN KEY (monitor_id) REFERENCES monitors(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS incidents (
    id CHAR(36) PRIMARY KEY, monitor_id CHAR(36) NOT NULL,
    status VARCHAR(20) NOT NULL, reason VARCHAR(100) NOT NULL,
    opened_at DATETIME(3) NOT NULL, resolved_at DATETIME(3) NULL,
    initial_value JSON NULL, current_value JSON NULL,
    INDEX monitor_incidents (monitor_id, opened_at),
    FOREIGN KEY (monitor_id) REFERENCES monitors(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS dns_events (
    id CHAR(36) PRIMARY KEY, monitor_id CHAR(36) NOT NULL,
    check_run_id CHAR(36) NULL, incident_id CHAR(36) NULL,
    type VARCHAR(40) NOT NULL, payload JSON NOT NULL, created_at DATETIME(3) NOT NULL,
    UNIQUE KEY execution_event (check_run_id, type), INDEX monitor_events (monitor_id, created_at),
    FOREIGN KEY (monitor_id) REFERENCES monitors(id),
    FOREIGN KEY (check_run_id) REFERENCES check_runs(id) ON DELETE SET NULL,
    FOREIGN KEY (incident_id) REFERENCES incidents(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS notification_jobs (
    id CHAR(36) PRIMARY KEY, event_id CHAR(36) NOT NULL UNIQUE,
    payload JSON NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    attempts INT NOT NULL DEFAULT 0, next_attempt_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    FOREIGN KEY (event_id) REFERENCES dns_events(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS workers (
    id VARCHAR(100) PRIMARY KEY, status VARCHAR(20) NOT NULL,
    last_heartbeat DATETIME(3) NOT NULL, active_jobs INT NOT NULL
  ) ENGINE=InnoDB`,
] }, { version: 2, statements: [
  'ALTER TABLE monitors DROP INDEX IF EXISTS due_monitors',
  'ALTER TABLE monitors ADD INDEX IF NOT EXISTS due_monitors (enabled, next_check_at, id, lease_expires_at)',
] }, { version: 3, statements: [
  // Lease updates must not move entries in the index concurrent claimers scan.
  'ALTER TABLE monitors DROP INDEX IF EXISTS due_monitors',
  'ALTER TABLE monitors ADD INDEX IF NOT EXISTS due_monitors (enabled, next_check_at, id)',
] }, { version: 4, statements: [
  `CREATE TABLE IF NOT EXISTS notification_channels (
    id CHAR(36) PRIMARY KEY, name VARCHAR(200) NOT NULL, type VARCHAR(20) NOT NULL,
    encrypted_config TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS alert_rules (
    id CHAR(36) PRIMARY KEY, name VARCHAR(200) NOT NULL, config JSON NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS notification_deliveries (
    id CHAR(36) PRIMARY KEY, job_id CHAR(36) NOT NULL, channel_id CHAR(36) NOT NULL,
    encrypted_config TEXT NOT NULL, payload JSON NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', attempts INT NOT NULL DEFAULT 0,
    next_attempt_at DATETIME(3) NOT NULL, lease_token CHAR(36) NULL, lease_expires_at DATETIME(3) NULL,
    last_error VARCHAR(100) NULL, sent_at DATETIME(3) NULL,
    UNIQUE KEY job_channel (job_id, channel_id), INDEX delivery_due (status, next_attempt_at, id),
    FOREIGN KEY (job_id) REFERENCES notification_jobs(id),
    FOREIGN KEY (channel_id) REFERENCES notification_channels(id)
  ) ENGINE=InnoDB`,
  'ALTER TABLE notification_jobs ADD INDEX IF NOT EXISTS outbox_due (status, created_at, id)',
  `CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL DEFAULT 'ADMIN',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY, user_id CHAR(36) NOT NULL, csrf_token CHAR(64) NOT NULL,
    expires_at DATETIME(3) NOT NULL, INDEX session_expiry (expires_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS login_limits (
    id CHAR(64) PRIMARY KEY, attempts INT NOT NULL, expires_at DATETIME(3) NOT NULL,
    INDEX login_expiry (expires_at)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, action VARCHAR(80) NOT NULL,
    entity_id CHAR(36) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX audit_created (created_at)
  ) ENGINE=InnoDB`,
  'ALTER TABLE incidents ADD COLUMN IF NOT EXISTS acknowledged_at DATETIME(3) NULL',
] }, { version: 5, statements: [
  `CREATE TABLE IF NOT EXISTS monitor_hourly (
    monitor_id CHAR(36) NOT NULL, hour_at DATETIME NOT NULL, config_revision INT NOT NULL,
    checks BIGINT NOT NULL, completed BIGINT NOT NULL, healthy BIGINT NOT NULL,
    warning BIGINT NOT NULL, critical BIGINT NOT NULL, unknown_count BIGINT NOT NULL,
    errors BIGINT NOT NULL, abandoned BIGINT NOT NULL,
    latency_sum DOUBLE NOT NULL, latency_count BIGINT NOT NULL, latency_max DOUBLE NOT NULL,
    PRIMARY KEY (monitor_id, hour_at, config_revision), INDEX hourly_retention (hour_at),
    FOREIGN KEY (monitor_id) REFERENCES monitors(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS maintenance (
    name VARCHAR(40) PRIMARY KEY, next_run_at DATETIME(3) NOT NULL,
    last_completed_at DATETIME(3) NULL, last_result JSON NULL
  ) ENGINE=InnoDB`,
  "INSERT IGNORE INTO maintenance (name, next_run_at) VALUES ('retention', CURRENT_TIMESTAMP(3))",
  'ALTER TABLE dns_events ADD INDEX IF NOT EXISTS event_retention (created_at, id)',
  'ALTER TABLE notification_jobs ADD INDEX IF NOT EXISTS job_retention (created_at, id)',
  'ALTER TABLE incidents ADD INDEX IF NOT EXISTS incident_retention (status, resolved_at)',
  'ALTER TABLE workers ADD INDEX IF NOT EXISTS worker_retention (last_heartbeat)',
] }, { version: 6, statements: [
  'ALTER TABLE monitors ADD COLUMN IF NOT EXISTS history_revision INT NOT NULL DEFAULT 1',
  'ALTER TABLE incidents ADD COLUMN IF NOT EXISTS closure_reason VARCHAR(80) NULL',
] }];

export async function migrate(pool: Pool): Promise<void> {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const result = await connection.query<{ acquired: number }[]>("SELECT GET_LOCK(CONCAT(DATABASE(), ':migrations'), 30) AS acquired");
    if (result[0]?.acquired !== 1) throw new Error('Migration lock unavailable');
    locked = true;
    await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT PRIMARY KEY, checksum CHAR(64) NOT NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`);
    for (const migration of migrations) {
      const checksum = createHash('sha256').update(migration.statements.join('\n')).digest('hex');
      const rows = await connection.query<{ checksum: string }[]>('SELECT checksum FROM schema_migrations WHERE version = ?', [migration.version]);
      if (rows.length) {
        if (rows[0]!.checksum !== checksum) throw new Error('Applied migration checksum mismatch');
        continue;
      }
      for (const statement of migration.statements) await connection.query(statement);
      await connection.query('INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)', [migration.version, checksum]);
    }
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':migrations'))");
    await connection.release();
  }
}

export async function requireSchema(pool: Pool): Promise<void> {
  const rows = await pool.query<{ version: number }[]>('SELECT MAX(version) AS version FROM schema_migrations');
  if (rows[0]?.version !== migrations.at(-1)!.version) throw new Error('Database migrations required');
}
