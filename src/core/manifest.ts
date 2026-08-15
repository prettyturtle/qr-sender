/**
 * Manifest frame payload — what the receiver needs before it can name, verify,
 * or decrypt the stream. Interleaved every `MANIFEST_INTERVAL` frames so a
 * mid-join receiver can label the transfer within ~2 seconds.
 *
 * Data frames carry K/N/blockSize/segCount in their own header, so the receiver
 * can start accumulating symbols immediately and never waits on the manifest.
 */

import {
  MAX_MIME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PBKDF2_ITERATIONS,
  MAX_RECEIVE_BYTES,
} from './params.js';

export interface Manifest {
  v: 1;
  /** Length of the transmitted payload, after compression and encryption. */
  size: number;
  /** SHA-256 (hex) of the transmitted payload. */
  hash: string;
  k: number;
  n: number;
  blockSize: number;
  segCount: number;
  compressed: boolean;
  encrypted: boolean;
  /** Cleartext transfers advertise these for immediate display; encrypted ones must not (see envelope.ts). */
  name?: string;
  mime?: string;
  plainSize?: number;
  /** Key-derivation parameters, present only when `encrypted`. */
  kdf?: { salt: string; iterations: number };
  iv?: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Smallest block size that can carry a manifest with no filename attached.
 * Encrypted manifests are the largest of those (base64 salt and IV) at roughly
 * 240 bytes; `fitManifest` trims the optional display fields to whatever is left
 * over on small profiles.
 */
export const MIN_BLOCK_SIZE_FOR_MANIFEST = 320;

/**
 * Trim the optional display fields until the manifest fits the block.
 *
 * Name and MIME are duplicated here purely so a receiver can label the transfer
 * before it completes — the authoritative copy travels inside the envelope,
 * where it is also covered by encryption. Dropping them costs a label, whereas
 * overflowing the block would fail the transfer outright, which is the wrong
 * trade on a small QR profile with a long filename.
 */
export function fitManifest(manifest: Manifest, blockSize: number): Manifest {
  const fits = (m: Manifest): boolean => encodeManifestPrefixed(m).length <= blockSize;
  if (fits(manifest)) return manifest;

  let m: Manifest = { ...manifest };
  if (m.plainSize !== undefined) {
    delete m.plainSize;
    if (fits(m)) return m;
  }
  if (m.name !== undefined) {
    const overflow = encodeManifestPrefixed(m).length - blockSize;
    const keep = Math.max(0, [...m.name].length - overflow - 1);
    m = { ...m, name: keep > 0 ? [...m.name].slice(0, keep).join('') + '…' : undefined };
    if (m.name === undefined) delete m.name;
    if (fits(m)) return m;
  }
  if (m.mime !== undefined) {
    delete m.mime;
    if (fits(m)) return m;
  }
  if (m.name !== undefined) {
    delete m.name;
    if (fits(m)) return m;
  }
  throw new Error(`manifest cannot fit blockSize ${blockSize}`);
}

/** `[u16 length][json]`, unpadded — the form a single-frame transfer embeds. */
export function encodeManifestPrefixed(manifest: Manifest): Uint8Array {
  const json = enc.encode(JSON.stringify(manifest));
  const out = new Uint8Array(2 + json.length);
  new DataView(out.buffer).setUint16(0, json.length);
  out.set(json, 2);
  return out;
}

/** Serialise into a fixed `blockSize` payload: `[u16 length][json][zero padding]`. */
export function encodeManifest(manifest: Manifest, blockSize: number): Uint8Array {
  const prefixed = encodeManifestPrefixed(manifest);
  if (prefixed.length > blockSize) {
    throw new Error(
      `manifest too large: ${prefixed.length} > blockSize ${blockSize}. ` +
        `blockSize must be at least ${MIN_BLOCK_SIZE_FOR_MANIFEST}.`,
    );
  }
  const out = new Uint8Array(blockSize);
  out.set(prefixed, 0);
  return out;
}

export function decodeManifest(payload: Uint8Array): Manifest | null {
  if (payload.length < 2) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const len = view.getUint16(0);
  if (len === 0 || 2 + len > payload.length) return null;
  try {
    const parsed = JSON.parse(dec.decode(payload.subarray(2, 2 + len))) as Manifest;
    if (parsed?.v !== 1) return null;
    // `Number.isInteger` rather than `typeof === 'number'`: NaN is a number and
    // would slip past every comparison below.
    if (!Number.isInteger(parsed.size) || parsed.size < 0 || parsed.size > MAX_RECEIVE_BYTES) return null;
    if (typeof parsed.hash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.hash)) return null;
    if (!Number.isInteger(parsed.k) || !Number.isInteger(parsed.n)) return null;
    if (!Number.isInteger(parsed.blockSize) || !Number.isInteger(parsed.segCount)) return null;
    if (typeof parsed.compressed !== 'boolean' || typeof parsed.encrypted !== 'boolean') return null;

    if (parsed.plainSize !== undefined) {
      if (!Number.isInteger(parsed.plainSize) || parsed.plainSize < 0) return null;
      if (parsed.plainSize > MAX_RECEIVE_BYTES) return null;
    }
    if (parsed.name !== undefined && (typeof parsed.name !== 'string' || parsed.name.length > MAX_NAME_LENGTH)) {
      return null;
    }
    if (parsed.mime !== undefined && (typeof parsed.mime !== 'string' || parsed.mime.length > MAX_MIME_LENGTH)) {
      return null;
    }

    if (parsed.encrypted) {
      // Metadata must never travel in the clear on an encrypted stream.
      if (parsed.name !== undefined || parsed.mime !== undefined || parsed.plainSize !== undefined) return null;
      const kdf = parsed.kdf;
      if (!kdf || typeof kdf.salt !== 'string' || kdf.salt.length === 0 || kdf.salt.length > 64) return null;
      // An unbounded iteration count is a denial of service the victim triggers
      // themselves by entering a passphrase, with no way to cancel it.
      if (!Number.isInteger(kdf.iterations) || kdf.iterations < 1 || kdf.iterations > MAX_PBKDF2_ITERATIONS) {
        return null;
      }
      if (typeof parsed.iv !== 'string' || parsed.iv.length === 0 || parsed.iv.length > 32) return null;
    } else if (parsed.kdf !== undefined || parsed.iv !== undefined) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

