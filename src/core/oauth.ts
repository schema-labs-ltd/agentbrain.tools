import { sha256Base64Url, sha256Hex, timingSafeEqual } from "./crypto.js";
import { newOpaqueId, newSecret } from "./ids.js";
import { decodeJwt, verifyJwsSignature, type Jwk } from "./jwt.js";
import { one, type Sql } from "./sql.js";

export const SCOPES = {
  "brain:read": "Read projects, brain indexes, documents and changes",
  "brain:write": "Create projects and brains, and change documents",
  "brain:close": "Close brains, deleting their content",
} as const;
export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TTL_MS = 10 * 60 * 1000;
export const MAX_LOGIN_ATTEMPTS = 5;

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}

export interface ClientMetadata {
  redirect_uris: string[];
  client_name?: string;
  client_uri?: string;
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
  grant_types: string[];
  response_types: string[];
  scope?: string;
  /** For private_key_jwt clients (metadata documents only): inline keys or a URL serving them. */
  jwks?: { keys: Jwk[] };
  jwks_uri?: string;
}

/** A client assertion presented at the token or revocation endpoint (RFC 7523). */
export interface ClientAssertion {
  type: string | null;
  value: string | null;
}

export const JWT_BEARER_ASSERTION = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ASSERTION_MAX_LIFETIME_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const JWKS_CACHE_MS = 60 * 60 * 1000;

export interface RegisteredClient extends ClientMetadata {
  client_id: string;
  client_id_issued_at: number;
  client_secret?: string;
  client_secret_expires_at?: number;
}

export type PendingRequest = {
  id: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scopes: string;
  resource: string | null;
  attempts: number;
  expires_at: number;
};

export interface TokenInfo {
  userId: string;
  clientId: string;
  clientName?: string;
  scopes: Scope[];
  resource: string | null;
  expiresAt: number;
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Validate a redirect URI: HTTPS, loopback HTTP, or a private-use app scheme. */
export function validRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return isLoopback(url.hostname);
  const forbidden = ["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"];
  return !forbidden.includes(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

/** Parse a space-separated scope string, defaulting to every scope. */
export function parseScopes(scope: string | null | undefined): Scope[] {
  if (!scope || !scope.trim()) return [...ALL_SCOPES];
  const requested = scope.trim().split(/\s+/);
  const unknown = requested.filter((s) => !(s in SCOPES));
  if (unknown.length) throw new OAuthError("invalid_scope", `Unknown scope: ${unknown.join(", ")}`);
  return [...new Set(requested)] as Scope[];
}

const CIMD_CACHE_MS = 24 * 60 * 60 * 1000;
const CIMD_MAX_BYTES = 16 * 1024;

/** Client ID Metadata Documents: the client_id is an HTTPS URL serving the client's metadata. */
export function isMetadataDocumentClientId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h.includes(":"); // any IPv6 literal
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class OAuthService {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init),
  ) {}

  // ------------------------------------------------------------ client ID metadata documents

