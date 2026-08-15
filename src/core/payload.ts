/**
 * Payload construction: envelope -> optional gzip -> optional AES-GCM.
 *
 * Both `CompressionStream` and `crypto.subtle` are web standards available in
 * Node, so this whole path is exercised by the Node test suite rather than only
 * in a browser.
 */

import { unwrapEnvelope, wrapEnvelope, type Envelope } from './envelope.js';
import { segmentCountFor } from './emitter.js';
import type { Manifest } from './manifest.js';
import { chooseK, MAX_RECEIVE_BYTES, MIN_COMPRESSION_GAIN, PBKDF2_ITERATIONS } from './params.js';
import { sha256Hex } from './sha256.js';

export interface BuildPayloadOptions {
  name: string;
  mime: string;
  data: Uint8Array;
  passphrase?: string;
  /** Upper bound on source symbols; the actual K is derived from the payload. */
  k: number;
  n: number;
  blockSize: number;
  /** Injectable for deterministic tests. */
  streamId?: number;
  compress?: boolean;
}

export interface BuiltPayload {
  payload: Uint8Array;
  manifest: Manifest;
  streamId: number;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class PayloadTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`payload exceeds ${limit} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

async function through(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  limit: number,
): Promise<Uint8Array> {
  // The DOM lib types the writable side as WritableStream<BufferSource>, which is
  // not assignable to the ReadableWritablePair<Uint8Array, Uint8Array> that
  // pipeThrough infers here. The runtime contract is fine; only the variance is not.
  const pair = stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const readable = new Blob([data as BlobPart]).stream().pipeThrough(pair);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    // Decompression is the one path where output size is not bounded by input:
    // a run of zero bytes compresses at roughly 1000:1, so a hostile 1MB stream
    // would otherwise expand past a gigabyte the moment the transfer completes.
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new PayloadTooLargeError(limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export function gzip(data: Uint8Array, limit = MAX_RECEIVE_BYTES): Promise<Uint8Array> {
  return through(data, new CompressionStream('gzip'), limit);
}

export function gunzip(data: Uint8Array, limit = MAX_RECEIVE_BYTES): Promise<Uint8Array> {
  return through(data, new DecompressionStream('gzip'), limit);
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function buildPayload(opts: BuildPayloadOptions): Promise<BuiltPayload> {
  const envelope = wrapEnvelope(opts.name, opts.mime, opts.data);

  let body = envelope;
  let compressed = false;
  if (opts.compress !== false) {
    const gz = await gzip(envelope);
    if (gz.length < envelope.length * (1 - MIN_COMPRESSION_GAIN)) {
      body = gz;
      compressed = true;
    }
  }

  const encrypted = typeof opts.passphrase === 'string' && opts.passphrase.length > 0;
  let kdf: Manifest['kdf'];
  let iv: string | undefined;

  if (encrypted) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(opts.passphrase!, salt, PBKDF2_ITERATIONS);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes as BufferSource }, key, body as BufferSource),
    );
    body = ct;
    kdf = { salt: toBase64(salt), iterations: PBKDF2_ITERATIONS };
    iv = toBase64(ivBytes);
  }

  const streamId =
    opts.streamId !== undefined ? opts.streamId >>> 0 : crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;

  // K is chosen only now, from the size the payload actually ended up.
  const k = chooseK(body.length, opts.blockSize, opts.k);

  const manifest: Manifest = {
    v: 1,
    size: body.length,
    hash: sha256Hex(body),
    k,
    n: opts.n,
    blockSize: opts.blockSize,
    segCount: segmentCountFor(body.length, k, opts.blockSize),
    compressed,
    encrypted,
    ...(encrypted ? { kdf, iv } : { name: opts.name, mime: opts.mime, plainSize: opts.data.length }),
  };

  return { payload: body, manifest, streamId };
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('wrong-passphrase');
    this.name = 'WrongPassphraseError';
  }
}

export async function openPayload(
  payload: Uint8Array,
  manifest: Manifest,
  passphrase?: string,
): Promise<Envelope> {
  let body = payload;

  if (manifest.encrypted) {
    if (!passphrase) throw new WrongPassphraseError();
    const key = await deriveKey(passphrase, fromBase64(manifest.kdf!.salt), manifest.kdf!.iterations);
    try {
      body = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64(manifest.iv!) as BufferSource },
          key,
          body as BufferSource,
        ),
      );
    } catch {
      throw new WrongPassphraseError();
    }
  }

  if (manifest.compressed) {
    // A cleartext sender advertises the decompressed size; hold it to that
    // rather than to the global ceiling.
    const limit =
      manifest.plainSize !== undefined
        ? Math.min(MAX_RECEIVE_BYTES, manifest.plainSize + 1024)
        : MAX_RECEIVE_BYTES;
    body = await gunzip(body, limit);
  }

  const envelope = unwrapEnvelope(body);
  if (envelope === null) throw new Error('payload: malformed envelope');
  return envelope;
}
