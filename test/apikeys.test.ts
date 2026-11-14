import { describe, expect, it } from "vitest";
import { BASE, connect, OWNER, signIn, testInstance } from "./helpers.js";

type T = ReturnType<typeof testInstance>;

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function session(t: T): Promise<string> {
  const res = await t.fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ email: OWNER.email, password: OWNER.password, next: "/" }).toString(),
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** Create a key through the website form, as a signed-in user would. */
async function createKey(t: T, cookie: string, fields: { name: string; access?: string; projects?: string[] }, origin = BASE) {
  const body = new URLSearchParams({ name: fields.name, access: fields.access ?? "write" });
  for (const p of fields.projects ?? []) body.append("projects", p);
  const res = await t.fetch(`${BASE}/keys`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie },
    body: body.toString(),
  });
  const html = await res.text();
  const key = /<code class="ref secret" id="new-key">([^<]+)<\/code>/.exec(html)?.[1];
  return { res, html, key };
}

let rpcId = 0;
/** A raw MCP tools/call, exactly as curl or Anthropic's MCP connector would send it. */
async function call(t: T, key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await t.fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  let json: { result?: { isError?: boolean; content: { type: string; text: string }[] }; error?: unknown } | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const first = json?.result?.content?.[0];
  return { status: res.status, json, isError: !!json?.result?.isError, body: first?.type === "text" ? JSON.parse(first.text) : undefined, text };
}