  /**
   * When client_id is an HTTPS URL, fetch and validate its metadata document
   * and cache it as a public client. Other client IDs are left alone.
   */
  async resolveClient(clientId: string | null | undefined): Promise<void> {
    if (!clientId || !isMetadataDocumentClientId(clientId)) return;
    const cached = one<{ created_at: number }>(this.sql, `SELECT created_at FROM oauth_clients WHERE client_id = ?`, clientId);
    if (cached && this.now() - cached.created_at < CIMD_CACHE_MS) return;
    const metadata = await this.fetchClientMetadata(clientId);
    this.sql.run(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, metadata, created_at) VALUES (?, NULL, ?, ?)
       ON CONFLICT (client_id) DO UPDATE SET metadata = excluded.metadata, created_at = excluded.created_at`,
      clientId,
      JSON.stringify(metadata),
      this.now(),
    );
  }

  /** Fetch a small JSON document from a public HTTPS URL, without following redirects. */
  private async fetchPublicJson(target: string, what: string): Promise<Record<string, unknown>> {
    const bad = (why: string) => new OAuthError("invalid_client", `${what} rejected: ${why}`);
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw bad("it is not a valid URL.");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.pathname === "/" || privateHost(url.hostname)) {
      throw bad("it must be a public HTTPS URL with a path.");
    }
    let res: Response;
    try {
      res = await this.fetchFn(url.toString(), { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(5000) });
    } catch {
      throw bad("it could not be fetched.");
    }
    if (!res.ok) throw bad(`fetching it returned HTTP ${res.status}.`);
    const text = await res.text();
    if (text.length > CIMD_MAX_BYTES) throw bad("it is too large.");
    try {
      const doc = JSON.parse(text) as unknown;
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error();
      return doc as Record<string, unknown>;
    } catch {
      throw bad("it is not a JSON object.");
    }
  }

  private async fetchClientMetadata(clientId: string): Promise<ClientMetadata> {
    const what = "Client metadata document";
    const bad = (why: string) => new OAuthError("invalid_client", `${what} rejected: ${why}`);
    const url = new URL(clientId);
    const doc = await this.fetchPublicJson(clientId, what);
    if (doc.client_id !== clientId) throw bad("its client_id does not match the URL it was fetched from.");
    if ("client_secret" in doc || "client_secret_expires_at" in doc) throw bad("it must not contain a client secret.");
    const method = doc.token_endpoint_auth_method ?? "none";
    if (method !== "none" && method !== "private_key_jwt") {
      throw bad(`token_endpoint_auth_method ${String(method)} is not supported; use none or private_key_jwt.`);
    }
    let jwks: { keys: Jwk[] } | undefined;
    let jwksUri: string | undefined;
    if (method === "private_key_jwt") {
      if (doc.jwks !== undefined) {
        const keys = (doc.jwks as { keys?: unknown })?.keys;
        if (!Array.isArray(keys) || keys.length === 0 || keys.length > 20) throw bad("jwks must contain between 1 and 20 keys.");
        jwks = { keys: keys as Jwk[] };
      } else if (typeof doc.jwks_uri === "string") {
        jwksUri = doc.jwks_uri;
        new URL(jwksUri);
      } else {
        throw bad("private_key_jwt requires jwks or jwks_uri.");
      }
    }
    const redirectUris = doc.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 20) throw bad("redirect_uris must list between 1 and 20 URIs.");
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || !validRedirectUri(uri)) throw bad(`redirect URI not allowed: ${String(uri)}`);
    }
    const grantTypes = (doc.grant_types as string[] | undefined) ?? ["authorization_code"];
    if (!Array.isArray(grantTypes) || !grantTypes.includes("authorization_code")) throw bad("grant_types must include authorization_code.");
    return {
      redirect_uris: redirectUris as string[],
      client_name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : url.host,
      client_uri: typeof doc.client_uri === "string" ? doc.client_uri.slice(0, 500) : undefined,
      token_endpoint_auth_method: method,
      ...(jwks ? { jwks } : {}),
      ...(jwksUri ? { jwks_uri: jwksUri } : {}),
      grant_types: grantTypes.filter((g) => g === "authorization_code" || g === "refresh_token"),
      response_types: ["code"],
      scope: typeof doc.scope === "string" ? doc.scope : undefined,
    };
  }

  // ------------------------------------------------------------ clients

  async registerClient(body: unknown): Promise<RegisteredClient> {
    if (!body || typeof body !== "object") throw new OAuthError("invalid_client_metadata", "Expected a JSON object.");
    const input = body as Record<string, unknown>;
    const redirectUris = input.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
      throw new OAuthError("invalid_redirect_uri", "redirect_uris must list between 1 and 10 URIs.");
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || !validRedirectUri(uri)) {
        throw new OAuthError("invalid_redirect_uri", `Redirect URI not allowed: ${String(uri)}`);
      }
    }
    const method = (input.token_endpoint_auth_method as string | undefined) ?? "client_secret_basic";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
      throw new OAuthError("invalid_client_metadata", `Unsupported token_endpoint_auth_method: ${method}`);
    }
    const grantTypes = (input.grant_types as string[] | undefined) ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grantTypes) || grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
      throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
    }
    if (input.scope !== undefined && typeof input.scope === "string") parseScopes(input.scope);
    const clientName = typeof input.client_name === "string" ? input.client_name.slice(0, 100) : undefined;
    const clientUri = typeof input.client_uri === "string" ? input.client_uri.slice(0, 500) : undefined;
    const metadata: ClientMetadata = {
      redirect_uris: redirectUris as string[],
      client_name: clientName,
      client_uri: clientUri,
      token_endpoint_auth_method: method as ClientMetadata["token_endpoint_auth_method"],
      grant_types: grantTypes,
      response_types: ["code"],
      scope: typeof input.scope === "string" ? input.scope : undefined,
    };
    const clientId = newOpaqueId();
    const issuedAt = Math.floor(this.now() / 1000);
    const secret = method === "none" ? undefined : newSecret();
    this.sql.run(
      `INSERT INTO oauth_clients (client_id, client_secret_hash, metadata, created_at) VALUES (?, ?, ?, ?)`,
      clientId,
      secret ? await sha256Hex(secret) : null,
      JSON.stringify(metadata),
      this.now(),
    );
    return {
      ...metadata,
      client_id: clientId,
      client_id_issued_at: issuedAt,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    };
  }

  getClient(clientId: string): (ClientMetadata & { client_id: string; secretHash: string | null }) | undefined {
    const row = one<{ client_id: string; client_secret_hash: string | null; metadata: string }>(
      this.sql,
      `SELECT client_id, client_secret_hash, metadata FROM oauth_clients WHERE client_id = ?`,
      clientId,
    );
    if (!row) return undefined;
    return { ...(JSON.parse(row.metadata) as ClientMetadata), client_id: row.client_id, secretHash: row.client_secret_hash };
  }

  /** Authenticate a client at the token or revocation endpoint. */
  async authenticateClient(
    clientId: string | null,
    clientSecret: string | null,
    assertion: ClientAssertion = { type: null, value: null },
    audiences: string[] = [],
  ) {
    if (!clientId && assertion.value) {
      // With private_key_jwt, the client may identify itself only through the assertion.
      try {
        const iss = decodeJwt(assertion.value).payload.iss;
        if (typeof iss === "string") clientId = iss;
      } catch {
        throw new OAuthError("invalid_client", "The client assertion is malformed.", 401);
      }
      await this.resolveClient(clientId);
    }
    if (!clientId) throw new OAuthError("invalid_client", "Client authentication is required.", 401);
    const client = this.getClient(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);
    if (client.token_endpoint_auth_method === "private_key_jwt") {
      await this.verifyClientAssertion(client, assertion, audiences);
      return client;
    }
    if (assertion.value) throw new OAuthError("invalid_client", "This client does not use private_key_jwt.", 401);
    if (client.secretHash) {
      if (!clientSecret || !timingSafeEqual(await sha256Hex(clientSecret), client.secretHash)) {
        throw new OAuthError("invalid_client", "Client authentication failed.", 401);
      }
    }
    return client;
  }

  private jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();

  private async clientKeys(client: ClientMetadata, refresh: boolean): Promise<Jwk[]> {
    if (client.jwks) return client.jwks.keys;
    if (!client.jwks_uri) return [];
    const cached = this.jwksCache.get(client.jwks_uri);
    if (cached && !refresh && this.now() - cached.fetchedAt < JWKS_CACHE_MS) return cached.keys;
    const doc = await this.fetchPublicJson(client.jwks_uri, "Client JWKS");
    const keys = Array.isArray(doc.keys) ? (doc.keys as Jwk[]).slice(0, 20) : [];
    this.jwksCache.set(client.jwks_uri, { keys, fetchedAt: this.now() });
    return keys;
  }

  /** RFC 7523 client authentication: a signed JWT whose iss and sub are the client_id. */
  private async verifyClientAssertion(
    client: ClientMetadata & { client_id: string },
    assertion: ClientAssertion,
    audiences: string[],
  ): Promise<void> {
    const fail = (why: string) => new OAuthError("invalid_client", `Client assertion rejected: ${why}`, 401);
    if (assertion.type !== JWT_BEARER_ASSERTION || !assertion.value) throw fail("a jwt-bearer client_assertion is required.");
    let jwt;
    try {
      jwt = decodeJwt(assertion.value);
    } catch {
      throw fail("it is malformed.");
    }
    let valid = await verifyJwsSignature(jwt, await this.clientKeys(client, false));
    if (!valid && client.jwks_uri) valid = await verifyJwsSignature(jwt, await this.clientKeys(client, true));
    if (!valid) throw fail("the signature does not verify against the client's keys.");
    const { iss, sub, aud, exp, nbf, jti } = jwt.payload as { iss?: unknown; sub?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; jti?: unknown };
    if (iss !== client.client_id || sub !== client.client_id) throw fail("iss and sub must equal the client_id.");
    const auds = Array.isArray(aud) ? aud : [aud];
    if (!auds.some((a) => typeof a === "string" && audiences.includes(a.replace(/\/+$/, "")))) throw fail("aud does not name this server.");
    const now = this.now();
    if (typeof exp !== "number" || exp * 1000 < now - CLOCK_SKEW_MS) throw fail("it has expired.");
    if (exp * 1000 > now + ASSERTION_MAX_LIFETIME_MS + CLOCK_SKEW_MS) throw fail("its lifetime is too long.");
    if (typeof nbf === "number" && nbf * 1000 > now + CLOCK_SKEW_MS) throw fail("it is not yet valid.");
    if (typeof jti !== "string" || !jti || jti.length > 256) throw fail("a jti is required.");
    this.sql.run(`DELETE FROM client_assertion_jtis WHERE expires_at < ?`, now - CLOCK_SKEW_MS);
    const used = one(this.sql, `SELECT 1 AS used FROM client_assertion_jtis WHERE client_id = ? AND jti = ?`, client.client_id, jti);
    if (used) throw fail("it has already been used.");
    this.sql.run(`INSERT INTO client_assertion_jtis (client_id, jti, expires_at) VALUES (?, ?, ?)`, client.client_id, jti, exp * 1000);
  }

  // ------------------------------------------------------------ authorization requests

  startAuthorization(params: URLSearchParams): { request: PendingRequest; clientName: string; scopes: Scope[] } {
    const clientId = params.get("client_id");
    const client = clientId ? this.getClient(clientId) : undefined;
    if (!client) throw new OAuthError("invalid_client", "Unknown client_id.");
    let redirectUri = params.get("redirect_uri");
    if (!redirectUri) {
      if (client.redirect_uris.length !== 1) throw new OAuthError("invalid_request", "redirect_uri is required.");
      redirectUri = client.redirect_uris[0]!;
    }
    if (!client.redirect_uris.includes(redirectUri)) {
      throw new OAuthError("invalid_request", "redirect_uri is not registered for this client.");
    }
    // From here on, errors can be returned to the client's redirect URI.
    const fail = (error: string, description: string) => {
      const e = new OAuthError(error, description);
      (e as OAuthError & { redirectUri?: string; state?: string | null }).redirectUri = redirectUri!;
      (e as OAuthError & { redirectUri?: string; state?: string | null }).state = params.get("state");
      return e;
    };
    if (params.get("response_type") !== "code") throw fail("unsupported_response_type", "Only response_type=code is supported.");
    const challenge = params.get("code_challenge");
    if (!challenge || !/^[A-Za-z0-9._~-]{43,128}$/.test(challenge)) throw fail("invalid_request", "A PKCE code_challenge is required.");
    if ((params.get("code_challenge_method") ?? "plain") !== "S256") throw fail("invalid_request", "code_challenge_method must be S256.");
    let scopes: Scope[];
    try {
      scopes = parseScopes(params.get("scope"));
    } catch (e) {
      throw fail("invalid_scope", (e as Error).message);
    }
    const resource = params.get("resource");
    const request: PendingRequest = {
      id: newSecret(),
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      state: params.get("state"),
      scopes: scopes.join(" "),
      resource,
      attempts: 0,
      expires_at: this.now() + REQUEST_TTL_MS,
    };
    this.sql.run(`DELETE FROM oauth_requests WHERE expires_at < ?`, this.now());
    this.sql.run(
      `INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, scopes, resource, attempts, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      request.id,
      request.client_id,
      request.redirect_uri,
      request.code_challenge,
      request.state,
      request.scopes,
      request.resource,
      request.expires_at,
    );
    return { request, clientName: client.client_name ?? "An unnamed client", scopes };
  }

  getPendingRequest(id: string): PendingRequest | undefined {
    const row = one<PendingRequest>(this.sql, `SELECT * FROM oauth_requests WHERE id = ?`, id);
    if (!row || row.expires_at < this.now()) return undefined;
    return row;
  }

  /** Count a failed sign-in. Returns false once the request has used all its attempts. */
  recordFailedAttempt(id: string): boolean {
    this.sql.run(`UPDATE oauth_requests SET attempts = attempts + 1 WHERE id = ?`, id);
    const row = one<{ attempts: number }>(this.sql, `SELECT attempts FROM oauth_requests WHERE id = ?`, id);
    if (!row || row.attempts >= MAX_LOGIN_ATTEMPTS) {
      this.sql.run(`DELETE FROM oauth_requests WHERE id = ?`, id);
      return false;
    }
    return true;
  }

  consumeRequest(id: string): void {
    this.sql.run(`DELETE FROM oauth_requests WHERE id = ?`, id);
  }

  async issueCode(request: PendingRequest, userId: string): Promise<string> {
    const code = newSecret();
    this.sql.run(`DELETE FROM oauth_codes WHERE expires_at < ?`, this.now());
    this.sql.run(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      await sha256Hex(code),
      request.client_id,
      userId,
      request.redirect_uri,
      request.code_challenge,
      request.scopes,
      request.resource,
      this.now() + CODE_TTL_MS,
    );
    this.consumeRequest(request.id);
    return code;
  }

  // ------------------------------------------------------------ tokens

  async exchangeCode(
    clientId: string,
    code: string,
    codeVerifier: string | null,
    redirectUri: string | null,
    resource: string | null,
  ): Promise<TokenResponse> {
    const codeHash = await sha256Hex(code);
    const row = one<{ client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: string; resource: string | null; expires_at: number }>(
      this.sql,
      `SELECT * FROM oauth_codes WHERE code_hash = ?`,
      codeHash,
    );
    // Codes are single use: delete before any further checks.
    this.sql.run(`DELETE FROM oauth_codes WHERE code_hash = ?`, codeHash);
    if (!row || row.expires_at < this.now() || row.client_id !== clientId) {
      throw new OAuthError("invalid_grant", "The authorization code is invalid or has expired.");
    }
    if (redirectUri && redirectUri !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match.");
    if (!codeVerifier || !timingSafeEqual(await sha256Base64Url(codeVerifier), row.code_challenge)) {
      throw new OAuthError("invalid_grant", "PKCE verification failed.");
    }
    if (resource && row.resource && resource !== row.resource) throw new OAuthError("invalid_target", "resource does not match the authorization request.");
    return this.issueTokens(row.client_id, row.user_id, row.scopes, resource ?? row.resource, newOpaqueId());
  }

  async refresh(clientId: string, refreshToken: string, scope: string | null, resource: string | null): Promise<TokenResponse> {
    const hash = await sha256Hex(refreshToken);
    const row = one<{ kind: string; family_id: string; client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number; revoked: number }>(
      this.sql,
      `SELECT * FROM oauth_tokens WHERE token_hash = ?`,
      hash,
    );
    if (!row || row.kind !== "refresh" || row.client_id !== clientId) throw new OAuthError("invalid_grant", "The refresh token is invalid.");
    if (row.revoked) {
      // A rotated refresh token was replayed: revoke the whole family.
      this.sql.run(`UPDATE oauth_tokens SET revoked = 1 WHERE family_id = ?`, row.family_id);
      throw new OAuthError("invalid_grant", "The refresh token has already been used.");
    }
    if (row.expires_at < this.now()) throw new OAuthError("invalid_grant", "The refresh token has expired.");
    let scopes = row.scopes;
    if (scope) {
      const granted = new Set(row.scopes.split(" "));
      const requested = parseScopes(scope);
      if (requested.some((s) => !granted.has(s))) throw new OAuthError("invalid_scope", "Cannot widen scopes on refresh.");
      scopes = requested.join(" ");
    }
    if (resource && row.resource && resource !== row.resource) throw new OAuthError("invalid_target", "resource does not match the original grant.");
    this.sql.run(`UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?`, hash);
    return this.issueTokens(row.client_id, row.user_id, scopes, resource ?? row.resource, row.family_id);
  }

  private async issueTokens(clientId: string, userId: string, scopes: string, resource: string | null, familyId: string): Promise<TokenResponse> {
    const access = newSecret();
    const refresh = newSecret();
    const now = this.now();
    this.sql.run(`DELETE FROM oauth_tokens WHERE expires_at < ?`, now);
    const insert = `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, user_id, scopes, resource, expires_at, revoked)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`;
    this.sql.run(insert, await sha256Hex(access), "access", familyId, clientId, userId, scopes, resource, now + ACCESS_TOKEN_TTL_MS);
    this.sql.run(insert, await sha256Hex(refresh), "refresh", familyId, clientId, userId, scopes, resource, now + REFRESH_TOKEN_TTL_MS);
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refresh,
      scope: scopes,
    };
  }

  /** Check an access token on every request, so revocation takes effect immediately. */
  async verifyAccessToken(token: string): Promise<TokenInfo | undefined> {
    const row = one<{ kind: string; client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number; revoked: number }>(
      this.sql,
      `SELECT * FROM oauth_tokens WHERE token_hash = ?`,
      await sha256Hex(token),
    );
    if (!row || row.kind !== "access" || row.revoked || row.expires_at < this.now()) return undefined;
    const user = one<{ id: string }>(this.sql, `SELECT id FROM users WHERE id = ?`, row.user_id);
    if (!user) return undefined;
    const client = this.getClient(row.client_id);
    return {
      userId: row.user_id,
      clientId: row.client_id,
      clientName: client?.client_name,
      scopes: row.scopes.split(" ") as Scope[],
      resource: row.resource,
      expiresAt: row.expires_at,
    };
  }

  /** RFC 7009 revocation. Revoking either token revokes the whole grant. */
  async revoke(clientId: string, token: string): Promise<void> {
    const row = one<{ family_id: string; client_id: string }>(
      this.sql,
      `SELECT family_id, client_id FROM oauth_tokens WHERE token_hash = ?`,
      await sha256Hex(token),
    );
    if (row && row.client_id === clientId) {
      this.sql.run(`UPDATE oauth_tokens SET revoked = 1 WHERE family_id = ?`, row.family_id);
    }
  }
}
