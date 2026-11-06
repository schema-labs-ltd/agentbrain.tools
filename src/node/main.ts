import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInstance } from "../core/instance.js";
import { openSqlite } from "./sqlite.js";

const env = process.env;
const dataDir = env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });
const port = Number(env.PORT ?? 8787);
const publicUrl = env.PUBLIC_URL ?? `http://localhost:${port}`;

const sql = openSqlite(join(dataDir, "agentbrain.db"));
const { app } = createInstance(sql, { ...env, PUBLIC_URL: publicUrl });

const server = serve({ fetch: app.fetch, port, hostname: env.HOST ?? "0.0.0.0" }, (info) => {
  console.log(`Agent Brain listening on port ${info.port}; public URL ${publicUrl}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
