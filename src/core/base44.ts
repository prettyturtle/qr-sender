/**
 * base44 — binary <-> QR-alphanumeric text codec.
 *
 * The Web Barcode Detection API only exposes `DetectedBarcode.rawValue` as a
 * DOMString; raw bytes are unreachable and arbitrary byte payloads are mangled
 * by UTF-8 decoding. Encoding into the QR alphanumeric character set keeps the
 * payload lossless across that boundary while staying in QR's densest text mode
 * (5.5 bits/char).
 *
 * base45 (RFC 9285) packs 2 bytes into 3 characters because 45^3 = 91,125 >=
 * 65,536. The same packing holds for 44 characters (44^3 = 85,184 >= 65,536,
 * and 44^2 = 1,936 >= 256 for the trailing byte), so dropping SPACE from the
 * alphabet costs exactly zero density while removing any exposure to
 * leading/trailing whitespace trimming by platform barcode APIs.
 */

export const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$%*+-./:';

const BASE = 44;
const DECODE_MAP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE_MAP[ALPHABET.charCodeAt(i)] = i;

if (ALPHABET.length !== BASE) throw new Error('base44: alphabet must be 44 characters');

/** Number of characters produced by encoding `byteLength` bytes. */
export function encodedLength(byteLength: number): number {
  return Math.floor(byteLength / 2) * 3 + (byteLength % 2 === 1 ? 2 : 0);
}

/** Largest byte count whose encoding fits in `charBudget` characters. */
export function capacityForChars(charBudget: number): number {
  const pairs = Math.floor(charBudget / 3);
  const rest = charBudget - pairs * 3;
  return pairs * 2 + (rest >= 2 ? 1 : 0);
}

export function encode(bytes: Uint8Array): string {
  const n = bytes.length;
  const out = new Array<string>(encodedLength(n));
  let o = 0;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    let v = (bytes[i] << 8) | bytes[i + 1];
    const d0 = v % BASE;
    v = (v - d0) / BASE;
    const d1 = v % BASE;
    const d2 = (v - d1) / BASE;
    out[o++] = ALPHABET[d0];
    out[o++] = ALPHABET[d1];
    out[o++] = ALPHABET[d2];
  }
  if (i < n) {
    const v = bytes[i];
    const d0 = v % BASE;
    const d1 = (v - d0) / BASE;
    out[o++] = ALPHABET[d0];
    out[o++] = ALPHABET[d1];
  }
  return out.join('');
}

/** Returns null for any malformed input rather than throwing — decode paths are hot and adversarial. */
export function decode(text: string): Uint8Array | null {
  const len = text.length;
  const rem = len % 3;
  if (rem === 1) return null;

  const byteLen = Math.floor(len / 3) * 2 + (rem === 2 ? 1 : 0);
  const out = new Uint8Array(byteLen);
  let o = 0;
  let i = 0;

  for (; i + 2 < len; i += 3) {
    const c0 = text.charCodeAt(i);
    const c1 = text.charCodeAt(i + 1);
    const c2 = text.charCodeAt(i + 2);
    if (c0 > 127 || c1 > 127 || c2 > 127) return null;
    const d0 = DECODE_MAP[c0];
    const d1 = DECODE_MAP[c1];
    const d2 = DECODE_MAP[c2];
    if (d0 < 0 || d1 < 0 || d2 < 0) return null;
    const v = d0 + d1 * BASE + d2 * BASE * BASE;
    if (v > 0xffff) return null;
    out[o++] = v >>> 8;
    out[o++] = v & 0xff;
  }

  if (i < len) {
    const c0 = text.charCodeAt(i);
    const c1 = text.charCodeAt(i + 1);
    if (c0 > 127 || c1 > 127) return null;
    const d0 = DECODE_MAP[c0];
    const d1 = DECODE_MAP[c1];
    if (d0 < 0 || d1 < 0) return null;
    const v = d0 + d1 * BASE;
    if (v > 0xff) return null;
    out[o++] = v;
  }

  return out;
}
