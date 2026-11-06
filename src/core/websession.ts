import { sha256Hex } from "./crypto.js";
import { newSecret } from "./ids.js";
import { one, type Sql } from "./sql.js";

export const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Failed sign-ins allowed per client address within one window. */
export const WEB_LOGIN_MAX_FAILURES = 10;
export const WEB_LOGIN_WINDOW_MS = 15 * 60 * 1000;

/** Browser sessions for the read-only website, stored as hashes of random cookie values. */
export class WebSessionService {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
  ) {}

  async create(userId: string): Promise<{ token: string; expiresAt: number }> {
    const now = this.now();
    this.sql.run(`DELETE FROM web_sessions WHERE expires_at <= ?`, now);
    const token = newSecret();
    const expiresAt = now + WEB_SESSION_TTL_MS;
    this.sql.run(
      `INSERT INTO web_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
      await sha256Hex(token),
      userId,
      now,
      expiresAt,
    );
    return { token, expiresAt };
  }

  /** The signed-in user for a cookie value, or undefined when it is missing, unknown or expired. */
  async verify(token: string | undefined): Promise<{ userId: string; email: string } | undefined> {
    if (!token || token.length > 200) return undefined;
    const row = one<{ user_id: string; email: string; expires_at: number }>(
      this.sql,
      `SELECT s.user_id, s.expires_at, u.email FROM web_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      await sha256Hex(token),
    );
    if (!row || row.expires_at <= this.now()) return undefined;
    return { userId: row.user_id, email: row.email };
  }

  async destroy(token: string | undefined): Promise<void> {
    if (!token) return;
    this.sql.run(`DELETE FROM web_sessions WHERE token_hash = ?`, await sha256Hex(token));
  }

  /** True while the address may still try to sign in. */
  canAttempt(key: string): boolean {
    const row = one<{ failures: number; window_start: number }>(this.sql, `SELECT failures, window_start FROM web_login_failures WHERE key = ?`, key);
    if (!row || row.window_start + WEB_LOGIN_WINDOW_MS <= this.now()) return true;
    return row.failures < WEB_LOGIN_MAX_FAILURES;
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.sql.run(`DELETE FROM web_login_failures WHERE window_start + ? <= ?`, WEB_LOGIN_WINDOW_MS, now);
    this.sql.run(
      `INSERT INTO web_login_failures (key, failures, window_start) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET failures = failures + 1`,
      key,
      now,
    );
  }

  clearFailures(key: string): void {
    this.sql.run(`DELETE FROM web_login_failures WHERE key = ?`, key);
  }
}
