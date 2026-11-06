import Database from "better-sqlite3";
import type { Row, Sql, SqlValue } from "../core/sql.js";

/** Sql adapter over better-sqlite3. Nested transactions join the outer one. */
export function openSqlite(path: string): Sql {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return {
    all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
      const stmt = db.prepare(sql);
      if (stmt.reader) return stmt.all(...params) as T[];
      stmt.run(...params);
      return [];
    },
    run(sql: string, ...params: SqlValue[]): number {
      return db.prepare(sql).run(...params).changes;
    },
    transaction<T>(fn: () => T): T {
      if (db.inTransaction) return fn();
      return db.transaction(fn).immediate();
    },
  };
}
