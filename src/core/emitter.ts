/**
 * Carousel emitter — the sending half of the schedule.
 *
 * Every segment advances together. A pass emits each `(segment, symbol)` pair
 * exactly once, so a receiver capturing a fraction `r` of frames collects `r*N`
 * distinct symbols per segment per pass. With `r*N >= K` every receiver, fast
 * or slow, finishes in a single pass at 1.0x coding overhead and none of them
 * ever sits idle waiting for a segment it has already completed.
 *
 * Symbols are emitted in bursts of `BURST` per segment so the source is read
 * once per burst instead of once per frame, and the segment order is reshuffled
 * every burst so a receiver whose sampling period happens to divide the segment
 * count cannot systematically miss the same segments forever.
 */

import { packFrame, type FrameHeader } from './frame.js';
import { encodeManifest, type Manifest } from './manifest.js';
import {
  BURST,
  FLAG_COMPRESSED,
  FLAG_ENCRYPTED,
  FLAG_MANIFEST,
  MANIFEST_INDEX,
  MANIFEST_INTERVAL,
  PROTOCOL_VERSION,
  assertParams,
} from './params.js';
import { encodeSymbol } from './rs.js';

export interface EmitterOptions {
  /** Transmitted payload: already enveloped, compressed and/or encrypted. */
  payload: Uint8Array;
  manifest: Manifest;
  streamId: number;
  k: number;
  n: number;
  blockSize: number;
}

export function segmentCountFor(payloadLength: number, k: number, blockSize: number): number {
  return Math.max(1, Math.ceil(payloadLength / (k * blockSize)));
}

function shuffleInto(order: Uint32Array, seed: number): void {
  let s = (seed * 2654435761) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  for (let i = order.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
}

export class Emitter {
  readonly segCount: number;
  readonly k: number;
  readonly n: number;
  readonly blockSize: number;
  readonly streamId: number;
  readonly totalSymbols: number;

  /** Completed carousel passes. Surfaced to the sender UI as the loop counter. */
  passes = 0;
  framesEmitted = 0;

  private readonly payload: Uint8Array;
  private readonly manifestFrame: Uint8Array;
  private readonly flags: number;

  private readonly order: Uint32Array;
  private readonly segBuf: Uint8Array;
  private readonly symBuf: Uint8Array;
  private loadedSegment = -1;

  private burstBase = 0;
  private orderPos = 0;
  private sym = 0;
  private sinceManifest = MANIFEST_INTERVAL; // emit a manifest as the very first frame

  constructor(opts: EmitterOptions) {
    assertParams(opts.k, opts.n);
    this.payload = opts.payload;
    this.k = opts.k;
    this.n = opts.n;
    this.blockSize = opts.blockSize;
    this.streamId = opts.streamId >>> 0;
    this.segCount = segmentCountFor(opts.payload.length, opts.k, opts.blockSize);
    this.totalSymbols = this.segCount * opts.k;

    if (this.segCount > 0xffff) throw new Error('payload requires more than 65535 segments');
    if (opts.manifest.segCount !== this.segCount) {
      throw new Error('manifest segCount does not match payload');
    }

    this.flags =
      (opts.manifest.compressed ? FLAG_COMPRESSED : 0) |
      (opts.manifest.encrypted ? FLAG_ENCRYPTED : 0);

    this.manifestFrame = packFrame(
      this.headerFor(MANIFEST_INDEX, MANIFEST_INDEX, this.flags | FLAG_MANIFEST),
      encodeManifest(opts.manifest, opts.blockSize),
    );

    this.order = new Uint32Array(this.segCount);
    for (let i = 0; i < this.segCount; i++) this.order[i] = i;
    shuffleInto(this.order, 0);

    this.segBuf = new Uint8Array(opts.k * opts.blockSize);
    this.symBuf = new Uint8Array(opts.blockSize);
  }

  /** Bytes the sender keeps resident regardless of payload size. */
  get residentBytes(): number {
    return this.segBuf.byteLength + this.symBuf.byteLength + this.manifestFrame.byteLength;
  }

  next(): Uint8Array {
    if (this.sinceManifest >= MANIFEST_INTERVAL) {
      this.sinceManifest = 0;
      this.framesEmitted++;
      return this.manifestFrame;
    }
    this.sinceManifest++;
    this.framesEmitted++;

    const seg = this.order[this.orderPos];
    const sym = this.sym;
    this.advance();

    if (this.loadedSegment !== seg) {
      this.loadSegment(seg);
      this.loadedSegment = seg;
    }
    encodeSymbol(this.segBuf, this.k, this.blockSize, sym, this.symBuf);

    return packFrame(this.headerFor(seg, sym, this.flags), this.symBuf);
  }

  private advance(): void {
    const burstEnd = Math.min(this.burstBase + BURST, this.n);
    this.sym++;
    if (this.sym < burstEnd) return;

    this.sym = this.burstBase;
    this.orderPos++;
    if (this.orderPos < this.segCount) return;

    this.orderPos = 0;
    this.burstBase = burstEnd;
    if (this.burstBase >= this.n) {
      this.burstBase = 0;
      this.passes++;
    }
    this.sym = this.burstBase;
    shuffleInto(this.order, this.passes * 0x10000 + this.burstBase + 1);
  }

  private loadSegment(seg: number): void {
    const span = this.k * this.blockSize;
    const start = seg * span;
    const end = Math.min(start + span, this.payload.length);
    this.segBuf.fill(0);
    if (start < this.payload.length) this.segBuf.set(this.payload.subarray(start, end));
  }

  private headerFor(segIndex: number, symIndex: number, flags: number): FrameHeader {
    return {
      version: PROTOCOL_VERSION,
      flags,
      streamId: this.streamId,
      segIndex,
      symIndex,
      segCount: this.segCount,
      k: this.k,
      n: this.n,
      blockSize: this.blockSize,
    };
  }
}
