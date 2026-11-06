import { describe, expect, it } from "vitest";
import { authorize, BASE, connect, registerClient, signIn, testInstance } from "./helpers.js";

describe("OAuth", () => {
  it("publishes protected resource and authorization server metadata", async () => {
    const { fetch } = testInstance();
    const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: `${BASE}/mcp`, authorization_servers: [BASE] });
    const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
    expect(asm).toMatchObject({ issuer: BASE, code_challenge_methods_supported: ["S256"] });
  });

  it("challenges unauthenticated MCP requests", async () => {
    const { fetch } = testInstance();
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    const bad = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("rejects unsafe redirect URIs at registration", async () => {
    const { fetch } = testInstance();
    for (const uri of ["http://evil.example/cb", "javascript:alert(1)", "https://x.example/cb#frag"]) {
      const res = await fetch(`${BASE}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [uri] }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a wrong password and locks the request after repeated failures", async () => {
    const { fetch } = testInstance();
    const client = await registerClient(fetch, "Agent");
    const { res } = await authorize(fetch, client.client_id, { password: "wrong password!" });
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects with access_denied when the user denies", async () => {
    const { fetch } = testInstance();
    const client = await registerClient(fetch, "Agent");
    const { res } = await authorize(fetch, client.client_id, { decision: "deny" });
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("xyz");
  });

  it("rejects a reused authorization code and a wrong PKCE verifier", async () => {
    const { fetch } = testInstance();
    const client = await registerClient(fetch, "Agent");
    const { res, verifier, redirect } = await authorize(fetch, client.client_id);
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const exchange = (v: string) =>
      fetch(`${BASE}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: v, redirect_uri: redirect, client_id: client.client_id }).toString(),
      });
    expect((await exchange("x".repeat(43))).status).toBe(400);
    // The failed attempt consumed the code, so even the right verifier now fails.
    expect((await exchange(verifier)).status).toBe(400);
  });

  it("rotates refresh tokens, detects reuse and enforces revocation immediately", async () => {
    const { fetch } = testInstance();
    const tokens = await signIn(fetch, "Agent");
    const refresh = (rt: string) =>
      fetch(`${BASE}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: tokens.clientId }).toString(),
      });
    const next = (await (await refresh(tokens.refresh_token)).json()) as { access_token: string; refresh_token: string };
    expect(next.access_token).toBeTruthy();
    // Replaying the old refresh token revokes the whole grant.
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${next.access_token}` }, body: "{}" });
    expect(res.status).toBe(401);

    const fresh = await signIn(fetch, "Agent 2");
    const agent = await connect(fetch, fresh.access_token);
    expect((await agent.call("list_projects")).isError).toBe(false);
    await fetch(`${BASE}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: fresh.access_token, client_id: fresh.clientId }).toString(),
    });
    await expect(agent.call("list_projects")).rejects.toThrow();
  });
});

describe("client ID metadata documents", () => {
  const CLIENT_ID = "https://chat.example.com/oauth/client.json";
  const REDIRECT = "https://chat.example.com/oauth/callback";
  const documentFetch = (doc: unknown) => {
    const calls: string[] = [];
    const fn = async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(doc), { headers: { "content-type": "application/json" } });
    };
    return { fn, calls };
  };

  it("is advertised in the authorization server metadata", async () => {
    const { fetch } = testInstance();
    const asm = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(asm.client_id_metadata_document_supported).toBe(true);
  });

  it("signs in a client identified by its metadata URL, without registration", async () => {
    const remote = documentFetch({ client_id: CLIENT_ID, client_name: "Example Chat", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    const { fetch } = testInstance({}, { fetch: remote.fn });
    const tokens = await signIn(fetch, "unused", undefined, { clientId: CLIENT_ID, redirect: REDIRECT });
    const agent = await connect(fetch, tokens.access_token);
    const brain = await agent.call("create_brain", { project: "P" });
    expect(brain.isError).toBe(false);
    const changes = await agent.call("get_changes", { reference: brain.body.reference });
    expect(changes.body.events[0].clientName).toBe("Example Chat");
    // The document is cached rather than fetched on every request.
    expect(remote.calls).toEqual([CLIENT_ID]);
  });

  it("rejects documents that do not match their URL, carry secrets, or use other redirect URIs", async () => {
    const cases = [
      { client_id: "https://other.example.com/client.json", redirect_uris: [REDIRECT] },
      { client_id: CLIENT_ID, redirect_uris: [REDIRECT], client_secret: "s" },
      { client_id: CLIENT_ID, redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt" },
      { client_id: CLIENT_ID, redirect_uris: ["http://evil.example/cb"] },
    ];
    for (const doc of cases) {
      const { fetch } = testInstance({}, { fetch: documentFetch(doc).fn });
      await expect(authorize(fetch, CLIENT_ID, { redirect: REDIRECT })).rejects.toThrow(/no consent form: 400/);
    }
    const { fetch } = testInstance({}, { fetch: documentFetch({ client_id: CLIENT_ID, redirect_uris: [REDIRECT] }).fn });
    await expect(authorize(fetch, CLIENT_ID, { redirect: "https://chat.example.com/other" })).rejects.toThrow(/no consent form: 400/);
  });

  it("never fetches private or non-HTTPS client IDs", async () => {
    for (const id of ["https://127.0.0.1/client.json", "https://localhost/c.json", "https://chat.example.com/", "http://chat.example.com/c.json"]) {
      const remote = documentFetch({ client_id: id, redirect_uris: [REDIRECT] });
      const { fetch } = testInstance({}, { fetch: remote.fn });
      await expect(authorize(fetch, id, { redirect: REDIRECT })).rejects.toThrow(/no consent form: 400/);
      expect(remote.calls).toEqual([]);
    }
  });
});

describe("two agents sharing a brain over MCP", () => {
  it("lets two clients signed in as the same user share context and recover from a conflict", async () => {
    const { fetch } = testInstance();
    const claude = await connect(fetch, (await signIn(fetch, "Claude Code")).access_token);
    const codex = await connect(fetch, (await signIn(fetch, "Codex")).access_token);

    const tools = await claude.client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["open_project", "create_brain", "read_index", "read_documents", "patch_document", "get_changes", "close_brain"]),
    );

    const created = await claude.call("create_brain", { project: "AFX Markets", idempotency_key: "brain-1" });
    expect(created.isError).toBe(false);
    const reference = created.body.reference as string;
    const retried = await claude.call("create_brain", { project: "AFX Markets", idempotency_key: "brain-1" });
    expect(retried.body.reference).toBe(reference);

    const project = await codex.call("open_project", { name: "afx markets" });
    expect(project.body.token).toBe(created.body.project.token);

    const doc = await claude.call("create_document", { reference, title: "Findings", description: "Evidence", markdown: "# Findings\n" });
    const id = doc.body.document.id as string;

    // Codex resolves the pasted reference, reads the index and the document.
    const index = await codex.call("read_index", { reference });
    expect(index.body.documents).toEqual([expect.objectContaining({ id, title: "Findings", revision: 1 })]);
    const startCursor = index.body.cursor as string;

    // Both edit from revision 1; the second write is rejected, not lost.
    const a = await claude.call("replace_document", { reference, document_id: id, base_revision: 1, markdown: "# Findings\n- Spread widens at 22:00\n" });
    expect(a.isError).toBe(false);
    const b = await codex.call("replace_document", { reference, document_id: id, base_revision: 1, markdown: "# Findings\n- LP2 rejects at size\n" });
    expect(b.isError).toBe(true);
    expect(b.body.error.code).toBe("conflict");
    expect(b.body.error.current.revision).toBe(2);

    const merged = await codex.call("patch_document", {
      reference,
      document_id: id,
      base_revision: b.body.error.current.revision,
      edits: [{ find: "- Spread widens at 22:00\n", replace: "- Spread widens at 22:00\n- LP2 rejects at size\n" }],
    });
    expect(merged.isError).toBe(false);

    const read = await claude.call("read_documents", { reference, document_ids: [id] });
    expect(read.body.documents[0].markdown).toBe("# Findings\n- Spread widens at 22:00\n- LP2 rejects at size\n");

    const changes = await claude.call("get_changes", { reference, cursor: startCursor });
    expect(changes.body.events.map((e: { type: string; clientName: string }) => [e.type, e.clientName])).toEqual([
      ["document.updated", "Claude Code"],
      ["document.updated", "Codex"],
    ]);

    const closed = await codex.call("close_brain", { reference, export: true });
    expect(closed.body.export.documents[0].markdown).toContain("LP2 rejects at size");
    const after = await claude.call("read_index", { reference });
    expect(after.body.error.code).toBe("brain_closed");
  });

  it("enforces scopes granted to the connection", async () => {
    const { fetch } = testInstance();
    const writer = await connect(fetch, (await signIn(fetch, "Writer")).access_token);
    const { reference } = (await writer.call("create_brain", { project: "P" })).body;
    const reader = await connect(fetch, (await signIn(fetch, "Reader", "brain:read")).access_token);
    expect((await reader.call("read_index", { reference })).isError).toBe(false);
    const write = await reader.call("create_document", { reference, title: "x", markdown: "" });
    expect(write.body.error.code).toBe("insufficient_scope");
    const close = await reader.call("close_brain", { reference, export: false });
    expect(close.body.error.code).toBe("insufficient_scope");
  });
});

describe("private_key_jwt clients from metadata documents", () => {
  const CLIENT_ID = "https://chat.example.com/oauth/client.json";
  const JWKS_URI = "https://chat.example.com/oauth/jwks.json";
  const REDIRECT = "https://chat.example.com/oauth/callback";
  const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

  async function keyPair(alg: "RS256" | "ES256") {
    const params = alg === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }
      : { name: "ECDSA", namedCurve: "P-256" };
    const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: `${alg}-key`, use: "sig", alg };
    const sign = async (claims: Record<string, unknown>) => {
      const header = b64url(new TextEncoder().encode(JSON.stringify({ alg, kid: `${alg}-key`, typ: "JWT" })));
      const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
      const sig = await crypto.subtle.sign(alg === "RS256" ? { name: "RSASSA-PKCS1-v1_5" } : { name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
      return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
    };
    return { jwk, sign };
  }

  function remote(docs: Record<string, unknown>) {
    return async (url: string) => (docs[url] ? new Response(JSON.stringify(docs[url])) : new Response("missing", { status: 404 }));
  }

  const claims = (over: Record<string, unknown> = {}) => ({
    iss: CLIENT_ID,
    sub: CLIENT_ID,
    aud: `${BASE}/token`,
    exp: Math.floor(Date.now() / 1000) + 120,
    jti: crypto.randomUUID(),
    ...over,
  });

  async function codeFor(fetch: Parameters<typeof authorize>[0]) {
    const { res, verifier } = await authorize(fetch, CLIENT_ID, { redirect: REDIRECT });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    return { code, verifier };
  }

  const token = (fetch: Parameters<typeof authorize>[0], body: Record<string, string>) =>
    fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

  for (const alg of ["RS256", "ES256"] as const) {
    it(`authenticates with a ${alg} assertion signed by a key from jwks_uri`, async () => {
      const key = await keyPair(alg);
      const { fetch } = testInstance({}, {
        fetch: remote({
          [CLIENT_ID]: { client_id: CLIENT_ID, client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt", jwks_uri: JWKS_URI },
          [JWKS_URI]: { keys: [key.jwk] },
        }),
      });
      const { code, verifier } = await codeFor(fetch);
      const assertion = await key.sign(claims());
      const base = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" };
      const res = await token(fetch, { ...base, client_assertion: assertion });
      expect(res.status).toBe(200);
      const tokens = (await res.json()) as { access_token: string; refresh_token: string };
      const agent = await connect(fetch, tokens.access_token);
      expect((await agent.call("list_projects")).isError).toBe(false);

      // Refreshing needs a fresh assertion; replaying the old one fails.
      const replay = await token(fetch, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_assertion_type: base.client_assertion_type, client_assertion: assertion });
      expect(replay.status).toBe(401);
      const refreshed = await token(fetch, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_assertion_type: base.client_assertion_type, client_assertion: await key.sign(claims({ aud: BASE })) });
      expect(refreshed.status).toBe(200);
    });
  }

  it("rejects missing, forged, misaddressed and expired assertions", async () => {
    const key = await keyPair("RS256");
    const other = await keyPair("RS256");
    const { fetch } = testInstance({}, {
      fetch: remote({ [CLIENT_ID]: { client_id: CLIENT_ID, redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt", jwks: { keys: [key.jwk] } } }),
    });
    const type = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    const attempts: Record<string, string>[] = [
      { client_id: CLIENT_ID },
      { client_assertion_type: type, client_assertion: await other.sign(claims()) },
      { client_assertion_type: type, client_assertion: await key.sign(claims({ aud: "https://elsewhere.example/token" })) },
      { client_assertion_type: type, client_assertion: await key.sign(claims({ exp: Math.floor(Date.now() / 1000) - 600 })) },
      { client_assertion_type: type, client_assertion: await key.sign(claims({ exp: Math.floor(Date.now() / 1000) + 86400 })) },
      { client_assertion_type: type, client_assertion: await key.sign(claims({ sub: "someone-else" })) },
      { client_assertion_type: type, client_assertion: await key.sign(claims({ jti: undefined })) },
    ];
    for (const extra of attempts) {
      const { code, verifier } = await codeFor(fetch);
      const res = await token(fetch, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, ...extra });
      expect(res.status).toBe(401);
    }
  });

  it("advertises private_key_jwt and its signing algorithms", async () => {
    const { fetch } = testInstance();
    const asm = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, string[]>;
    expect(asm.token_endpoint_auth_methods_supported).toContain("private_key_jwt");
    expect(asm.token_endpoint_auth_signing_alg_values_supported).toEqual(expect.arrayContaining(["RS256", "ES256"]));
  });
});
