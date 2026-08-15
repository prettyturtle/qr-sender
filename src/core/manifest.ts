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
 * Smallest block size that can always carry a manifest. Encrypted manifests are
 * the largest (base64 salt + IV) at roughly 300 bytes; the real profile carries
 * 1211, so this only ever binds in tests or on an exotic QR downshift.
 */
export const MIN_BLOCK_SIZE_FOR_MANIFEST = 512;

/** Serialise into a fixed `blockSize` payload: `[u16 length][json][zero padding]`. */
export function encodeManifest(manifest: Manifest, blockSize: number): Uint8Array {
  const json = enc.encode(JSON.stringify(manifest));
  if (json.length + 2 > blockSize) {
    throw new Error(
      `manifest too large: ${json.length + 2} > blockSize ${blockSize}. ` +
        `blockSize must be at least ${MIN_BLOCK_SIZE_FOR_MANIFEST}.`,
    );
  }
  const out = new Uint8Array(blockSize);
  new DataView(out.buffer).setUint16(0, json.length);
  out.set(json, 2);
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

