/**
 * Image helpers: format detection from the bytes themselves, pixel dimensions,
 * and base64 conversion that works the same on Node and Workers.
 *
 * Only raster formats that browsers and model APIs both accept are allowed.
 * SVG is refused because it can carry script.
 */

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export const IMAGE_TYPES: readonly ImageType[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface ImageInfo {
  mimeType: ImageType;
  width: number | null;
  height: number | null;
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function pngSize(b: Uint8Array): [number, number] | null {
  return b.length >= 24 && ascii(b, 12, 4) === "IHDR" ? [u32be(b, 16), u32be(b, 20)] : null;
}

function gifSize(b: Uint8Array): [number, number] | null {
  return b.length >= 10 ? [u16le(b, 6), u16le(b, 8)] : null;
}

function webpSize(b: Uint8Array): [number, number] | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return [u24le(b, 24) + 1, u24le(b, 27) + 1];
  if (chunk === "VP8 ") return [u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff];
  if (chunk === "VP8L") {
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  return null;
}

function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Standalone markers have no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = u16be(b, i + 2);
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [u16be(b, i + 7), u16be(b, i + 5)];
    }
    if (length < 2) return null;
    i += 2 + length;
  }
  return null;
}

/** Detect a supported image format from its leading bytes, or return null. */
export function detectImage(b: Uint8Array): ImageInfo | null {
  let mimeType: ImageType | null = null;
  let size: [number, number] | null = null;
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    mimeType = "image/png";
    size = pngSize(b);
  } else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    mimeType = "image/jpeg";
    size = jpegSize(b);
  } else if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) {
    mimeType = "image/gif";
    size = gifSize(b);
  } else if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    mimeType = "image/webp";
    size = webpSize(b);
  }
  if (!mimeType) return null;
  const ok = size && size[0] > 0 && size[1] > 0;
  return { mimeType, width: ok ? size![0] : null, height: ok ? size![1] : null };
}

export function extensionFor(mimeType: string): string {
  return { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[mimeType] ?? "bin";
}

/** Headers for image bytes served to agents and browsers. The image is shown inline but never interpreted as a page. */
export function imageHeaders(mimeType: string, name: string): Record<string, string> {
  return {
    "content-type": mimeType,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": `inline; filename="${name.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "image"}"`,
    "cross-origin-resource-policy": "same-origin",
  };
}

/** Encode bytes as standard base64 without building one huge argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

/** Decode standard or URL-safe base64, tolerating whitespace and a data: URL prefix. Returns null when invalid. */
export function base64ToBytes(input: string): Uint8Array<ArrayBuffer> | null {
  let s = input.trim();
  const dataUrl = /^data:[^,]*;base64,/i.exec(s);
  if (dataUrl) s = s.slice(dataUrl[0].length);
  s = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  if (s.length % 4 === 1) return null;
  s = s.padEnd(Math.ceil(s.length / 4) * 4, "=");
  try {
    const binary = atob(s);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
