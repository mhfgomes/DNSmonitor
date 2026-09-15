import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import type { Pool } from 'mariadb';
import { z } from 'zod';
import { transaction } from '../../database/src/connection.js';

export const emailSchema = z.email().max(254).transform(value => value.toLowerCase());
export const passwordSchema = z.string().min(12).max(256);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const options = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export interface Session { userId: string; email: string; role: string; csrfToken: string; tokenHash: string }
export function equalToken(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Auth {
  private readonly dummy = hash(randomBytes(32), options);
  private activeHashes = 0;
  constructor(readonly pool: Pool) {}

  async setupRequired(): Promise<boolean> {
    return !(await this.pool.query('SELECT id FROM users LIMIT 1')).length;
  }

  private async limit(key: string, maximum: number): Promise<void> {
    const allowed = await transaction(this.pool, async connection => {
      const id = digest(key);
      await connection.query(`INSERT INTO login_limits (id, attempts, expires_at) VALUES (?, 1, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 15 MINUTE))
        ON DUPLICATE KEY UPDATE attempts = IF(expires_at <= CURRENT_TIMESTAMP(3), 1, attempts + 1), expires_at = IF(expires_at <= CURRENT_TIMESTAMP(3), DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 15 MINUTE), expires_at)`, [id]);
      return (await connection.query('SELECT attempts FROM login_limits WHERE id = ?', [id]))[0].attempts <= maximum;
    });
    if (!allowed) throw new AuthError(429, 'Too many attempts; try again in 15 minutes');
  }

  async setup(email: string, password: string, token: string, expectedToken: string | undefined, ip: string): Promise<void> {
    if (!await this.setupRequired()) throw new AuthError(409, 'Setup is already complete');
    await this.limit(`setup:${ip}`, 10);
    if (!expectedToken || !equalToken(token, expectedToken)) throw new AuthError(403, 'Invalid installation token');
    email = emailSchema.parse(email); passwordSchema.parse(password);
    if (this.activeHashes >= 2) throw new AuthError(429, 'Account service busy; retry shortly');
    this.activeHashes++;
    try {
      const encoded = await hash(password, options);
      await this.provision(async connection => {
        if ((await connection.query('SELECT id FROM users LIMIT 1')).length) throw new AuthError(409, 'Setup is already complete');
        const id = randomUUID();
        await connection.query("INSERT INTO users (id,email,password_hash,role) VALUES (?,?,?,'ADMIN')", [id,email,encoded]);
        await connection.query("INSERT INTO audit_events (id,user_id,action) VALUES (?,?,'INITIAL_SETUP')",[randomUUID(),id]);
      });
    } finally { this.activeHashes--; }
  }

  private async provision(work: (connection: import('mariadb').PoolConnection) => Promise<void>): Promise<void> {
    const connection = await this.pool.getConnection(); let locked = false;
    try {
      locked = (await connection.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':accounts'), 5) AS acquired"))[0].acquired === 1;
      if (!locked) throw new AuthError(429, 'Account service busy; retry shortly');
      await connection.beginTransaction();
      try { await work(connection); await connection.commit(); }
      catch (error) { await connection.rollback(); throw error; }
    } finally {
      try { if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':accounts'))"); }
      finally { await connection.release(); }
    }
  }

  async changePassword(session: Session, currentPassword: string, newPassword: string, ip: string): Promise<void> {
    passwordSchema.parse(newPassword);
    await this.limit(`password-user:${session.userId}`, 10);
    await this.limit(`password-ip:${ip}`, 30);
    if (this.activeHashes >= 2) throw new AuthError(429, 'Account service busy; retry shortly');
    this.activeHashes++;
    try {
      const user = (await this.pool.query('SELECT password_hash FROM users WHERE id = ?', [session.userId]))[0];
      if (!user || !await verify(user.password_hash, currentPassword)) throw new AuthError(400, 'Current password is incorrect');
      if (currentPassword === newPassword) throw new AuthError(400, 'Choose a different new password');
      const encoded = await hash(newPassword, options);
      await transaction(this.pool, async connection => {
        const current = (await connection.query('SELECT password_hash FROM users WHERE id = ? FOR UPDATE', [session.userId]))[0];
        if (current?.password_hash !== user.password_hash) throw new AuthError(409, 'Password changed; sign in again');
        if (!(await connection.query('SELECT token_hash FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP(3) FOR UPDATE', [session.tokenHash,session.userId])).length) throw new AuthError(401, 'Sign in again');
        await connection.query('UPDATE users SET password_hash=? WHERE id=?', [encoded,session.userId]);
        await connection.query('DELETE FROM sessions WHERE user_id=?', [session.userId]);
        await connection.query("INSERT INTO audit_events (id,user_id,action) VALUES (?,?,'PASSWORD_CHANGED')", [randomUUID(),session.userId]);
      });
    } finally { this.activeHashes--; }
  }

  /** CLI-only account provisioning/reset. Resets revoke every existing session. */
  async setAdmin(email: string, password: string): Promise<void> {
    email = emailSchema.parse(email);
    passwordSchema.parse(password);
    const encoded = await hash(password, options);
    await this.provision(async connection => {
      await connection.query("INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'ADMIN') ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'ADMIN'", [randomUUID(), email, encoded]);
      const rows = await connection.query<{ id: string }[]>('SELECT id FROM users WHERE email = ?', [email]);
      await connection.query('DELETE FROM sessions WHERE user_id = ?', [rows[0]!.id]);
    });
  }

  async login(email: string, password: string, ip: string): Promise<{ token: string; session: Session } | undefined> {
    email = emailSchema.parse(email);
    if (password.length > 256) return;
    // Persisted limits apply across API replicas. Never trust forwarded IPs by default.
    const allowed = await transaction(this.pool, async connection => {
      let allowed = true;
      for (const [key, maximum] of [[`ip:${ip}`, 30], [`email:${email}`, 10]] as const) {
        const id = digest(key);
        await connection.query(`INSERT INTO login_limits (id, attempts, expires_at) VALUES (?, 1, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 15 MINUTE))
          ON DUPLICATE KEY UPDATE attempts = IF(expires_at <= CURRENT_TIMESTAMP(3), 1, attempts + 1), expires_at = IF(expires_at <= CURRENT_TIMESTAMP(3), DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 15 MINUTE), expires_at)`, [id]);
        const rows = await connection.query<{ attempts: number }[]>('SELECT attempts FROM login_limits WHERE id = ?', [id]);
        if (rows[0]!.attempts > maximum) allowed = false;
      }
      return allowed;
    });
    if (!allowed) throw new AuthError(429, 'Too many login attempts');
    if (this.activeHashes >= 2) throw new AuthError(429, 'Login busy; retry shortly');
    this.activeHashes++;
    try {
      const rows = await this.pool.query<{ id: string; email: string; role: string; password_hash: string }[]>('SELECT id, email, role, password_hash FROM users WHERE email = ?', [email]);
      const user = rows[0];
      const valid = await verify(user?.password_hash ?? await this.dummy, password);
      if (!user || !valid) return;
      const token = randomBytes(32).toString('hex');
      const csrfToken = randomBytes(32).toString('hex');
      const tokenHash = digest(token);
      const stored = await transaction(this.pool, async connection => {
        const current = await connection.query<{ password_hash: string }[]>('SELECT password_hash FROM users WHERE id = ? FOR UPDATE', [user.id]);
        if (current[0]?.password_hash !== user.password_hash) return false;
        await connection.query('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 12 HOUR))', [tokenHash, user.id, csrfToken]);
        await connection.query("INSERT INTO audit_events (id, user_id, action) VALUES (?, ?, 'LOGIN')", [randomUUID(), user.id]);
        return true;
      });
      if (!stored) return;
      return { token, session: { userId: user.id, email, role: user.role, csrfToken, tokenHash } };
    } finally { this.activeHashes--; }
  }
  async session(token: string | undefined): Promise<Session | undefined> {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return;
    const rows = await this.pool.query<{ user_id: string; email: string; role: string; csrf_token: string }[]>(`SELECT s.user_id, u.email, u.role, s.csrf_token FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP(3)`, [digest(token)]);
    const row = rows[0];
    return row ? { userId: row.user_id, email: row.email, role: row.role, csrfToken: row.csrf_token, tokenHash: digest(token) } : undefined;
  }
  async logout(session: Session): Promise<void> { await this.pool.query('DELETE FROM sessions WHERE token_hash = ?', [session.tokenHash]); }
  async cleanup(): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP(3) LIMIT 1000');
    await this.pool.query('DELETE FROM login_limits WHERE expires_at <= CURRENT_TIMESTAMP(3) LIMIT 1000');
  }
}
export class AuthError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
