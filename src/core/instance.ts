import type { Hono } from "hono";
import { createApp } from "./app.js";
import { hashPassword, verifyPassword } from "./crypto.js";
import { EventService, type EventOptions } from "./events.js";
import { OAuthService, type FetchFn } from "./oauth.js";
import { migrate } from "./schema.js";
import type { Sql } from "./sql.js";
import { BrainStore, DEFAULT_LIMITS, type Limits } from "./store.js";

/** Runtime-independent configuration, read from environment variables or Worker bindings. */
export interface InstanceConfig {
  PUBLIC_URL?: string;
  OWNER_EMAIL?: string;
  OWNER_PASSWORD?: string;
  LIMIT_DOCUMENT_BYTES?: string;
  LIMIT_BRAIN_DOCUMENTS?: string;
  LIMIT_BRAIN_BYTES?: string;
  LIMIT_REVISIONS_PER_DOCUMENT?: string;
  LIMIT_EVENTS_PER_BRAIN?: string;
}

function intOr(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function limitsFrom(config: InstanceConfig): Limits {
  return {
    documentBytes: intOr(config.LIMIT_DOCUMENT_BYTES, DEFAULT_LIMITS.documentBytes),
    brainDocuments: intOr(config.LIMIT_BRAIN_DOCUMENTS, DEFAULT_LIMITS.brainDocuments),
    brainBytes: intOr(config.LIMIT_BRAIN_BYTES, DEFAULT_LIMITS.brainBytes),
    revisionsPerDocument: intOr(config.LIMIT_REVISIONS_PER_DOCUMENT, DEFAULT_LIMITS.revisionsPerDocument),
    eventsPerBrain: intOr(config.LIMIT_EVENTS_PER_BRAIN, DEFAULT_LIMITS.eventsPerBrain),
  };
}

/**
 * Make sure the owner account from OWNER_EMAIL / OWNER_PASSWORD exists and
 * matches the configured password. Changing the secret and restarting resets it.
 */
export async function ensureOwner(store: BrainStore, email: string | undefined, password: string | undefined): Promise<void> {
  if (!email || !password) {
    console.warn("OWNER_EMAIL and OWNER_PASSWORD are not set: nobody can sign in.");
    return;
  }
  if (password.length < 12) throw new Error("OWNER_PASSWORD must be at least 12 characters.");
  const existing = store.findUserByEmail(email);
  if (existing && (await verifyPassword(password, existing.password_hash))) return;
  store.upsertUser(email, await hashPassword(password));
}

export interface InstanceDeps {
  /** Outbound fetch, for client metadata documents and event webhooks. */
  fetch?: FetchFn;
  now?: () => number;
  events?: EventOptions;
  /** Called after MCP requests; the runtime decides how to run delivery in the background. */
  afterMcpRequest?: () => void;
}

export function createInstance(
  sql: Sql,
  config: InstanceConfig,
  deps: InstanceDeps = {},
): { app: Hono; store: BrainStore; oauth: OAuthService; events: EventService } {
  if (!config.PUBLIC_URL) throw new Error("PUBLIC_URL must be set to the server's public base URL.");
  migrate(sql);
  const now = deps.now ?? Date.now;
  const store = new BrainStore(sql, limitsFrom(config), now);
  const oauth = new OAuthService(sql, now, deps.fetch);
  const events = new EventService(sql, store, deps.fetch, now, deps.events);
  let setup: Promise<void> | undefined;
  const ready = () => (setup ??= ensureOwner(store, config.OWNER_EMAIL, config.OWNER_PASSWORD).catch((e) => {
    setup = undefined;
    throw e;
  }));
  const app = createApp({ publicUrl: config.PUBLIC_URL, store, oauth, events, ready, afterMcpRequest: deps.afterMcpRequest });
  return { app, store, oauth, events };
}
