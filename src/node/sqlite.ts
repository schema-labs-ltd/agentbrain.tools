import Database from "better-sqlite3";
import type { Row, Sql, SqlValue } from "../core/sql.js";

/** better-sqlite3 binds BLOBs from Buffer only. */
function bindable(params: SqlValue[]): unknown[] {
  return params.map((p) =>
    p instanceof Uint8Array ? Buffer.from(p.buffer, p.byteOffset, p.byteLength) : p instanceof ArrayBuffer ? Buffer.from(p) : p,
  );
}

/** Sql adapter over better-sqlite3. Nested transactions join the outer one. */
export function openSqlite(path: string): Sql {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return {
    all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
      const stmt = db.prepare(sql);
      if (stmt.reader) return stmt.all(...bindable(params)) as T[];
      stmt.run(...bindable(params));
      return [];
    },
    run(sql: string, ...params: SqlValue[]): number {
      return db.prepare(sql).run(...bindable(params)).changes;
    },
    transaction<T>(fn: () => T): T {
      if (db.inTransaction) return fn();
      return db.transaction(fn).immediate();
    },
  };
}
