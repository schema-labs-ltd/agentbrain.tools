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

// Images: a multi-chunk upload through a one-time link, read back by the other agent.
const picture = new Uint8Array(1_500_000);
picture.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 200]);
for (let i = 24; i < picture.length; i++) picture[i] = (i * 31) & 0xff;
const upload = await a("create_image_upload", { reference: ref, title: "Smoke picture", description: "Synthetic PNG header with filler" });
const put = await fetch(upload.body.uploadUrl, { method: "PUT", body: picture });
const uploaded = (await put.json()) as { image: { id: string; width: number; height: number } };
check(put.status === 201 && uploaded.image.width === 256 && uploaded.image.height === 200, "agent A uploads an image through a one-time link");
const link = await b("read_image", { reference: ref, image_id: uploaded.image.id, as: "url" });
const bytes = new Uint8Array(await (await fetch(link.body.downloadUrl)).arrayBuffer());
check(bytes.length === picture.length && bytes.every((v, i) => v === picture[i]), "agent B downloads the identical image");
const tiny = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const inline = await b("upload_image", { reference: ref, title: "Pixel", data_base64: tiny });
check(!inline.isError && inline.body.image.mimeType === "image/png", "agent B uploads a small image inline");
const pub = await fetch(inline.body.image.url);
check(pub.status === 200 && pub.headers.get("content-type") === "image/png", "the image's public URL works without signing in");
const listed = await a("read_index", { reference: ref });
check(listed.body.images?.length === 2, "the index lists both images");

const closed = await a("close_brain", { reference: ref, export: true });
check(closed.body.export?.documents?.length === 1, "brain closed with an export");
check(closed.body.export?.images?.length === 2, "the export lists the images");
check((await fetch(inline.body.image.url)).status === 404, "the public URL stops working after close");
const gone = await b("read_index", { reference: ref });
check(gone.body.error?.code === "brain_closed", "closed brain no longer serves content");
console.log("Smoke test passed.");
