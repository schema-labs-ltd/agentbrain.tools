import { sha256Hex } from "./crypto.js";
import { BrainError } from "./errors.js";
import { newOpaqueId, newSecret } from "./ids.js";
import type { Scope } from "./oauth.js";
import { one, type Sql } from "./sql.js";

/** Every API key starts with this, so the MCP endpoint can tell keys from OAuth access tokens. */
export const API_KEY_PREFIX = "abk_";
export const MAX_KEYS_PER_USER = 50;
const MAX_NAME_LENGTH = 100;
/** last_used_at is written at most this often per key, to keep reads cheap. */
const LAST_USED_RESOLUTION_MS = 60 * 1000;

export type KeyAccess = "read" | "write";

export const ACCESS_SCOPES: Record<KeyAccess, Scope[]> = {
  read: ["brain:read"],
  write: ["brain:read", "brain:write"],
};

export interface ApiKeySummary {
  id: string;
  name: string;
  /** The first characters of the key, enough to recognise it. Never the whole key. */
  hint: string;
  access: KeyAccess;
  /** Project tokens the key is limited to, or null for every project. */
  projects: { token: string; name: string }[] | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What a verified key may do. */
export interface ApiKeyPrincipal {
  id: string;
  userId: string;
  name: string;
  access: KeyAccess;
  scopes: Scope[];
  projects: string[] | null;
}

type KeyRow = {
  id: string;
  user_id: string;
  name: string;
  hint: string;
  access: KeyAccess;
  projects: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
};

/**
 * Long-lived API keys for agents that cannot complete an OAuth sign-in, such as
 * a server calling the Claude API with a static Authorization header. Only a
 * SHA-256 hash of each key is stored; the key itself is shown once, at creation.
 */
export class ApiKeyService {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
  ) {}

  async create(userId: string, input: { name: string; access: KeyAccess; projects?: string[] }): Promise<{ key: string; summary: ApiKeySummary }> {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (!name) throw new BrainError("invalid_request", "Give the key a name, for example the agent that will use it.");
    if (name.length > MAX_NAME_LENGTH) throw new BrainError("invalid_request", `Key names are limited to ${MAX_NAME_LENGTH} characters.`);
    if (input.access !== "read" && input.access !== "write") throw new BrainError("invalid_request", "Choose read-only or read and write access.");
    const projects = input.projects?.length ? [...new Set(input.projects)] : null;
    if (projects) {
      for (const token of projects) {
        if (!one(this.sql, `SELECT id FROM projects WHERE id = ? AND user_id = ?`, token, userId)) {
          throw new BrainError("invalid_request", "One of the chosen projects does not exist in your account.");
        }
      }
    }
    const active = one<{ n: number }>(this.sql, `SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL`, userId)!.n;
    if (active >= MAX_KEYS_PER_USER) throw new BrainError("limit_exceeded", `You can have up to ${MAX_KEYS_PER_USER} keys. Revoke one you no longer use first.`);
    const key = API_KEY_PREFIX + newSecret();
    const id = newOpaqueId();
    this.sql.run(
      `INSERT INTO api_keys (id, user_id, name, key_hash, hint, access, projects, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      name,
      await sha256Hex(key),
      key.slice(0, API_KEY_PREFIX.length + 6),
      input.access,
      projects ? JSON.stringify(projects) : null,
      this.now(),
    );
    return { key, summary: this.list(userId).find((k) => k.id === id)! };
  }

  /** The user's keys that still work, newest first. */
  list(userId: string): ApiKeySummary[] {
    const names = new Map(
      this.sql.all<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE user_id = ?`, userId).map((p) => [p.id, p.name]),
    );
    return this.sql
      .all<KeyRow>(`SELECT * FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`, userId)
      .map((r) => ({
        id: r.id,
        name: r.name,
        hint: r.hint,
        access: r.access,
        projects: r.projects ? (JSON.parse(r.projects) as string[]).map((token) => ({ token, name: names.get(token) ?? "(deleted project)" })) : null,
        createdAt: new Date(r.created_at).toISOString(),
        lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
      }));
  }

  /** Revoke one of the user's keys. It stops working on the next request. Returns false if there was nothing to revoke. */
  revoke(userId: string, id: string): boolean {
    const row = one<{ id: string }>(this.sql, `SELECT id FROM api_keys WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, id, userId);
    if (!row) return false;
    this.sql.run(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`, this.now(), id);
    return true;
  }

  /** Check a presented key on every request, and record when it was last used. */
  async verify(key: string): Promise<ApiKeyPrincipal | undefined> {
    if (!key.startsWith(API_KEY_PREFIX) || key.length > 200) return undefined;
    const row = one<KeyRow>(this.sql, `SELECT * FROM api_keys WHERE key_hash = ?`, await sha256Hex(key));
    if (!row || row.revoked_at) return undefined;
    const now = this.now();
    if (!row.last_used_at || row.last_used_at + LAST_USED_RESOLUTION_MS <= now) {
      this.sql.run(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`, now, row.id);
    }
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      access: row.access,
      scopes: [...ACCESS_SCOPES[row.access]],
      projects: row.projects ? (JSON.parse(row.projects) as string[]) : null,
    };
  }
}
