/**
 * Carousel receiver — accumulates symbols from an arbitrary point in the stream.
 *
 * Because the code is systematic, symbol `j < K` *is* source block `j`: it is
 * written straight into the output buffer. Only repair symbols need holding, and
 * only until their segment closes. That is why the receiver's peak memory is the
 * output itself rather than some multiple of it — an all-or-nothing fountain
 * decoder would have to retain encoded combinations for every segment in flight.
 *
 * The receiver never needs to know the sender's schedule. Every frame is
 * self-describing, so join order, emission order and reshuffling are invisible
 * to it, and a sender on a newer release can change its schedule freely.
 */

import { unpackFrame } from './frame.js';
import { decodeManifest, type Manifest } from './manifest.js';
import { MAX_RECEIVE_BYTES } from './params.js';
import { recoverSegment, type ReceivedSymbol } from './rs.js';
import { sha256Hex } from './sha256.js';

export type IngestResult =
  | 'ok' // new symbol accepted
  | 'duplicate' // already had it
  | 'manifest' // manifest frame accepted
  | 'invalid' // malformed, corrupt CRC, or inconsistent with the locked stream
  | 'other-stream'; // a different transmission is on screen

export interface ReceiverProgress {
  /** Distinct useful symbols held, capped per segment at K. */
  received: number;
  /** Symbols required in total: `segCount * K`. */
  needed: number;
  ratio: number;
  segmentsDone: number;
  segCount: number;
}

export interface ReceiverSnapshot {
  streamId: number;
  k: number;
  n: number;
  blockSize: number;
  segCount: number;
  manifest: Manifest | null;
  buffer: Uint8Array;
  present: Uint8Array;
  seen: Uint8Array;
  done: Uint8Array;
  counts: Uint16Array;
  repairSyms: Uint16Array;
  repairSegs: Uint16Array;
  repairData: Uint8Array;
}

export type IntegrityState = 'unknown' | 'verified' | 'mismatch';

export class Receiver {
  streamId: number | null = null;
  manifest: Manifest | null = null;

  /** Stream id of a *different* transmission seen while this one is in progress. */
  foreignStreamId: number | null = null;

  /** Set when a well-formed frame declared a stream larger than `MAX_RECEIVE_BYTES`. */
  oversizedStream = false;

  k = 0;
  n = 0;
  blockSize = 0;
  segCount = 0;
  segmentsDone = 0;

  framesAccepted = 0;
  framesRejected = 0;

  private buffer: Uint8Array = new Uint8Array(0);
  private present: Uint8Array = new Uint8Array(0);
  private seen: Uint8Array = new Uint8Array(0);
  private done: Uint8Array = new Uint8Array(0);
  private counts: Uint16Array = new Uint16Array(0);
  private repairs = new Map<number, ReceivedSymbol[]>();
  private repairBytes = 0;

  /** Bytes held for repair symbols not yet consumed — the only memory beyond the output. */
  get heldRepairBytes(): number {
    return this.repairBytes;
  }

  get outputBytes(): number {
    return this.buffer.byteLength;
  }

  get initialised(): boolean {
    return this.streamId !== null;
  }

  get complete(): boolean {
    return this.manifest !== null && this.segCount > 0 && this.segmentsDone === this.segCount;
  }

  get progress(): ReceiverProgress {
    if (this.segCount === 0) {
      return { received: 0, needed: 0, ratio: 0, segmentsDone: 0, segCount: 0 };
    }
    let received = 0;
    for (let s = 0; s < this.segCount; s++) {
      received += this.done[s] ? this.k : Math.min(this.counts[s], this.k);
    }
    const needed = this.segCount * this.k;
    return {
      received,
      needed,
      ratio: needed === 0 ? 0 : received / needed,
      segmentsDone: this.segmentsDone,
      segCount: this.segCount,
    };
  }

  ingest(frameBytes: Uint8Array): IngestResult {
    const parsed = unpackFrame(frameBytes);
    if (parsed === null) {
      this.framesRejected++;
      return 'invalid';
    }
    const h = parsed.header;

    if (this.streamId === null) {
      // Header fields are attacker-controlled — the receiver points a camera at
      // whatever happens to be on a screen. Refuse to size a buffer from them
      // before checking the product, or a single forged frame becomes an OOM.
      if (h.segCount * h.k * h.blockSize > MAX_RECEIVE_BYTES) {
        this.framesRejected++;
        this.oversizedStream = true;
        return 'invalid';
      }
      this.init(h.streamId, h.k, h.n, h.blockSize, h.segCount);
    } else if (h.streamId !== this.streamId) {
      this.foreignStreamId = h.streamId;
      this.framesRejected++;
      return 'other-stream';
    }

    if (h.k !== this.k || h.n !== this.n || h.blockSize !== this.blockSize || h.segCount !== this.segCount) {
      this.framesRejected++;
      return 'invalid';
    }

    if (parsed.isManifest) {
      if (this.manifest !== null) return 'duplicate';
      const m = decodeManifest(parsed.payload);
      if (m === null) {
        this.framesRejected++;
        return 'invalid';
      }
      if (m.k !== this.k || m.n !== this.n || m.blockSize !== this.blockSize || m.segCount !== this.segCount) {
        this.framesRejected++;
        return 'invalid';
      }
      if (m.size > this.buffer.byteLength) {
        this.framesRejected++;
        return 'invalid';
      }
      this.manifest = m;
      this.framesAccepted++;
      return 'manifest';
    }

    const seg = h.segIndex;
    const sym = h.symIndex;

    if (this.done[seg] === 1) return 'duplicate';
    const seenIdx = seg * this.n + sym;
    if (this.seen[seenIdx] === 1) return 'duplicate';

    this.seen[seenIdx] = 1;
    this.counts[seg]++;
    this.framesAccepted++;

    if (sym < this.k) {
      this.buffer.set(parsed.payload, (seg * this.k + sym) * this.blockSize);
      this.present[seg * this.k + sym] = 1;
    } else {
      let list = this.repairs.get(seg);
      if (list === undefined) {
        list = [];
        this.repairs.set(seg, list);
      }
      const copy = parsed.payload.slice();
      list.push({ sym, data: copy });
      this.repairBytes += copy.byteLength;
    }

    if (this.counts[seg] >= this.k) this.tryClose(seg);

    return 'ok';
  }

