/**
 * A minimal synchronous SQL interface. Both better-sqlite3 (Docker/Node) and
 * Cloudflare Durable Object SQLite storage are synchronous, so the core store
 * runs unchanged on either runtime and keeps every multi-statement write
 * inside a real transaction.
 */
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface Sql {
  /** Run a statement and return all rows (empty for statements without results). */
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[];
  /** Run a statement that changes data and return the number of changed rows. */
  run(sql: string, ...params: SqlValue[]): number;
  /** Run fn atomically. A thrown error rolls back every change made inside it. */
  transaction<T>(fn: () => T): T;
}

export function one<T extends Row = Row>(sql: Sql, query: string, ...params: SqlValue[]): T | undefined {
  return sql.all<T>(query, ...params)[0];
}
