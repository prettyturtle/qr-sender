/**
 * In-process optical-channel simulator.
 *
 * Models the three things that actually happen between a screen and a camera:
 *
 *  - **capture rate** — the receiver decodes fewer frames per second than the
 *    sender displays. Sampling is *periodic* by default because that is the
 *    adversarial case: a receiver whose sampling period divides the segment
 *    count could otherwise miss the same segments forever.
 *  - **loss** — glare, blur, motion; the frame is simply never decoded.
 *  - **corruption** — a frame decodes but with wrong bytes, caught by CRC.
 *
 * NOTE: this harness deliberately skips QR rendering and the camera. It cannot
 * prove anything about the optical layer — that is what the `BarcodeDetector`
 * fidelity checks and on-device runs are for.
 */

import { Emitter } from '../emitter.js';
import type { Manifest } from '../manifest.js';
import { Receiver } from '../receiver.js';

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

export function randomBytes(len: number, seed: number): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.floor(r() * 256);
  return out;
}

/** Highly compressible content, so the gzip branch is actually taken. */
export function compressibleBytes(len: number, seed: number): Uint8Array {
  const r = rng(seed);
  const out = new Uint8Array(len);
  const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'epsilon '];
  const enc = new TextEncoder();
  let o = 0;
  while (o < len) {
    const w = enc.encode(words[Math.floor(r() * words.length)]);
    const take = Math.min(w.length, len - o);
    out.set(w.subarray(0, take), o);
    o += take;
  }
  return out;
}

export interface ChannelOptions {
  /** Fraction of displayed frames the receiver manages to decode. */
  captureRate?: number;
  captureMode?: 'periodic' | 'random';
  /** Of captured frames, fraction lost outright. */
  lossRate?: number;
  /** Of captured frames, fraction that arrive with corrupted bytes. */
  corruptRate?: number;
  /** Frames displayed before the receiver starts watching (mid-stream join). */
  startOffset?: number;
  /** Safety stop. */
  maxFrames?: number;
  seed?: number;
}

export interface ChannelResult {
  receiver: Receiver;
  framesDisplayed: number;
  framesCaptured: number;
  framesIngested: number;
  passes: number;
  completed: boolean;
  /**
   * Captured frames per symbol strictly required. This is the number that
   * matters: it counts frames the receiver spent camera time on but could not
   * use, so 1.0 means every decoded frame advanced the transfer.
   */
  captureOverhead: number;
  /** Distinct symbols accepted per symbol required — pure coding efficiency. */
  codingOverhead: number;
  peakRepairBytes: number;
}

export function runChannel(
  payload: Uint8Array,
  manifest: Manifest,
  streamId: number,
  opts: ChannelOptions = {},
): ChannelResult {
  const captureRate = opts.captureRate ?? 1;
  const captureMode = opts.captureMode ?? 'periodic';
  const lossRate = opts.lossRate ?? 0;
  const corruptRate = opts.corruptRate ?? 0;
  const startOffset = opts.startOffset ?? 0;
  const maxFrames = opts.maxFrames ?? 5_000_000;
  const r = rng(opts.seed ?? 12345);

  const emitter = new Emitter({
    payload,
    manifest,
    streamId,
    k: manifest.k,
    n: manifest.n,
    blockSize: manifest.blockSize,
  });
  const receiver = new Receiver();

  let displayed = 0;
  let captured = 0;
  let ingested = 0;
  let peakRepairBytes = 0;

  for (let i = 0; i < startOffset; i++) {
    emitter.next();
    displayed++;
  }

  const base = displayed;
  while (displayed - base < maxFrames && !receiver.complete) {
    const frame = emitter.next();
    const idx = displayed - base;
    displayed++;

    const take =
      captureMode === 'periodic'
        ? Math.floor((idx + 1) * captureRate) > Math.floor(idx * captureRate)
        : r() < captureRate;
    if (!take) continue;
    captured++;

    if (lossRate > 0 && r() < lossRate) continue;

    let wire = frame;
    if (corruptRate > 0 && r() < corruptRate) {
      wire = frame.slice();
      wire[Math.floor(r() * wire.length)] ^= 0xff;
    }

    receiver.ingest(wire);
    ingested++;
    if (receiver.heldRepairBytes > peakRepairBytes) peakRepairBytes = receiver.heldRepairBytes;
  }

  const needed = receiver.progress.needed || 1;
  return {
    receiver,
    framesDisplayed: displayed - base,
    framesCaptured: captured,
    framesIngested: ingested,
    passes: emitter.passes,
    completed: receiver.complete,
    captureOverhead: captured / needed,
    codingOverhead: receiver.framesAccepted / needed,
    peakRepairBytes,
  };
}
