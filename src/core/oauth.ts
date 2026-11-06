import { sha256Base64Url, sha256Hex, timingSafeEqual } from "./crypto.js";
import { newOpaqueId, newSecret } from "./ids.js";
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
  token_endpoint_auth_method: "none" | "client_secret_post" | "client_secret_basic";
  grant_types: string[];
  response_types: string[];
  scope?: string;
}

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

export class OAuthService {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
  ) {}

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
  async authenticateClient(clientId: string | null, clientSecret: string | null) {
    if (!clientId) throw new OAuthError("invalid_client", "Client authentication is required.", 401);
    const client = this.getClient(clientId);
    if (!client) throw new OAuthError("invalid_client", "Unknown client.", 401);
    if (client.secretHash) {
      if (!clientSecret || !timingSafeEqual(await sha256Hex(clientSecret), client.secretHash)) {
        throw new OAuthError("invalid_client", "Client authentication failed.", 401);
      }
    }
    return client;
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
