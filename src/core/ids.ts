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
const OPAQUE_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;

export function formatReference(id: string): string {
  return `${REFERENCE_PREFIX}${id}`;
}

/**
 * Accept "agentBrain:<id>" or a bare identifier. Returns the normalised ID, or
 * undefined when the input is not a well-formed reference.
 */
export function parseReference(input: string): string | undefined {
  let s = input.trim();
  if (s.startsWith(REFERENCE_PREFIX)) s = s.slice(REFERENCE_PREFIX.length);
  s = s.toLowerCase();
  return OPAQUE_ID.test(s) ? s : undefined;
}