describe("API keys", () => {
  it("lets a key created on the website create a brain and a document, and stops working once revoked", async () => {
    const t = testInstance();
    const cookie = await session(t);
    const { res, key, html } = await createKey(t, cookie, { name: "Change Request intake agent" });
    expect(res.status).toBe(201);
    expect(key).toMatch(/^abk_[A-Za-z0-9_-]{43}$/);
    expect(html).toContain("It will not be shown again");

    const brain = await call(t, key!, "create_brain", { project: "Change Requests", title: "CR-1" });
    expect(brain.status).toBe(200);
    expect(brain.isError).toBe(false);
    expect(brain.body.reference).toMatch(/^agentBrain:/);
    const doc = await call(t, key!, "create_document", { reference: brain.body.reference, title: "Overview", markdown: "# CR-1" });
    expect(doc.isError).toBe(false);
    expect(doc.body.document.revision).toBe(1);

    // Changes are attributed to the key in history.
    const history = await call(t, key!, "document_history", { reference: brain.body.reference, document_id: doc.body.document.id });
    expect(history.body.revisions[0].clientName).toBe('API key "Change Request intake agent"');

    // The list shows a hint and the last-used time, never the key.
    const page = await (await t.fetch(`${BASE}/keys`, { headers: { cookie } })).text();
    expect(page).toContain("Change Request intake agent");
    expect(page).not.toContain(key!);
    expect(page).toContain("Last used");
    const id = t.apiKeys.list(t.store.findUserByEmail(OWNER.email)!.id)[0]!.id;

    const revoke = await t.fetch(`${BASE}/keys/${id}/revoke`, { method: "POST", headers: { origin: BASE, cookie }, redirect: "manual" });
    expect(revoke.status).toBe(303);
    const after = await call(t, key!, "create_brain", { project: "Change Requests", title: "CR-2" });
    expect(after.status).toBe(401);
    expect(after.text).toContain("revoked");
  });

  it("stores only a hash of each key", async () => {
    const t = testInstance();
    const cookie = await session(t);
    const { key } = await createKey(t, cookie, { name: "Worker" });
    const rows = t.sql.all<{ key_hash: string; last_used_at: number | null }>(`SELECT * FROM api_keys`);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(key!);
    expect(rows[0]!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.last_used_at).toBeNull();
    await call(t, key!, "list_projects");
    expect(t.sql.all<{ last_used_at: number }>(`SELECT last_used_at FROM api_keys`)[0]!.last_used_at).toBeGreaterThan(0);
  });

  it("supports every tool a headless agent needs through the MCP SDK", async () => {
    const t = testInstance();
    const cookie = await session(t);
    const { key } = await createKey(t, cookie, { name: "SDK agent" });
    const { client, call: sdk } = await connect(t.fetch, key!);
    const guide = (await client.callTool({ name: "read_guide", arguments: {} })) as { content: { text: string }[] };
    expect(guide.content[0]!.text).toContain("Agent Brain");
    expect((await sdk("open_project", { name: "AFX" })).isError).toBe(false);
    expect((await sdk("list_projects")).body.projects.map((p: { name: string }) => p.name)).toEqual(["AFX"]);
    const brain = (await sdk("create_brain", { project: "AFX" })).body;
    expect((await sdk("list_brains", { project: "AFX" })).body.brains).toHaveLength(1);
    const doc = (await sdk("create_document", { reference: brain.reference, title: "Overview", markdown: "one" })).body.document;
    const patched = await sdk("patch_document", { reference: brain.reference, document_id: doc.id, base_revision: 1, edits: [{ find: "one", replace: "two" }] });
    expect(patched.isError).toBe(false);
    expect((await sdk("replace_document", { reference: brain.reference, document_id: doc.id, base_revision: 2, markdown: "three" })).isError).toBe(false);
    expect((await sdk("read_index", { reference: brain.reference })).body.documents).toHaveLength(1);
    expect((await sdk("read_documents", { reference: brain.reference, document_ids: [doc.id] })).body.documents[0].markdown).toBe("three");
    const image = await sdk("upload_image", { reference: brain.reference, title: "Dot", data_base64: PNG_1X1 });
    expect(image.isError).toBe(false);
  });

  it("refuses changes from a read-only key with a clear 403", async () => {
    const t = testInstance();
    const cookie = await session(t);
    const { key: rw } = await createKey(t, cookie, { name: "Writer" });
    const reference = (await call(t, rw!, "create_brain", { project: "AFX" })).body.reference;
    const { key } = await createKey(t, cookie, { name: "Reader", access: "read" });
    expect((await call(t, key!, "read_index", { reference })).status).toBe(200);
    const res = await call(t, key!, "create_document", { reference, title: "Nope", markdown: "x" });
    expect(res.status).toBe(403);
    expect(res.isError).toBe(true);
    expect(res.body.error.code).toBe("forbidden");
    expect(res.body.error.message).toContain('"Reader" is read-only');
    // A read-only key cannot create a project through open_project either.
    expect((await call(t, key!, "open_project", { name: "Brand new" })).isError).toBe(true);
  });

  it("never lets a key close a brain", async () => {
    const t = testInstance();
    const cookie = await session(t);
    const { key } = await createKey(t, cookie, { name: "Writer" });
    const reference = (await call(t, key!, "create_brain", { project: "AFX" })).body.reference;
    const res = await call(t, key!, "close_brain", { reference, export: false });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("cannot close brains");
    expect((await call(t, key!, "read_index", { reference })).isError).toBe(false);
  });

  it("keeps a project-limited key inside its projects", async () => {
    const t = testInstance();
    const cookie = await session(t);
    const { key: all } = await createKey(t, cookie, { name: "Everything" });
    const a = (await call(t, all!, "create_brain", { project: "Alpha" })).body;
    const b = (await call(t, all!, "create_brain", { project: "Beta" })).body;
    const { key, html } = await createKey(t, cookie, { name: "Alpha only", projects: [a.project.token] });
    expect(html).toContain("Only Alpha");

    expect((await call(t, key!, "list_projects")).body.projects.map((p: { name: string }) => p.name)).toEqual(["Alpha"]);
    expect((await call(t, key!, "list_brains")).body.brains.map((x: { reference: string }) => x.reference)).toEqual([a.reference]);
    expect((await call(t, key!, "read_index", { reference: a.reference })).status).toBe(200);
    expect((await call(t, key!, "create_brain", { project: "alpha" })).isError).toBe(false);

    for (const [name, args] of [
      ["read_index", { reference: b.reference }],
      ["create_document", { reference: b.reference, title: "x", markdown: "x" }],
      ["read_image", { reference: b.reference, image_id: "x" }],
      ["list_brains", { project: "Beta" }],
      ["open_project", { name: "Beta" }],
      ["create_brain", { project: "Gamma" }],
    ] as const) {
      const res = await call(t, key!, name, args);
      expect(res.status, name).toBe(403);
      expect(res.body.error.code, name).toBe("forbidden");
      expect(res.body.error.message, name).toContain('"Alpha only" is limited to one project');
    }
    // Nothing was created by the refused calls.
    expect((await call(t, all!, "list_projects")).body.projects.map((p: { name: string }) => p.name)).toEqual(["Alpha", "Beta"]);
  });

  it("validates the form and blocks cross-site requests", async () => {
    const t = testInstance();
    const cookie = await session(t);
    expect((await createKey(t, cookie, { name: "  " })).res.status).toBe(400);
    expect((await createKey(t, cookie, { name: "x", access: "admin" })).res.status).toBe(400);
    expect((await createKey(t, cookie, { name: "x", projects: ["0000000000000000000000000z"] })).res.status).toBe(400);
    const cross = await createKey(t, cookie, { name: "x" }, "https://evil.example");
    expect(cross.res.status).toBe(403);
    expect(cross.key).toBeUndefined();
    expect(t.sql.all(`SELECT * FROM api_keys`)).toHaveLength(0);
    const signedOut = await t.fetch(`${BASE}/keys`, { headers: { accept: "text/html" }, redirect: "manual" });
    expect(signedOut.status).toBe(303);
  });

  it("cannot revoke another account's key", async () => {
    const t = testInstance();
    const cookie = await session(t);
    const other = t.store.upsertUser("other@example.com", "x");
    const { key } = await t.apiKeys.create(other, { name: "Theirs", access: "write" });
    const id = t.apiKeys.list(other)[0]!.id;
    const res = await t.fetch(`${BASE}/keys/${id}/revoke`, { method: "POST", headers: { origin: BASE, cookie } });
    expect(res.status).toBe(404);
    expect((await call(t, key, "list_projects")).status).toBe(200);
  });

  it("refuses unknown keys and leaves OAuth tokens working as before", async () => {
    const t = testInstance();
    expect((await call(t, "abk_not-a-real-key", "list_projects")).status).toBe(401);
    const { access_token } = await signIn(t.fetch, "Claude");
    const res = await call(t, access_token, "create_brain", { project: "AFX" });
    expect(res.status).toBe(200);
    expect(res.isError).toBe(false);
    const closed = await call(t, access_token, "close_brain", { reference: res.body.reference, export: false });
    expect(closed.isError).toBe(false);
  });
});
