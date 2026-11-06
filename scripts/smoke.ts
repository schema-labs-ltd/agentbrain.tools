/**
 * End-to-end smoke test against a running deployment.
 *
 *   AGENTBRAIN_URL=https://agentbrain.tools OWNER_EMAIL=... OWNER_PASSWORD=... npx tsx scripts/smoke.ts
 *
 * Registers two OAuth clients, signs both in as the owner, shares a brain
 * between them, forces an edit conflict, recovers from it, then closes the
 * brain with an export so nothing is left behind.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sha256Base64Url } from "../src/core/crypto.js";
import { newSecret } from "../src/core/ids.js";

const base = (process.env.AGENTBRAIN_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const email = process.env.OWNER_EMAIL!;
const password = process.env.OWNER_PASSWORD!;
const redirect = "http://127.0.0.1:53682/callback";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`ok - ${message}`);
}

async function signIn(name: string): Promise<string> {
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  });
  const client = (await reg.json()) as { client_id: string };
  const verifier = newSecret();
  const url = new URL(`${base}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: await sha256Base64Url(verifier),
    code_challenge_method: "S256",
    state: "smoke",
    resource: `${base}/mcp`,
  }).toString();
  const html = await (await fetch(url)).text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  check(requestId, `${name}: consent page shown`);
  const consent = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request_id: requestId, email, password, decision: "allow" }).toString(),
    redirect: "manual",
  });
  const code = new URL(consent.headers.get("location") ?? "http://x/").searchParams.get("code");
  check(code, `${name}: signed in and received an authorization code`);
  const tokens = (await (
    await fetch(`${base}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: client.client_id, resource: `${base}/mcp` }).toString(),
    })
  ).json()) as { access_token: string };
  check(tokens.access_token, `${name}: exchanged code for tokens`);
  return tokens.access_token;
}

async function agent(name: string) {
  const token = await signIn(name);
  const client = new Client({ name, version: "smoke" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return async (tool: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, body: JSON.parse(r.content[0]!.text) };
  };
}

const unauth = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
check(unauth.status === 401 && unauth.headers.get("www-authenticate")?.includes("resource_metadata"), "unauthenticated MCP request is challenged");

const a = await agent("Smoke agent A");
const b = await agent("Smoke agent B");
const brain = await a("create_brain", { project: "Agent Brain smoke test", title: "Smoke test" });
check(!brain.isError, `agent A created ${brain.body.reference}`);
const ref = brain.body.reference;
const doc = await a("create_document", { reference: ref, title: "Findings", markdown: "# Findings\n" });
const id = doc.body.document.id;
const index = await b("read_index", { reference: ref });
check(index.body.documents[0]?.id === id, "agent B reads the index through the reference");
await a("replace_document", { reference: ref, document_id: id, base_revision: 1, markdown: "# Findings\n- from A\n" });
const stale = await b("replace_document", { reference: ref, document_id: id, base_revision: 1, markdown: "# Findings\n- from B\n" });
check(stale.isError && stale.body.error.code === "conflict", "agent B's stale write is rejected");
const merged = await b("patch_document", { reference: ref, document_id: id, base_revision: 2, edits: [{ find: "- from A\n", replace: "- from A\n- from B\n" }] });
check(!merged.isError, "agent B reapplies its change on the latest revision");
const read = await a("read_documents", { reference: ref, document_ids: [id] });
check(read.body.documents[0].markdown === "# Findings\n- from A\n- from B\n", "both contributions are preserved");
const closed = await a("close_brain", { reference: ref, export: true });
check(closed.body.export?.documents?.length === 1, "brain closed with an export");
const gone = await b("read_index", { reference: ref });
check(gone.body.error?.code === "brain_closed", "closed brain no longer serves content");
console.log("Smoke test passed.");
