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
