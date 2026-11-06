/** Lower-case Crockford base32 alphabet (no i, l, o, u). */
export const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Encode bytes as Crockford base32, most significant bits first. */
export function base32(bytes: Uint8Array, length: number): string {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < length; i++) {
    out = CROCKFORD[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** A 128-bit random identifier as 26 Crockford base32 characters. */
export function newOpaqueId(): string {
  return base32(randomBytes(16), 26);
}

/** A shorter random ID for documents (80 bits, 16 characters). Never reused. */
export function newDocumentId(): string {
  return base32(randomBytes(10), 16);
}

/** A URL-safe random secret for OAuth codes and tokens (256 bits). */
export function newSecret(): string {
  const bytes = randomBytes(32);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const REFERENCE_PREFIX = "agentBrain:";
const ID = "[0-9a-hjkmnp-tv-z]{26}";
const REFERENCE = new RegExp(`^(?:(${ID})\\.)?(${ID})$`);

/** A parsed reference. projectId is absent only for legacy single-identifier references. */
export interface ParsedReference {
  projectId?: string;
  brainId: string;
}

/** Format a reference as agentBrain:<project token>.<brain ID>. */
export function formatReference(projectId: string, brainId: string): string {
  return `${REFERENCE_PREFIX}${projectId}.${brainId}`;
}

/**
 * Parse "agentBrain:<project>.<task>", with or without the prefix. The legacy
 * single-identifier form "agentBrain:<task>" from before 2026-11-06 is still
 * accepted. Returns undefined when the input is not a well-formed reference.
 */
export function parseReference(input: string): ParsedReference | undefined {
  let s = input.trim();
  if (s.startsWith(REFERENCE_PREFIX)) s = s.slice(REFERENCE_PREFIX.length);
  const m = REFERENCE.exec(s.toLowerCase());
  if (!m) return undefined;
  return m[1] ? { projectId: m[1], brainId: m[2]! } : { brainId: m[2]! };
}
