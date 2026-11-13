import { describe, expect, it } from "vitest";
import { ACCOUNT_RECHECK_MS } from "../src/core/accounts.js";
import { frontendApiFromKey } from "../src/core/clerk.js";
import { clerkFrom } from "../src/core/instance.js";
import { authorize, BASE, connect, OWNER, registerClient, testInstance } from "./helpers.js";

const FAPI = "clerk.brain.test";
const ISSUER = `https://${FAPI}`;
const API = "https://api.clerk.test";
const PK = `pk_test_${Buffer.from(`${FAPI}$`).toString("base64")}`;
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

type FakeUser = { id: string; email: string | null; verified?: boolean; banned?: boolean; locked?: boolean };

/** A stand-in for Clerk: a signing key, its JWKS and a users endpoint. */
async function fakeClerk() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "ins_key_1", use: "sig", alg: "RS256" };
  const users = new Map<string, FakeUser>();
  const state = { down: false, userLookups: 0 };

  const sign = async (claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey } = {}) => {
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid: opts.kid ?? "ins_key_1", typ: "JWT" })));
    const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, opts.key ?? pair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
    return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
  };

  const now = () => Math.floor(Date.now() / 1000);
  const token = (sub: string, over: Record<string, unknown> = {}) =>
    sign({ iss: ISSUER, sub, azp: BASE, sid: "sess_1", iat: now() - 5, nbf: now() - 5, exp: now() + 60, sts: "active", v: 2, ...over });

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(API)) return new Response("missing", { status: 404 });
    if (state.down) return new Response("unavailable", { status: 503 });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer sk_test_secret") return new Response("unauthorized", { status: 401 });
    const path = url.slice(API.length);
    if (path === "/v1/jwks") return Response.json({ keys: [jwk] });
    const m = /^\/v1\/users\/([^/]+)$/.exec(path);
    if (m) {
      state.userLookups++;
      const u = users.get(decodeURIComponent(m[1]!));
      if (!u) return Response.json({ errors: [{ code: "resource_not_found" }] }, { status: 404 });
      return Response.json({
        id: u.id,
        banned: !!u.banned,
        locked: !!u.locked,
        primary_email_address_id: u.email ? "idn_1" : null,
        email_addresses: u.email ? [{ id: "idn_1", email_address: u.email, verification: { status: u.verified === false ? "unverified" : "verified" } }] : [],
      });
    }
    return new Response("missing", { status: 404 });
  };

  return { users, state, sign, token, fetch, pair };
}

type Fake = Awaited<ReturnType<typeof fakeClerk>>;

function clerkInstance(clerk: Fake, opts: { now?: () => number; owner?: boolean } = {}) {
  const config: Record<string, string> = { CLERK_PUBLISHABLE_KEY: PK, CLERK_SECRET_KEY: "sk_test_secret", CLERK_API_URL: API };
  const t = testInstance(config, { fetch: clerk.fetch as never, now: opts.now });
  return t;
}

let ip = 0;
async function webLogin(t: ReturnType<typeof testInstance>, clerkToken: string, origin = BASE) {
  return t.fetch(`${BASE}/login`, {
    method: "POST",
    // A fresh address each time, so the failed-attempt limit does not get in the way.
    headers: { "content-type": "application/x-www-form-urlencoded", origin, "cf-connecting-ip": `10.0.0.${++ip % 250}` },
    body: new URLSearchParams({ clerk_token: clerkToken, next: "/" }).toString(),
    redirect: "manual",
  });
}

