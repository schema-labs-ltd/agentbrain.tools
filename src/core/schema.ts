import type { Sql } from "./sql.js";

/**
 * Ordered schema migrations. Each entry runs once, inside a transaction, and is
 * recorded in schema_migrations. Never edit a migration after release; add a new one.
 */
const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_secret_hash TEXT,
      metadata TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE oauth_requests (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      state TEXT,
      scopes TEXT NOT NULL,
      resource TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      scopes TEXT NOT NULL,
      resource TEXT,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE oauth_tokens (
      token_hash TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      family_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scopes TEXT NOT NULL,
      resource TEXT,
      expires_at INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX oauth_tokens_family ON oauth_tokens (family_id)`,
    `CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, name_key)
    )`,
    `CREATE TABLE brains (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      title TEXT,
      description TEXT,
      status TEXT NOT NULL,
      last_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    )`,
    `CREATE INDEX brains_project ON brains (project_id)`,
    `CREATE TABLE documents (
      brain_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      PRIMARY KEY (brain_id, id)
    )`,
    `CREATE TABLE revisions (
      brain_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      summary TEXT,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (brain_id, document_id, revision)
    )`,
    `CREATE TABLE events (
      brain_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      document_id TEXT,
      revision INTEGER,
      actor TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (brain_id, seq)
    )`,
    `CREATE TABLE idempotency (
      user_id TEXT NOT NULL,
      key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      brain_id TEXT,
      response TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    )`,
  ],
];

export function migrate(sql: Sql): void {
  sql.run(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
  const applied = new Set(sql.all<{ version: number }>(`SELECT version FROM schema_migrations`).map((r) => r.version));
  MIGRATIONS.forEach((statements, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    sql.transaction(() => {
      for (const statement of statements) sql.run(statement);
      sql.run(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, version, Date.now());
    });
  });
}
