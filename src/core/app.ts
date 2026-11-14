import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { CLERK_SIGN_IN_ERRORS, type AccountService } from "./accounts.js";
import { API_KEY_PREFIX, type ApiKeyService } from "./apikeys.js";
import { CLERK_SIGNIN_JS, clerkPage } from "./clerkui.js";
import { sha256Hex, verifyPassword } from "./crypto.js";
import { BrainError } from "./errors.js";
import { extensionFor, imageHeaders } from "./images.js";
import { SUPPORTED_SIGNING_ALGS } from "./jwt.js";
import type { EventService } from "./events.js";
import { createMcpServer, readLimited, SERVER_VERSION } from "./mcp.js";
import { ALL_SCOPES, OAuthError, type FetchFn, type OAuthService, type Scope, type TokenInfo } from "./oauth.js";
import { clerkPageHeaders, consentPage, errorPage, PAGE_HEADERS } from "./pages.js";
import type { BrainStore } from "./store.js";
import { registerWebsite } from "./web.js";
import type { WebSessionService } from "./websession.js";

export interface AppOptions {
  /** Public base URL, for example https://agentbrain.tools (no trailing slash). */
  publicUrl: string;
  store: BrainStore;
  oauth: OAuthService;
  /** MCP events (webhook subscriptions). Omit to leave the extension off. */
  events?: EventService;
  /** Called before each request, for example to finish one-time setup. */
  ready?: () => Promise<void>;
  /** Called after each MCP request that may have changed a brain, so pending events can be delivered. */
  afterMcpRequest?: () => void;
  /** Browser sessions for the read-only website. Omit to serve only the MCP server and OAuth pages. */
  sessions?: WebSessionService;
  /** Outbound fetch, for images uploaded from a source URL. */
  fetch?: FetchFn;
  /** Accounts, and Clerk sign-in when it is configured. */
  accounts: AccountService;
  /** API keys for agents that cannot complete an OAuth sign-in. Omit to accept only OAuth access tokens. */
  apiKeys?: ApiKeyService;
}

/** Large enough for an inline base64 image at the default 5 MiB limit, plus JSON overhead. */
const MAX_MCP_BODY_BYTES = 8 * 1024 * 1024;


