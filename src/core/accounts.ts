import type { ClerkAuth } from "./clerk.js";
import { newOpaqueId } from "./ids.js";
import { one, type Sql } from "./sql.js";

/** How long a user's Clerk status is trusted before it is checked again. */
export const ACCOUNT_RECHECK_MS = 15 * 60 * 1000;

/** Stored in password_hash for Clerk users. It is not a valid hash, so password sign-in always fails. */
const NO_PASSWORD = "clerk";

export type ClerkSignIn = { ok: true; userId: string; email: string } | { ok: false; reason: "invalid" | "no_email" | "inactive" | "unavailable" };

/**
 * Agent Brain accounts. Every project, brain, image, OAuth grant and web session
 * belongs to one row in users. With Clerk configured, each row is linked to one
 * Clerk user, and removing or suspending that user in Clerk switches the account off.
 */
export class AccountService {
  constructor(
    private readonly sql: Sql,
    readonly clerk: ClerkAuth | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Sign in with a Clerk session token from the browser. The account is found by
   * Clerk user ID, then by verified email (which links the original owner account,
   * and survives a move to another Clerk instance), and is otherwise created empty.
   */
  async signInWithClerk(token: string | undefined): Promise<ClerkSignIn> {
    if (!this.clerk) return { ok: false, reason: "invalid" };
    let clerkUserId: string | undefined;
    let user;
    try {
      clerkUserId = await this.clerk.verifySessionToken(token);
      if (!clerkUserId) return { ok: false, reason: "invalid" };
      user = await this.clerk.getUser(clerkUserId);
    } catch (e) {
      console.error("Clerk sign-in check failed", e);
      return { ok: false, reason: "unavailable" };
    }
    if (!user || !user.active) return { ok: false, reason: "inactive" };
    if (!user.email) return { ok: false, reason: "no_email" };
    const email = user.email;
    const userId = this.sql.transaction(() => {
      const now = this.now();
      const byClerk = one<{ id: string }>(this.sql, `SELECT id FROM users WHERE clerk_user_id = ?`, clerkUserId);
      const byEmail = one<{ id: string }>(this.sql, `SELECT id FROM users WHERE email = ?`, email);
      if (byClerk) {
        // Keep the email in step with Clerk unless another account already uses it.
        if (!byEmail || byEmail.id === byClerk.id) {
          this.sql.run(`UPDATE users SET email = ?, disabled = 0, clerk_checked_at = ? WHERE id = ?`, email, now, byClerk.id);
        } else {
          this.sql.run(`UPDATE users SET disabled = 0, clerk_checked_at = ? WHERE id = ?`, now, byClerk.id);
        }
        return byClerk.id;
      }
      if (byEmail) {
        this.sql.run(`UPDATE users SET clerk_user_id = ?, disabled = 0, clerk_checked_at = ? WHERE id = ?`, clerkUserId, now, byEmail.id);
        return byEmail.id;
      }
      const id = newOpaqueId();
      this.sql.run(
        `INSERT INTO users (id, email, password_hash, created_at, clerk_user_id, clerk_checked_at, disabled) VALUES (?, ?, ?, ?, ?, ?, 0)`,
        id,
        email,
        NO_PASSWORD,
        now,
        clerkUserId,
        now,
      );
      return id;
    });
    return { ok: true, userId, email };
  }

  /**
   * True while the account may be used. Accounts linked to Clerk are re-checked
   * against Clerk at most every ACCOUNT_RECHECK_MS; when Clerk cannot be reached
   * the last known status stands. Accounts never linked to Clerk (the original
   * owner, until first Clerk sign-in, and every account without Clerk) stay active.
   */
  async isActive(userId: string): Promise<boolean> {
    const row = one<{ clerk_user_id: string | null; clerk_checked_at: number | null; disabled: number }>(
      this.sql,
      `SELECT clerk_user_id, clerk_checked_at, disabled FROM users WHERE id = ?`,
      userId,
    );
    if (!row) return false;
    if (!this.clerk || !row.clerk_user_id) return row.disabled === 0;
    if (row.clerk_checked_at && row.clerk_checked_at + ACCOUNT_RECHECK_MS > this.now()) return row.disabled === 0;
    try {
      const user = await this.clerk.getUser(row.clerk_user_id);
      const active = !!user && user.active;
      this.sql.run(`UPDATE users SET disabled = ?, clerk_checked_at = ? WHERE id = ?`, active ? 0 : 1, this.now(), userId);
      return active;
    } catch (e) {
      console.error("Clerk status check failed; keeping the last known status", e);
      return row.disabled === 0;
    }
  }
}

/** What the person sees when a Clerk sign-in is refused. */
export const CLERK_SIGN_IN_ERRORS: Record<"invalid" | "no_email" | "inactive" | "unavailable", string> = {
  invalid: "Your sign-in could not be confirmed. Sign in again.",
  no_email: "Your account needs a verified email address before it can use Agent Brain.",
  inactive: "This account cannot use Agent Brain. Ask the person who invited you.",
  unavailable: "Sign-in is unavailable right now. Try again in a minute.",
};
