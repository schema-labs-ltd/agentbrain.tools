import { DurableObject } from "cloudflare:workers";
import type { Hono } from "hono";
import type { EventService } from "../core/events.js";
import { createInstance, type InstanceConfig } from "../core/instance.js";
import type { Row, Sql, SqlValue } from "../core/sql.js";

export interface Env extends InstanceConfig {
  AGENT_BRAIN: DurableObjectNamespace<AgentBrainStore>;
}

/** Sql adapter over Durable Object SQLite storage. Nested transactions join the outer one. */
function durableObjectSql(storage: DurableObjectStorage): Sql {
  let depth = 0;
  return {
    all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[] {
      return storage.sql.exec<T>(sql, ...params).toArray();
    },
    run(sql: string, ...params: SqlValue[]): number {
      return storage.sql.exec(sql, ...params).rowsWritten;
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