  private tryClose(seg: number): void {
    const span = this.k * this.blockSize;
    const segment = this.buffer.subarray(seg * span, (seg + 1) * span);
    const present = this.present.subarray(seg * this.k, (seg + 1) * this.k);
    const repairs = this.repairs.get(seg) ?? [];

    if (!recoverSegment(segment, this.k, this.blockSize, present, repairs)) return;

    this.done[seg] = 1;
    this.segmentsDone++;
    for (const r of repairs) this.repairBytes -= r.data.byteLength;
    this.repairs.delete(seg);
  }

  /** Transmitted payload (post-compression, post-encryption), trimmed to the manifest length. */
  payload(): Uint8Array {
    if (!this.complete) throw new Error('receiver: transfer is not complete');
    return this.buffer.subarray(0, this.manifest!.size);
  }

  verifyIntegrity(): IntegrityState {
    if (!this.complete) return 'unknown';
    return sha256Hex(this.payload()) === this.manifest!.hash ? 'verified' : 'mismatch';
  }

  /** Discard everything and lock onto a different transmission. */
  reset(): void {
    this.streamId = null;
    this.manifest = null;
    this.foreignStreamId = null;
    this.oversizedStream = false;
    this.k = this.n = this.blockSize = this.segCount = this.segmentsDone = 0;
    this.framesAccepted = this.framesRejected = 0;
    this.buffer = new Uint8Array(0);
    this.present = new Uint8Array(0);
    this.seen = new Uint8Array(0);
    this.done = new Uint8Array(0);
    this.counts = new Uint16Array(0);
    this.repairs.clear();
    this.repairBytes = 0;
  }

  private init(streamId: number, k: number, n: number, blockSize: number, segCount: number): void {
    this.streamId = streamId;
    this.k = k;
    this.n = n;
    this.blockSize = blockSize;
    this.segCount = segCount;
    this.buffer = new Uint8Array(segCount * k * blockSize);
    this.present = new Uint8Array(segCount * k);
    this.seen = new Uint8Array(segCount * n);
    this.done = new Uint8Array(segCount);
    this.counts = new Uint16Array(segCount);
    this.repairs.clear();
    this.repairBytes = 0;
    this.segmentsDone = 0;
    // A forged oversized frame seen before a real stream locked must not leave
    // the warning stuck on for the rest of a perfectly healthy transfer.
    this.oversizedStream = false;
  }

  /**
   * Flatten state for persistence. Everything here survives a tab close, which is
   * what makes a 36-minute iOS transfer resumable instead of restart-only.
   */
  snapshot(): ReceiverSnapshot | null {
    if (this.streamId === null) return null;
    const syms: number[] = [];
    const segs: number[] = [];
    let total = 0;
    for (const [seg, list] of this.repairs) {
      for (const r of list) {
        segs.push(seg);
        syms.push(r.sym);
        total += r.data.byteLength;
      }
    }
    const repairData = new Uint8Array(total);
    let o = 0;
    for (const [, list] of this.repairs) {
      for (const r of list) {
        repairData.set(r.data, o);
        o += r.data.byteLength;
      }
    }
    return {
      streamId: this.streamId,
      k: this.k,
      n: this.n,
      blockSize: this.blockSize,
      segCount: this.segCount,
      manifest: this.manifest,
      // `buffer` is shared deliberately: every write to it is a final value, so
      // a later state is strictly more complete. The bookkeeping arrays are
      // copied, because IndexedDB clones asynchronously — without a copy, a
      // repair symbol ingested between here and the clone would be flagged in
      // `seen` while its bytes were never captured, leaving it permanently dead.
      buffer: this.buffer,
      present: this.present.slice(),
      seen: this.seen.slice(),
      done: this.done.slice(),
      counts: this.counts.slice(),
      repairSyms: Uint16Array.from(syms),
      repairSegs: Uint16Array.from(segs),
      repairData,
    };
  }

  static restore(snap: ReceiverSnapshot): Receiver {
    const r = new Receiver();
    r.streamId = snap.streamId;
    r.k = snap.k;
    r.n = snap.n;
    r.blockSize = snap.blockSize;
    r.segCount = snap.segCount;
    r.manifest = snap.manifest;
    r.buffer = snap.buffer;
    r.present = snap.present;
    r.seen = snap.seen;
    r.done = snap.done;
    r.counts = snap.counts;
    r.segmentsDone = 0;
    for (let i = 0; i < snap.done.length; i++) if (snap.done[i]) r.segmentsDone++;

    let o = 0;
    for (let i = 0; i < snap.repairSyms.length; i++) {
      const seg = snap.repairSegs[i];
      const data = snap.repairData.slice(o, o + snap.blockSize);
      o += snap.blockSize;
      let list = r.repairs.get(seg);
      if (list === undefined) {
        list = [];
        r.repairs.set(seg, list);
      }
      list.push({ sym: snap.repairSyms[i], data });
      r.repairBytes += data.byteLength;
    }
    return r;
  }
}
