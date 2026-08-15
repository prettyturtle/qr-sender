/**
 * Parallel QR decoding.
 *
 * Throughput on the receiving side is `distinct frames decoded per second`, and
 * the old pipeline decoded one frame at a time on the main thread — a 100ms
 * decode meant 10fps regardless of how fast the sender played. Both backends are
 * run concurrently instead:
 *
 *  - **zxing-wasm**: a pool of workers, each with its own wasm module. Decode
 *    rate scales with cores, and nothing runs on the thread that also has to
 *    paint the viewfinder.
 *  - **BarcodeDetector**: already asynchronous and already off-thread, so it
 *    just needs several requests in flight instead of one.
 *
 * Frames are handed over as `ImageBitmap`, which crops on the compositor and
 * transfers without copying.
 */

import { barcodeDetectorAvailable, type DetectorKind } from './detect.js';
import type { DecodeRequest, DecodeResponse } from './decodeWorker.js';

export interface DecodePool {
  readonly kind: DetectorKind;
  readonly concurrency: number;
  /** Frames currently being decoded. */
  readonly inFlight: number;
  /** Rolling mean of decoder latency in milliseconds. */
  readonly latencyMs: number;
  /**
   * Resolves to the texts found, or an empty array — never rejects. The bitmap
   * arrives already cropped and sized; no backend rescales it.
   */
  decode(bitmap: ImageBitmap): Promise<string[]>;
  close(): void;
}

/**
 * How many decodes to run at once.
 *
 * Deliberately aggressive — the point is to finish the transfer, and a phone
 * that runs warm for a minute is a better outcome than one that takes five.
 */
export function decodeConcurrency(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(8, cores));
}

class LatencyMeter {
  private mean = 0;
  private seen = 0;

  add(ms: number): void {
    this.seen++;
    // Exponential mean once the sample is meaningful, plain mean before that.
    const weight = this.seen < 8 ? 1 / this.seen : 0.15;
    this.mean += (ms - this.mean) * weight;
  }

  get value(): number {
    return this.mean;
  }
}

class WorkerPool implements DecodePool {
  readonly kind = 'zxing-wasm' as const;
  readonly concurrency: number;

  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly pending = new Map<number, (texts: string[]) => void>();
  private readonly owner = new Map<number, Worker>();
  private readonly latency = new LatencyMeter();
  private nextId = 1;
  private busy = 0;

  constructor(size: number) {
    this.concurrency = size;
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./decodeWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
        const { id, texts, ms } = event.data;
        this.latency.add(ms);
        const resolve = this.pending.get(id);
        this.pending.delete(id);
        this.owner.delete(id);
        this.idle.push(worker);
        this.busy--;
        resolve?.(texts);
      };
      // A dead worker must not strand its caller or shrink the pool silently.
      worker.onerror = () => {
        for (const [id, w] of this.owner) {
          if (w !== worker) continue;
          this.pending.get(id)?.([]);
          this.pending.delete(id);
          this.owner.delete(id);
          this.busy--;
        }
        this.idle.push(worker);
      };
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get inFlight(): number {
    return this.busy;
  }

  get latencyMs(): number {
    return this.latency.value;
  }

  decode(bitmap: ImageBitmap): Promise<string[]> {
    const worker = this.idle.pop();
    if (worker === undefined) {
      bitmap.close();
      return Promise.resolve([]);
    }
    const id = this.nextId++;
    this.busy++;
    this.owner.set(id, worker);
    const request: DecodeRequest = { id, bitmap };
    return new Promise<string[]>((resolve) => {
      this.pending.set(id, resolve);
      worker.postMessage(request, [bitmap]);
    });
  }

  close(): void {
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    for (const resolve of this.pending.values()) resolve([]);
    this.pending.clear();
    this.owner.clear();
    this.busy = 0;
  }
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmap): Promise<Array<{ rawValue: string }>>;
}

class NativePool implements DecodePool {
  readonly kind = 'barcode-detector' as const;
  readonly concurrency: number;

  private readonly detectors: BarcodeDetectorLike[];
  private free: BarcodeDetectorLike[];
  private readonly latency = new LatencyMeter();
  private busy = 0;
  private closed = false;

  constructor(size: number) {
    const ctor = (globalThis.window as unknown as {
      BarcodeDetector: new (o: { formats: string[] }) => BarcodeDetectorLike;
    }).BarcodeDetector;
    this.concurrency = size;
    // One instance per slot: sharing a single detector across concurrent calls
    // serialises inside the implementation on some platforms.
    this.detectors = Array.from({ length: size }, () => new ctor({ formats: ['qr_code'] }));
    this.free = [...this.detectors];
  }

  get inFlight(): number {
    return this.busy;
  }

  get latencyMs(): number {
    return this.latency.value;
  }

  async decode(bitmap: ImageBitmap): Promise<string[]> {
    const detector = this.free.pop();
    if (detector === undefined || this.closed) {
      bitmap.close();
      return [];
    }
    this.busy++;
    const started = performance.now();
    try {
      const found = await detector.detect(bitmap);
      return found.map((f) => f.rawValue);
    } catch {
      return [];
    } finally {
      this.latency.add(performance.now() - started);
      bitmap.close();
      this.busy--;
      this.free.push(detector);
    }
  }

  close(): void {
    this.closed = true;
    this.free = [];
    this.busy = 0;
  }
}

export interface CreatePoolOptions {
  force?: DetectorKind;
  size?: number;
}

export async function createDecodePool(opts: CreatePoolOptions = {}): Promise<DecodePool> {
  const size = opts.size ?? decodeConcurrency();
  const wantNative = opts.force !== 'zxing-wasm' && (await barcodeDetectorAvailable());
  if (wantNative && opts.force !== 'zxing-wasm') return new NativePool(size);
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('this browser cannot run the decoder pool');
  }
  return new WorkerPool(size);
}
