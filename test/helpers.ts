import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sha256Base64Url } from "../src/core/crypto.js";
import { newSecret } from "../src/core/ids.js";
import { createInstance, type InstanceDeps } from "../src/core/instance.js";
import { openSqlite } from "../src/node/sqlite.js";

export const BASE = "https://brain.test";
export const OWNER = { email: "owner@example.com", password: "correct horse battery" };

export function testInstance(extra: Record<string, string> = {}, deps: InstanceDeps = {}) {
  const sql = openSqlite(":memory:");
  const instance = createInstance(sql, { PUBLIC_URL: BASE, OWNER_EMAIL: OWNER.email, OWNER_PASSWORD: OWNER.password, ...extra }, deps);
  const fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(instance.app.fetch(new Request(input, init)));
  return { ...instance, sql, fetch };
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function registerClient(fetch: Fetch, name: string, redirect = "http://127.0.0.1:9999/callback") {
  const res = await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { client_id: string; redirect_uris: string[] };
}

/** Run the whole browser part of the OAuth flow and return the redirect URL. */
export async function authorize(
  fetch: Fetch,
  clientId: string,
  opts: { email?: string; password?: string; scope?: string; decision?: string; redirect?: string } = {},
) {
  const verifier = newSecret();
  const challenge = await sha256Base64Url(verifier);
  const redirect = opts.redirect ?? "http://127.0.0.1:9999/callback";
  const url = new URL(`${BASE}/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${BASE}/mcp`,
    ...(opts.scope ? { scope: opts.scope } : {}),
  }).toString();
  const page = await fetch(url);
  const html = await page.text();
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  if (!requestId) throw new Error(`no consent form: ${page.status} ${html}`);
  const res = await fetch(`${BASE}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      request_id: requestId,
      email: opts.email ?? OWNER.email,
      password: opts.password ?? OWNER.password,
      decision: opts.decision ?? "allow",
    }).toString(),
    redirect: "manual",
  });
  return { res, verifier, redirect };
}

export async function signIn(fetch: Fetch, name: string, scope?: string, clientIdOverride?: { clientId: string; redirect: string }) {
  const client = clientIdOverride ? { client_id: clientIdOverride.clientId } : await registerClient(fetch, name);
  const { res, verifier, redirect } = await authorize(fetch, client.client_id, { scope, redirect: clientIdOverride?.redirect });
  const location = new URL(res.headers.get("location")!);
  const code = location.searchParams.get("code");
  if (!code) throw new Error(`no code: ${res.status} ${location}`);
  const tokenRes = await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: client.client_id,
      resource: `${BASE}/mcp`,
    }).toString(),
  });
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string };
  return { clientId: client.client_id, ...tokens };
}

export async function connect(fetch: Fetch, accessToken: string) {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch,
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
    const body = JSON.parse(result.content[0]!.text);
    return { isError: !!result.isError, body };
  };
  return { client, call };
}