export function createApp(opts: AppOptions): Hono {
  const base = opts.publicUrl.replace(/\/+$/, "");
  const resource = `${base}/mcp`;
  const resourceMetadataUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
  const { store, oauth, accounts } = opts;
  const clerkUi = accounts.clerk ? clerkPage(accounts.clerk) : undefined;
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

  // The sign-in helper for pages that use Clerk. Static, so it can be cached briefly.
  app.get("/assets/clerk-signin.js", (c) =>
    c.body(CLERK_SIGNIN_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    }),
  );

  if (opts.sessions) {
    registerWebsite(app, { base, store, sessions: opts.sessions, accounts, apiKeys: opts.apiKeys });
  } else {
    app.get("/", (c) =>
      c.text(`Agent Brain ${SERVER_VERSION}\n\nThis is an MCP server. Connect your agent to ${resource}\n`),
    );
  }
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
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic", "private_key_jwt"],
      token_endpoint_auth_signing_alg_values_supported: SUPPORTED_SIGNING_ALGS,
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic", "private_key_jwt"],
      revocation_endpoint_auth_signing_alg_values_supported: SUPPORTED_SIGNING_ALGS,
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

  const html = (body: string, status = 200) =>
    new Response(body, { status, headers: clerkUi ? clerkPageHeaders(clerkUi) : PAGE_HEADERS });

  app.get("/authorize", async (c) => {
    const params = new URL(c.req.url).searchParams;
    try {
      await oauth.resolveClient(params.get("client_id"));
      const { request, clientName, scopes } = oauth.startAuthorization(params);
      return html(
        consentPage({ requestId: request.id, clientName, redirectHost: new URL(request.redirect_uri).host || request.redirect_uri, scopes, clerk: clerkUi }),
      );
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
    const retry = (status: number, error: string, email?: string) => {
      const client = oauth.getClient(request.client_id);
      return html(
        consentPage({
          requestId: request.id,
          clientName: client?.client_name ?? "An unnamed client",
          redirectHost: new URL(request.redirect_uri).host || request.redirect_uri,
          scopes: request.scopes.split(" ") as Scope[],
          error,
          email,
          clerk: clerkUi,
        }),
        status,
      );
    };
    if (accounts.clerk) {
      const result = await accounts.signInWithClerk(String(form.clerk_token ?? ""));
      if (!result.ok) {
        if (!oauth.recordFailedAttempt(request.id)) {
          return html(errorPage("Too many attempts", "Sign-in failed too many times. Start again from your agent."), 429);
        }
        return retry(result.reason === "unavailable" ? 503 : 401, CLERK_SIGN_IN_ERRORS[result.reason]);
      }
      const code = await oauth.issueCode(request, result.userId);
      return redirectWith(request.redirect_uri, { code, state: request.state, iss: base });
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

  const assertionAudiences = [base, `${base}/token`, `${base}/revoke`];
  const str = (v: unknown) => (v == null || v === "" ? null : String(v));

  app.post("/token", async (c) => {
    const form = await c.req.parseBody();
    const creds = clientCredentials(c, form);
    await oauth.resolveClient(creds.id);
    const client = await oauth.authenticateClient(
      creds.id,
      creds.secret,
      { type: str(form.client_assertion_type), value: str(form.client_assertion) },
      assertionAudiences,
    );
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
    const client = await oauth.authenticateClient(
      creds.id,
      creds.secret,
      { type: str(form.client_assertion_type), value: str(form.client_assertion) },
      assertionAudiences,
    );
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
    const token = header.slice(7).trim();
    if (token.startsWith(API_KEY_PREFIX)) {
      const key = opts.apiKeys ? await opts.apiKeys.verify(token) : undefined;
      if (!key) return unauthorized("invalid_token", "The API key is invalid or has been revoked.");
      if (!(await accounts.isActive(key.userId))) {
        return unauthorized("invalid_token", "This Agent Brain account has been removed or suspended.");
      }
      return {
        userId: key.userId,
        clientId: `apikey:${key.id}`,
        clientName: `API key "${key.name}"`,
        scopes: key.scopes,
        resource: null,
        // Keys do not expire; this only fills the MCP SDK's auth info for this request.
        expiresAt: Date.now() + 60 * 60 * 1000,
        apiKey: { id: key.id, name: key.name, projects: key.projects },
      };
    }
    const info = await oauth.verifyAccessToken(token);
    if (!info) return unauthorized("invalid_token", "The access token is invalid, expired or revoked.");
    if (!(await accounts.isActive(info.userId))) {
      return unauthorized("invalid_token", "This Agent Brain account has been removed or suspended.");
    }
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
    const state = { forbidden: false };
    const server = createMcpServer(store, auth, opts.events, { base, fetch: opts.fetch, state });
    // Stateless: a fresh transport per request, with plain JSON responses.
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(c.req.raw, {
        authInfo: { token: "", clientId: auth.clientId, scopes: auth.scopes, expiresAt: Math.floor(auth.expiresAt / 1000) },
      });
      // A call outside an API key's limits: keep the JSON-RPC body, which explains the limit, but answer 403.
      if (state.forbidden) return new Response(res.body, { status: 403, headers: res.headers });
      return res;
    } finally {
      // Responses are complete JSON bodies, so the server can be released immediately.
      void server.close();
      opts.afterMcpRequest?.();
    }
  });

  // ------------------------------------------------------------------ image links

  const linkError = (e: unknown) => {
    if (e instanceof BrainError) {
      const status = e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "limit_exceeded" ? 413 : e.code === "brain_closed" ? 410 : 400;
      return new Response(JSON.stringify(e.toJSON()), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    throw e;
  };

  // One-time upload links from create_image_upload. The unguessable token is the credential.
  const upload = async (c: Context) => {
    try {
      const hash = await sha256Hex(c.req.param("token")!);
      const length = Number(c.req.header("content-length") ?? 0);
      if (length > store.limits.imageBytes) {
        throw new BrainError("limit_exceeded", "The image exceeds the per-image size limit. Resize or compress it, then retry.", {
          limit: "imageBytes",
          maximum: store.limits.imageBytes,
          attempted: length,
        });
      }
      const data = await readLimited(c.req.raw, store.limits.imageBytes);
      const result = store.uploadWithLink(hash, data);
      opts.afterMcpRequest?.();
      return c.json(result, 201, { "cache-control": "no-store" });
    } catch (e) {
      return linkError(e);
    }
  };
  app.put("/images/upload/:token", upload);
  app.post("/images/upload/:token", upload);

  // Short-lived download links from read_image with as: "url".
  app.get("/images/download/:token", async (c) => {
    try {
      const { image, data } = store.downloadWithLink(await sha256Hex(c.req.param("token")!));
      return new Response(data as Uint8Array<ArrayBuffer>, { headers: imageHeaders(image.mimeType, `${image.title}.${extensionFor(image.mimeType)}`) });
    } catch (e) {
      return linkError(e);
    }
  });

  // Public image links: anyone with the unguessable URL can view the image, until it is deleted or its brain closed.
  app.get("/i/:file", (c) => {
    try {
      const token = c.req.param("file")!.replace(/\.[a-z0-9]{1,5}$/i, "");
      const { image, data } = store.publicImage(token);
      return new Response(data as Uint8Array<ArrayBuffer>, {
        headers: {
          ...imageHeaders(image.mimeType, `${image.title}.${extensionFor(image.mimeType)}`),
          "cache-control": "public, max-age=3600",
          "cross-origin-resource-policy": "cross-origin",
          "x-robots-tag": "noindex",
        },
      });
    } catch (e) {
      return linkError(e);
    }
  });

  // No server-initiated streams: events go out as webhooks (ChatGPT) or through the local channel (Claude Code).
  const notAllowed = (c: Context) => c.json({ error: "method_not_allowed" }, 405, { allow: "POST" });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  return app;
}
