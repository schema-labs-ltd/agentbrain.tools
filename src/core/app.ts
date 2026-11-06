import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { verifyPassword } from "./crypto.js";
import { createMcpServer, SERVER_VERSION } from "./mcp.js";
import { ALL_SCOPES, OAuthError, type OAuthService, type Scope, type TokenInfo } from "./oauth.js";
import { consentPage, errorPage, PAGE_HEADERS } from "./pages.js";
import type { BrainStore } from "./store.js";

export interface AppOptions {
  /** Public base URL, for example https://agentbrain.tools (no trailing slash). */
  publicUrl: string;
  store: BrainStore;
  oauth: OAuthService;
  /** Called before each request, for example to finish one-time setup. */
  ready?: () => Promise<void>;
}

const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024;

export function createApp(opts: AppOptions): Hono {
  const base = opts.publicUrl.replace(/\/+$/, "");
  const resource = `${base}/mcp`;
  const resourceMetadataUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
  const { store, oauth } = opts;
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (opts.ready) await opts.ready();
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof OAuthError) return c.json(err.toJSON(), err.status as 400);
    console.error(err);
    return c.json({ error: "server_error", error_description: "Unexpected server error." }, 500);
  });

  // ------------------------------------------------------------------ discovery

  app.get("/", (c) =>
    c.text(`Agent Brain ${SERVER_VERSION}\n\nThis is an MCP server. Connect your agent to ${resource}\n`),
  );
  app.get("/healthz", (c) => c.json({ ok: true, version: SERVER_VERSION }));

  const protectedResource = (c: Context) =>
    c.json({
      resource,
      authorization_servers: [base],
      scopes_supported: ALL_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Agent Brain",
    });
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);

  const authServerMetadata = (c: Context) =>
    c.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      scopes_supported: ALL_SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
  app.get("/.well-known/oauth-authorization-server", authServerMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", authServerMetadata);

  // ------------------------------------------------------------------ registration

  app.post("/register", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new OAuthError("invalid_client_metadata", "Expected a JSON body.");
    }
    const client = await oauth.registerClient(body);
    return c.json(client, 201, { "cache-control": "no-store" });
  });

  // ------------------------------------------------------------------ authorization

  const redirectWith = (redirectUri: string, params: Record<string, string | null | undefined>) => {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    return new Response(null, { status: 302, headers: { location: url.toString(), "cache-control": "no-store" } });
  };

  const html = (body: string, status = 200) => new Response(body, { status, headers: PAGE_HEADERS });

  app.get("/authorize", async (c) => {
    const params = new URL(c.req.url).searchParams;
    try {
      await oauth.resolveClient(params.get("client_id"));
      const { request, clientName, scopes } = oauth.startAuthorization(params);
      return html(consentPage({ requestId: request.id, clientName, redirectHost: new URL(request.redirect_uri).host || request.redirect_uri, scopes }));
    } catch (e) {
      const err = e as OAuthError & { redirectUri?: string; state?: string | null };
      if (err instanceof OAuthError && err.redirectUri) {
        return redirectWith(err.redirectUri, { error: err.error, error_description: err.description, state: err.state, iss: base });
      }
      if (err instanceof OAuthError) return html(errorPage("Cannot connect", err.description), 400);
      throw e;
    }
  });

  app.post("/authorize", async (c) => {
    const form = await c.req.parseBody();
    const requestId = String(form.request_id ?? "");
    const request = oauth.getPendingRequest(requestId);
    if (!request) return html(errorPage("Request expired", "This sign-in request has expired. Start again from your agent."), 400);
    if (form.decision !== "allow") {
      oauth.consumeRequest(request.id);
      return redirectWith(request.redirect_uri, { error: "access_denied", error_description: "The user denied access.", state: request.state, iss: base });
    }
    const email = String(form.email ?? "");
    const password = String(form.password ?? "");
    const user = store.findUserByEmail(email);
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const valid = await verifyPassword(password, user?.password_hash ?? "pbkdf2-sha256$100000$00$00");
    if (!user || !valid) {
      const client = oauth.getClient(request.client_id);
      if (!oauth.recordFailedAttempt(request.id)) {
        return html(errorPage("Too many attempts", "Sign-in failed too many times. Start again from your agent."), 429);
      }
      return html(
        consentPage({
          requestId: request.id,
          clientName: client?.client_name ?? "An unnamed client",
          redirectHost: new URL(request.redirect_uri).host || request.redirect_uri,
          scopes: request.scopes.split(" ") as Scope[],
          error: "That email and password do not match.",
          email,
        }),
        401,
      );
    }
    const code = await oauth.issueCode(request, user.id);
    return redirectWith(request.redirect_uri, { code, state: request.state, iss: base });
  });

  // ------------------------------------------------------------------ tokens

  const clientCredentials = (c: Context, form: Record<string, unknown>) => {
    const header = c.req.header("authorization");
    if (header?.startsWith("Basic ")) {
      const decoded = atob(header.slice(6));
      const i = decoded.indexOf(":");
      return { id: decodeURIComponent(decoded.slice(0, i)), secret: decodeURIComponent(decoded.slice(i + 1)) };
    }
    return { id: form.client_id ? String(form.client_id) : null, secret: form.client_secret ? String(form.client_secret) : null };
  };

  const str = (v: unknown) => (v == null || v === "" ? null : String(v));

  app.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const creds = clientCredentials(c, form);
    await oauth.resolveClient(creds.id);
    const client = await oauth.authenticateClient(creds.id, creds.secret);
    const grant = form.grant_type;
    let tokens;
    if (grant === "authorization_code") {
      if (!form.code) throw new OAuthError("invalid_request", "code is required.");
      tokens = await oauth.exchangeCode(client.client_id, String(form.code), str(form.code_verifier), str(form.redirect_uri), str(form.resource));
    } else if (grant === "refresh_token") {
      if (!form.refresh_token) throw new OAuthError("invalid_request", "refresh_token is required.");
      tokens = await oauth.refresh(client.client_id, String(form.refresh_token), str(form.scope), str(form.resource));
    } else {
      throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
    }
    return c.json(tokens, 200, { "cache-control": "no-store", pragma: "no-cache" });
  });

  app.post("/revoke", async (c) => {
    const form = await c.req.parseBody();
    const creds = clientCredentials(c, form);
    await oauth.resolveClient(creds.id);
    const client = await oauth.authenticateClient(creds.id, creds.secret);
    if (form.token) await oauth.revoke(client.client_id, String(form.token));
    return c.body(null, 200);
  });

  // ------------------------------------------------------------------ MCP

  const unauthorized = (error?: string, description?: string) => {
    const parts = [`Bearer resource_metadata="${resourceMetadataUrl}"`];
    if (error) parts.push(`error="${error}"`);
    if (description) parts.push(`error_description="${description}"`);
    return new Response(JSON.stringify({ error: error ?? "unauthorized", error_description: description ?? "Authentication required." }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": parts.join(", ") },
    });
  };

  const authenticate = async (c: Context): Promise<TokenInfo | Response> => {
    const header = c.req.header("authorization");
    if (!header?.startsWith("Bearer ")) return unauthorized();
    const info = await oauth.verifyAccessToken(header.slice(7).trim());
    if (!info) return unauthorized("invalid_token", "The access token is invalid, expired or revoked.");
    if (info.resource && info.resource.replace(/\/+$/, "") !== resource && info.resource.replace(/\/+$/, "") !== base) {
      return unauthorized("invalid_token", "The access token was issued for a different resource.");
    }
    return info;
  };

  app.post("/mcp", async (c) => {
    const auth = await authenticate(c);
    if (auth instanceof Response) return auth;
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_MCP_BODY_BYTES) return c.json({ error: "payload_too_large" }, 413);
    const server = createMcpServer(store, auth);
    // Stateless: a fresh transport per request, with plain JSON responses.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, {
        authInfo: { token: "", clientId: auth.clientId, scopes: auth.scopes, expiresAt: Math.floor(auth.expiresAt / 1000) },
      });
    } finally {
      // Responses are complete JSON bodies, so the server can be released immediately.
      void server.close();
    }
  });

  // Server-initiated streams and sessions arrive with change notifications in Phase 2.
  const notAllowed = (c: Context) => c.json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}
