import { serve } from "@hono/node-server";
import { lookup } from "node:dns/promises";
import { mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { EventService } from "../core/events.js";
import { createInstance } from "../core/instance.js";
import { privateHost } from "../core/oauth.js";
import { openSqlite } from "./sqlite.js";

const env = process.env;
const dataDir = env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });
const port = Number(env.PORT ?? 8787);
const publicUrl = env.PUBLIC_URL ?? `http://localhost:${port}`;

/** Webhook callbacks must resolve only to public addresses. */
async function checkCallbackUrl(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address } of addresses) {
    if (privateHost(address.includes(":") ? `[${address}]` : address)) throw new Error("delivery.url resolves to a private address.");
  }
}

let events: EventService | undefined;
let timer: NodeJS.Timeout | undefined;
const deliver = () => {
  if (!events) return;
  events
    .deliver()
    .then((next) => {
      clearTimeout(timer);
      if (next) timer = setTimeout(deliver, Math.max(next - Date.now(), 100));
    })
    .catch((e) => console.error("event delivery failed", e));
};

const sql = openSqlite(join(dataDir, "agentbrain.db"));
const instance = createInstance(sql, { ...env, PUBLIC_URL: publicUrl }, { events: { checkCallbackUrl }, afterMcpRequest: () => setImmediate(deliver) });
events = instance.events;
const { app } = instance;
// Catch up on anything left from before a restart, and keep a slow safety sweep.
setImmediate(deliver);
const sweep = setInterval(deliver, 60_000);

const server = serve({ fetch: app.fetch, port, hostname: env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`Agent Brain listening on port ${info.port}; public URL ${publicUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(sweep);
    clearTimeout(timer);
    server.close(() => process.exit(0));
  });
}
