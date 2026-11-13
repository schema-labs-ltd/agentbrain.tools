import { decodeJwt, verifyJwsSignature, type Jwk } from "./jwt.js";
import type { FetchFn } from "./oauth.js";

/** Settings for signing people in with Clerk (https://clerk.com). */
export interface ClerkSettings {
  publishableKey: string;
  secretKey: string;
  /** Backend API base URL. Defaults to https://api.clerk.com. */
  apiUrl?: string;
  /** Origins allowed in a session token's azp claim, for example https://agentbrain.tools. */
  authorizedParties: string[];
}

/** A Clerk user as far as Agent Brain cares. */
export interface ClerkUser {
  id: string;
  /** The verified primary email address, or null when there is none. */
  email: string | null;
  /** Banned or locked users may not use Agent Brain. */
  active: boolean;
}

const JWKS_CACHE_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 30;
const SCRIPT_MAJOR = 6;
const UI_MAJOR = 1;

/** The Frontend API host encoded in a publishable key, for example clerk.agentbrain.tools. */
export function frontendApiFromKey(publishableKey: string): string {
  const match = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey.trim());
  if (!match) throw new Error("CLERK_PUBLISHABLE_KEY is not a Clerk publishable key.");
  const decoded = atob(match[2]!.replace(/-/g, "+").replace(/_/g, "/"));
  const host = decoded.replace(/\$$/, "");
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("CLERK_PUBLISHABLE_KEY does not contain a valid Frontend API host.");
  return host;
}

/**
 * Verifies Clerk session tokens and reads users from Clerk's Backend API.
 * Clerk only proves who someone is; Agent Brain keeps its own users, sessions and OAuth grants.
 */
export class ClerkAuth {
  readonly publishableKey: string;
  readonly frontendApi: string;
  private readonly apiUrl: string;
  private jwks: { keys: Jwk[]; fetchedAt: number } | undefined;

  constructor(
    private readonly settings: ClerkSettings,
    private readonly fetchFn: FetchFn,
    private readonly now: () => number = Date.now,
  ) {
    this.publishableKey = settings.publishableKey.trim();
    this.frontendApi = frontendApiFromKey(this.publishableKey);
    this.apiUrl = (settings.apiUrl ?? "https://api.clerk.com").replace(/\/+$/, "");
  }

  /** The issuer of this instance's session tokens. */
  get issuer(): string {
    return `https://${this.frontendApi}`;
  }

  /** Clerk's browser SDK, served by the instance's Frontend API. */
  get scriptUrl(): string {
    return `https://${this.frontendApi}/npm/@clerk/clerk-js@${SCRIPT_MAJOR}/dist/clerk.browser.js`;
  }

  /** Clerk's prebuilt sign-in components, which clerk-js 6 loads separately. */
  get uiScriptUrl(): string {
    return `https://${this.frontendApi}/npm/@clerk/ui@${UI_MAJOR}/dist/ui.browser.js`;
  }

  /**
   * Check a session token from the browser SDK. Returns the Clerk user ID, or
   * undefined when the token is malformed, forged, expired, pending or meant for another site.
   */
  async verifySessionToken(token: string | undefined): Promise<string | undefined> {
    if (!token || token.length > 8192) return undefined;
    let jwt;
    try {
      jwt = decodeJwt(token);
    } catch {
      return undefined;
    }
    if (jwt.header.alg !== "RS256") return undefined;
    const p = jwt.payload;
    const nowS = Math.floor(this.now() / 1000);
    if (p.iss !== this.issuer) return undefined;
    if (typeof p.sub !== "string" || !p.sub.startsWith("user_")) return undefined;
    if (typeof p.exp !== "number" || p.exp + CLOCK_SKEW_S < nowS) return undefined;
    if (typeof p.nbf === "number" && p.nbf - CLOCK_SKEW_S > nowS) return undefined;
    if (typeof p.iat === "number" && p.iat - CLOCK_SKEW_S > nowS) return undefined;
    if (p.azp !== undefined && !this.settings.authorizedParties.includes(String(p.azp))) return undefined;
    // Sessions waiting on a further step (for example choosing an organisation) are not signed in yet.
    if (p.sts !== undefined && p.sts !== "active") return undefined;
    let keys = await this.keys(false);
    if (jwt.header.kid && !keys.some((k) => k.kid === jwt.header.kid)) keys = await this.keys(true);
    return (await verifyJwsSignature(jwt, keys)) ? p.sub : undefined;
  }

  /** Read a user from Clerk. Returns null when the user no longer exists. Throws when Clerk cannot be reached. */
  async getUser(userId: string): Promise<ClerkUser | null> {
    const res = await this.fetchFn(`${this.apiUrl}/v1/users/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${this.settings.secretKey}`, accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Clerk returned HTTP ${res.status} for a user lookup.`);
    const body = (await res.json()) as {
      id: string;
      banned?: boolean;
      locked?: boolean;
      primary_email_address_id?: string | null;
      email_addresses?: { id: string; email_address: string; verification?: { status?: string } | null }[];
    };
    const primary = body.email_addresses?.find((e) => e.id === body.primary_email_address_id);
    const email = primary && primary.verification?.status === "verified" ? primary.email_address.trim().toLowerCase() : null;
    return { id: body.id, email, active: !body.banned && !body.locked };
  }

  private async keys(force: boolean): Promise<Jwk[]> {
    if (!force && this.jwks && this.jwks.fetchedAt + JWKS_CACHE_MS > this.now()) return this.jwks.keys;
    const res = await this.fetchFn(`${this.apiUrl}/v1/jwks`, {
      headers: { authorization: `Bearer ${this.settings.secretKey}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Clerk returned HTTP ${res.status} for its signing keys.`);
    const body = (await res.json()) as { keys?: Jwk[] };
    this.jwks = { keys: Array.isArray(body.keys) ? body.keys : [], fetchedAt: this.now() };
    return this.jwks.keys;
  }
}
