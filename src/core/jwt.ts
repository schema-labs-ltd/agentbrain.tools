/** Minimal JWS verification for OAuth client assertions (RFC 7523), using WebCrypto only. */

type ImportAlg = Parameters<typeof crypto.subtle.importKey>[2];
type VerifyAlg = Parameters<typeof crypto.subtle.verify>[0];
type AlgSpec = { import: ImportAlg; verify: VerifyAlg; kty: string };

const ALGORITHMS: Record<string, AlgSpec> = {
  RS256: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS384: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-384" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  RS512: { kty: "RSA", import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" }, verify: { name: "RSASSA-PKCS1-v1_5" } },
  PS256: { kty: "RSA", import: { name: "RSA-PSS", hash: "SHA-256" }, verify: { name: "RSA-PSS", saltLength: 32 } },
  PS384: { kty: "RSA", import: { name: "RSA-PSS", hash: "SHA-384" }, verify: { name: "RSA-PSS", saltLength: 48 } },
  PS512: { kty: "RSA", import: { name: "RSA-PSS", hash: "SHA-512" }, verify: { name: "RSA-PSS", saltLength: 64 } },
  ES256: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-256" }, verify: { name: "ECDSA", hash: "SHA-256" } },
  ES384: { kty: "EC", import: { name: "ECDSA", namedCurve: "P-384" }, verify: { name: "ECDSA", hash: "SHA-384" } },
  EdDSA: { kty: "OKP", import: { name: "Ed25519" }, verify: { name: "Ed25519" } },
};

export const SUPPORTED_SIGNING_ALGS = Object.keys(ALGORITHMS);

export interface Jwk {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  [key: string]: unknown;
}

export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface DecodedJwt {
  header: { alg?: string; kid?: string; typ?: string };
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

/** Decode without verifying. Throws on malformed input. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("not a compact JWS");
  const decoder = new TextDecoder();
  const header = JSON.parse(decoder.decode(base64UrlDecode(parts[0]!))) as DecodedJwt["header"];
  const payload = JSON.parse(decoder.decode(base64UrlDecode(parts[1]!))) as Record<string, unknown>;
  if (!payload || typeof payload !== "object") throw new Error("payload is not an object");
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: base64UrlDecode(parts[2]!) };
}

/**
 * Verify a JWS signature against a JWK set. The key is chosen by kid when the
 * header has one; otherwise every compatible key is tried. Returns false on failure.
 */
export async function verifyJwsSignature(jwt: DecodedJwt, keys: Jwk[]): Promise<boolean> {
  const alg = jwt.header.alg;
  if (!alg || !(alg in ALGORITHMS)) return false; // rejects "none" and HMAC
  const spec = ALGORITHMS[alg]!;
  const candidates = keys.filter(
    (k) =>
      k.kty === spec.kty &&
      (!jwt.header.kid || k.kid === jwt.header.kid) &&
      (!k.alg || k.alg === alg) &&
      (!k.use || k.use === "sig") &&
      (spec.kty !== "OKP" || k.crv === "Ed25519"),
  );
  const data = new TextEncoder().encode(jwt.signingInput);
  for (const jwk of candidates) {
    try {
      const { d: _private, ...publicJwk } = jwk;
      const key = await crypto.subtle.importKey("jwk", publicJwk as JsonWebKey, spec.import, false, ["verify"]);
      if (await crypto.subtle.verify(spec.verify, key, jwt.signature as Uint8Array<ArrayBuffer>, data)) return true;
    } catch {
      // Unusable key: try the next one.
    }
  }
  return false;
}