async function cookieFor(t: ReturnType<typeof testInstance>, clerkToken: string) {
  const res = await webLogin(t, clerkToken);
  expect(res.status).toBe(303);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

/** The whole OAuth flow, signing in on the consent page with a Clerk session token. */
async function agentFor(t: ReturnType<typeof testInstance>, clerkToken: string) {
  const client = await registerClient(t.fetch, "Test agent");
  const { res, verifier, redirect } = await authorize(t.fetch, client.client_id, { clerkToken });
  const code = new URL(res.headers.get("location")!).searchParams.get("code");
  if (!code) throw new Error(`no code: ${res.status} ${await res.text()}`);
  const tokens = (await (
    await t.fetch(`${BASE}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect, client_id: client.client_id, resource: `${BASE}/mcp` }).toString(),
    })
  ).json()) as { access_token: string };
  return { ...(await connect(t.fetch, tokens.access_token)), accessToken: tokens.access_token };
}

describe("Clerk configuration", () => {
  it("reads the Frontend API host from a publishable key", () => {
    expect(frontendApiFromKey(PK)).toBe(FAPI);
    expect(frontendApiFromKey("pk_test_bm9ibGUtZ3JhY2tsZS00ODk4LmNsZXJrLmFjY291bnRzLmRldiQ")).toBe("noble-grackle-4898.clerk.accounts.dev");
    expect(() => frontendApiFromKey("sk_test_nope")).toThrow();
  });

  it("needs both keys or neither", () => {
    const f = async () => new Response();
    expect(clerkFrom({ PUBLIC_URL: BASE }, f, Date.now)).toBeUndefined();
    expect(() => clerkFrom({ PUBLIC_URL: BASE, CLERK_PUBLISHABLE_KEY: PK }, f, Date.now)).toThrow(/both/);
    expect(() => clerkFrom({ PUBLIC_URL: BASE, CLERK_SECRET_KEY: "sk" }, f, Date.now)).toThrow(/both/);
  });
});

describe("website sign-in with Clerk", () => {
  it("shows Clerk's sign-in instead of a password form, with a CSP that allows it", async () => {
    const clerk = await fakeClerk();
    const t = clerkInstance(clerk);
    const res = await t.fetch(`${BASE}/login`);
    const html = await res.text();
    expect(html).toContain('id="clerk-mount"');
    expect(html).toContain(`data-clerk-publishable-key="${PK}"`);
    expect(html).toContain(`https://${FAPI}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`);
    expect(html).not.toContain('type="password"');
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(`script-src 'self' https://${FAPI}`);
    expect(csp).toContain(`connect-src 'self' https://${FAPI}`);
    expect(csp).toContain("form-action 'self'");
    const js = await t.fetch(`${BASE}/assets/clerk-signin.js`);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    expect(await js.text()).toContain("mountSignIn");
  });

  it("links the original owner's data to the Clerk user with the same email, and keeps others apart", async () => {
    const clerk = await fakeClerk();
    const t = clerkInstance(clerk);
    await t.fetch(`${BASE}/healthz`);
    const ownerId = t.store.findUserByEmail(OWNER.email)!.id;
    const owned = t.store.createBrain({ userId: ownerId, clientId: "legacy" }, { project: "Existing work" });

    clerk.users.set("user_simon", { id: "user_simon", email: OWNER.email.toUpperCase() });
    const cookie = await cookieFor(t, await clerk.token("user_simon"));
    const home = await (await t.fetch(`${BASE}/`, { headers: { cookie } })).text();
    expect(home).toContain("Existing work");
    // The same account, not a copy.
    expect(t.sql.all(`SELECT id, clerk_user_id FROM users WHERE email = ?`, OWNER.email)).toEqual([{ id: ownerId, clerk_user_id: "user_simon" }]);
    // Password sign-in is off once Clerk is configured.
    const pw = await t.fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ email: OWNER.email, password: OWNER.password, next: "/" }).toString(),
      redirect: "manual",
    });
    expect(pw.status).toBe(401);

    // A newly invited person gets an empty account of their own.
    clerk.users.set("user_ann", { id: "user_ann", email: "ann@example.com" });
    const annCookie = await cookieFor(t, await clerk.token("user_ann"));
    const annHome = await (await t.fetch(`${BASE}/`, { headers: { cookie: annCookie } })).text();
    expect(annHome).not.toContain("Existing work");
    const [, project, brainId] = /^agentBrain:([a-z0-9]+)\.([a-z0-9]+)$/.exec(owned.reference)!;
    for (const path of [`/projects/${project}`, `/brains/${project}/${brainId}`]) {
      const res = await t.fetch(`${BASE}${path}`, { headers: { cookie: annCookie } });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("belongs to another Agent Brain account");
    }
  });

  it("refuses forged, expired, foreign, pending and unknown-user tokens", async () => {
    const clerk = await fakeClerk();
    const t = clerkInstance(clerk);
    clerk.users.set("user_a", { id: "user_a", email: "a@example.com" });
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      "",
      "not-a-jwt",
      await clerk.token("user_a", { iss: "https://evil.example" }),
      await clerk.token("user_a", { exp: now - 120 }),
      await clerk.token("user_a", { nbf: now + 600 }),
      await clerk.token("user_a", { azp: "https://evil.example" }),
      await clerk.token("user_a", { sts: "pending" }),
      await clerk.token("user_missing"),
      await clerk.sign({ iss: ISSUER, sub: "user_a", exp: now + 60, azp: BASE }, { key: other.privateKey }),
      await clerk.sign({ iss: ISSUER, sub: "user_a", exp: now + 60, azp: BASE }, { kid: "unknown" }),
    ];
    for (const token of bad) {
      const res = await webLogin(t, token);
      expect(res.status, token.slice(0, 40)).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    // Cross-site posts are blocked before any check.
    expect((await webLogin(t, await clerk.token("user_a"), "https://evil.example")).status).toBe(403);
    // Banned, locked and email-less users cannot sign in.
    for (const u of [
      { id: "user_b", email: "b@example.com", banned: true },
      { id: "user_l", email: "l@example.com", locked: true },
      { id: "user_n", email: null },
      { id: "user_u", email: "u@example.com", verified: false },
    ]) {
      clerk.users.set(u.id, u);
      expect((await webLogin(t, await clerk.token(u.id))).status).toBe(401);
    }
    expect((await webLogin(t, await clerk.token("user_a"))).status).toBe(303);
  });

  it("signs the browser out of Clerk after signing out", async () => {
    const clerk = await fakeClerk();
    const t = clerkInstance(clerk);
    clerk.users.set("user_a", { id: "user_a", email: "a@example.com" });
    const cookie = await cookieFor(t, await clerk.token("user_a"));
    const out = await t.fetch(`${BASE}/logout`, { method: "POST", headers: { cookie, origin: BASE }, redirect: "manual" });
    expect(out.headers.get("location")).toBe("/login?signed_out=1");
    expect(await (await t.fetch(`${BASE}/login?signed_out=1`)).text()).toContain('data-sign-out="1"');
  });
});

