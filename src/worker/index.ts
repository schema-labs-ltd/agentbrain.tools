import { DurableObject } from "cloudflare:workers";
import type { Hono } from "hono";
import type { EventService } from "../core/events.js";
import { createInstance, type InstanceConfig } from "../core/instance.js";
import type { Row, Sql, SqlValue } from "../core/sql.js";

export interface Env extends InstanceConfig {
  AGENT_BRAIN: DurableObjectNamespace<AgentBrainStore>;
}

/** Durable Object SQLite binds BLOBs from ArrayBuffer, not from typed-array views. */
function bindable(params: SqlValue[]): (string | number | null | ArrayBuffer)[] {
  return params.map((p) => (p instanceof Uint8Array ? (p.buffer.slice(p.byteOffset, p.byteOffset + p.byteLength) as ArrayBuffer) : p));
}

/** Sql adapter over Durable Object SQLite storage. Nested transactions join the outer one. */
function durableObjectSql(storage: DurableObjectStorage): Sql {
  let depth = 0;
  return {
    all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec(sql, ...bindable(params)).toArray() as unknown as T[];
    },
    run(sql: string, ...params: SqlValue[]): number {
      return storage.sql.exec(sql, ...bindable(params)).rowsWritten;
    },
    transaction<T>(fn: () => T): T {
      if (depth > 0) return fn();
      depth++;
      try {
        return storage.transactionSync(fn);
      } finally {
        depth--;
      }
    },
  };
}

/**
 * All state for a small private instance lives in one SQLite-backed Durable
 * Object, so every write is serialised and transactional, exactly as in Docker.
 */
export class AgentBrainStore extends DurableObject<Env> {
  private readonly app: Hono;
  private readonly events: EventService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const instance = createInstance(durableObjectSql(ctx.storage), env, {
      afterMcpRequest: () => this.ctx.waitUntil(this.deliver()),
    });
    this.app = instance.app;
    this.events = instance.events;
  }

  override fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.app.fetch(request));
  }

  /** Retries wake the object through its alarm. */
  override async alarm(): Promise<void> {
    await this.deliver();
  }

  private async deliver(): Promise<void> {
    try {
      const next = await this.events.deliver();
      if (next) {
        const current = await this.ctx.storage.getAlarm();
        if (!current || current > next) await this.ctx.storage.setAlarm(next);
      }
    } catch (e) {
      console.error("event delivery failed", e);
    }
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    const stub = env.AGENT_BRAIN.get(env.AGENT_BRAIN.idFromName("instance"));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