describe("MCP OAuth with Clerk", () => {
  it("signs in on the consent page with Clerk and keeps every agent to its own account", async () => {
    const clerk = await fakeClerk();
    const t = clerkInstance(clerk);
    clerk.users.set("user_a", { id: "user_a", email: "a@example.com" });
    clerk.users.set("user_b", { id: "user_b", email: "b@example.com" });

    const consent = await t.fetch(
      `${BASE}/authorize?${new URLSearchParams({ response_type: "code", client_id: (await registerClient(t.fetch, "X")).client_id, redirect_uri: "http://127.0.0.1:9999/callback", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`,
    );
    const page = await consent.text();
    expect(page).toContain('id="clerk-mount"');
    expect(page).not.toContain('type="password"');
    const csp = consent.headers.get("content-security-policy")!;
    expect(csp).toContain(`https://${FAPI}`);
    // Allow must be able to redirect to the agent's own callback.
    expect(csp).not.toContain("form-action");

    const a = await agentFor(t, await clerk.token("user_a"));
    const b = await agentFor(t, await clerk.token("user_b"));
    const brain = await a.call("create_brain", { project: "A's work" });
    expect(brain.isError).toBe(false);
    const ref = brain.body.reference as string;
    const token = brain.body.project.token as string;

    for (const [name, args] of [
      ["read_index", { reference: ref }],
      ["read_documents", { reference: ref, document_ids: ["x"] }],
      ["create_document", { reference: ref, title: "t", markdown: "m" }],
      ["close_brain", { reference: ref, export: false }],
      ["list_brains", { project: token }],
      ["create_brain", { project: token }],
    ] as const) {
      const res = await b.call(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.body.error.code, name).toBe("forbidden");
      expect(res.body.error.message, name).toMatch(/belongs to another Agent Brain account/);
    }
    expect((await b.call("list_projects")).body.projects).toEqual([]);
    expect((await a.call("read_index", { reference: ref })).isError).toBe(false);
  });

  it("refuses an invalid Clerk token on the consent page", async () => {
    const clerk = await fakeClerk();
    const t = clerkInstance(clerk);
    const client = await registerClient(t.fetch, "X");
    const { res } = await authorize(t.fetch, client.client_id, { clerkToken: "forged" });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("could not be confirmed");
    // Deny still works without signing in.
    const denied = await authorize(t.fetch, client.client_id, { clerkToken: "", decision: "deny" });
    expect(new URL(denied.res.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("cuts off a user removed in Clerk once their status is re-checked", async () => {
    const clerk = await fakeClerk();
    let clock = Date.now();
    const t = clerkInstance(clerk, { now: () => clock });
    clerk.users.set("user_a", { id: "user_a", email: "a@example.com" });
    const agent = await agentFor(t, await clerk.token("user_a"));
    expect((await agent.call("list_projects")).isError).toBe(false);

    clerk.users.delete("user_a");
    // Within the re-check window the last known status stands, without asking Clerk on every request.
    const lookups = clerk.state.userLookups;
    expect((await agent.call("list_projects")).isError).toBe(false);
    expect(clerk.state.userLookups).toBe(lookups);

    clock += ACCOUNT_RECHECK_MS + 1;
    const res = await t.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${agent.accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  it("keeps the last known status when Clerk cannot be reached", async () => {
    const clerk = await fakeClerk();
    let clock = Date.now();
    const t = clerkInstance(clerk, { now: () => clock });
    clerk.users.set("user_a", { id: "user_a", email: "a@example.com" });
    const agent = await agentFor(t, await clerk.token("user_a"));
    clerk.state.down = true;
    clock += ACCOUNT_RECHECK_MS + 1;
    expect((await agent.call("list_projects")).isError).toBe(false);
  });

  it("re-links the owner when moving to another Clerk instance with the same email", async () => {
    const clerk = await fakeClerk();
    const t = clerkInstance(clerk);
    clerk.users.set("user_dev", { id: "user_dev", email: "a@example.com" });
    clerk.users.set("user_prod", { id: "user_prod", email: "a@example.com" });
    const first = await t.accounts.signInWithClerk(await clerk.token("user_dev"));
    const second = await t.accounts.signInWithClerk(await clerk.token("user_prod"));
    expect(first.ok && second.ok && first.userId === second.userId).toBe(true);
  });
});

describe("changing OWNER_EMAIL", () => {
  it("moves the existing owner account to the new email so Clerk links it", async () => {
    const { openSqlite } = await import("../src/node/sqlite.js");
    const { createInstance } = await import("../src/core/instance.js");
    const sql = openSqlite(":memory:");
    const first = createInstance(sql, { PUBLIC_URL: BASE, OWNER_EMAIL: "old@example.com", OWNER_PASSWORD: OWNER.password });
    await first.app.fetch(new Request(`${BASE}/healthz`));
    const ownerId = first.store.findUserByEmail("old@example.com")!.id;
    first.store.createBrain({ userId: ownerId, clientId: "legacy" }, { project: "Existing work" });

    const clerk = await fakeClerk();
    const second = createInstance(
      sql,
      { PUBLIC_URL: BASE, OWNER_EMAIL: "New@Example.com", OWNER_PASSWORD: OWNER.password, CLERK_PUBLISHABLE_KEY: PK, CLERK_SECRET_KEY: "sk_test_secret", CLERK_API_URL: API },
      { fetch: clerk.fetch as never },
    );
    await second.app.fetch(new Request(`${BASE}/healthz`));
    expect(second.store.findUserByEmail("new@example.com")!.id).toBe(ownerId);
    expect(second.store.findUserByEmail("old@example.com")).toBeUndefined();
    clerk.users.set("user_new", { id: "user_new", email: "new@example.com" });
    const signedIn = await second.accounts.signInWithClerk(await clerk.token("user_new"));
    expect(signedIn.ok && signedIn.userId).toBe(ownerId);
    expect(second.store.listProjects(ownerId).map((p) => p.name)).toEqual(["Existing work"]);
  });

  it("does not move a Clerk-linked account or guess between several", async () => {
    const clerk = await fakeClerk();
    const t = clerkInstance(clerk);
    await t.fetch(`${BASE}/healthz`);
    clerk.users.set("user_o", { id: "user_o", email: OWNER.email });
    await t.accounts.signInWithClerk(await clerk.token("user_o"));
    expect(t.store.moveOwnerEmail("someone@example.com")).toBe(false);
    expect(t.store.findUserByEmail(OWNER.email)).toBeDefined();
  });
});
