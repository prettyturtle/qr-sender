/**
 * Keeps a queue of painted QR frames ready ahead of the playback clock.
 *
 * The display loop then does nothing but `drawImage`, so the frame rate stops
 * being a function of how long a V40 symbol takes to encode and paint. That is
 * what makes rates above roughly 20fps deliverable at all: on a phone a single
 * V40 encode can eat most of a 33ms budget on its own.
 *
 * Frames may be produced out of order and it does not matter — each one carries
 * its own segment and symbol index, so the receiver treats them as an unordered
 * set. Ordering machinery would be pure cost here.
 */

import type { QrProfile } from '../core/params.js';
import { buildQr, moduleScale, paintQr, symbolSide } from './qrRender.js';
import type { RenderRequest, RenderResponse } from './renderWorker.js';

export interface FramePainter {
  /** Take the next ready frame, or null if none is buffered yet. */
  take(): ImageBitmap | null;
  /** Frames waiting to be shown. */
  readonly ready: number;
  /** Mean paint time in milliseconds. */
  readonly paintMs: number;
  resize(scale: number): void;
  restyle(dark: string, rounded: boolean): void;
  close(): void;
}

export interface PainterOptions {
  /** Produces the base44 text of the next frame. */
  nextText: () => string;
  profile: QrProfile;
  /** Device pixels per module. */
  scale: number;
  dark: string;
  rounded: boolean;
  /** How many frames to keep ahead. Two is enough to absorb a slow paint. */
  lookahead?: number;
  workers?: number;
}

const DEFAULT_LOOKAHEAD = 3;

function poolSize(): number {
  const cores = navigator.hardwareConcurrency || 4;
  // The sender only has to stay ahead of the display clock, so this is smaller
  // than the decode pool — spare cores there are worth more.
  return Math.max(1, Math.min(3, cores - 1));
}

class WorkerPainter implements FramePainter {
  private readonly workers: Worker[] = [];
  private readonly queue: ImageBitmap[] = [];
  private readonly idle: Worker[] = [];
  private paintTotal = 0;
  private paintCount = 0;
  private nextId = 1;
  private closed = false;

  constructor(private opts: PainterOptions & { lookahead: number }) {
    for (let i = 0; i < (opts.workers ?? poolSize()); i++) {
      const worker = new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<RenderResponse>) => {
        const { bitmap, ms } = event.data;
        this.paintTotal += ms;
        this.paintCount++;
        if (this.closed || bitmap === null) bitmap?.close();
        else this.queue.push(bitmap);
        this.idle.push(worker);
        this.fill();
      };
      worker.onerror = () => this.idle.push(worker);
      this.workers.push(worker);
      this.idle.push(worker);
    }
    this.fill();
  }

  get ready(): number {
    return this.queue.length;
  }

  get paintMs(): number {
    return this.paintCount === 0 ? 0 : this.paintTotal / this.paintCount;
  }

  private fill(): void {
    while (!this.closed && this.queue.length < this.opts.lookahead && this.idle.length > 0) {
      const worker = this.idle.pop()!;
      const request: RenderRequest = {
        id: this.nextId++,
        text: this.opts.nextText(),
        profile: this.opts.profile,
        scale: this.opts.scale,
        dark: this.opts.dark,
        rounded: this.opts.rounded,
      };
      worker.postMessage(request);
    }
  }

  take(): ImageBitmap | null {
    const bitmap = this.queue.shift() ?? null;
    this.fill();
    return bitmap;
  }

  resize(scale: number): void {
    if (scale === this.opts.scale) return;
    this.opts = { ...this.opts, scale };
    this.drop();
  }

  restyle(dark: string, rounded: boolean): void {
    if (dark === this.opts.dark && rounded === this.opts.rounded) return;
    this.opts = { ...this.opts, dark, rounded };
    this.drop();
  }

  /** Buffered frames were painted with the old settings; they cannot be shown. */
  private drop(): void {
    for (const b of this.queue) b.close();
    this.queue.length = 0;
    this.fill();
  }

  close(): void {
    this.closed = true;
    for (const w of this.workers) w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    for (const b of this.queue) b.close();
    this.queue.length = 0;
  }
}

/** Falls back to painting inline where workers or OffscreenCanvas are missing. */
class InlinePainter implements FramePainter {
  private surface: OffscreenCanvas | HTMLCanvasElement | null = null;
  private paintTotal = 0;
  private paintCount = 0;

  constructor(private opts: PainterOptions) {}

  get ready(): number {
    return 1;
  }

  get paintMs(): number {
    return this.paintCount === 0 ? 0 : this.paintTotal / this.paintCount;
  }

  take(): ImageBitmap | null {
    const started = performance.now();
    try {
      const qr = buildQr(this.opts.nextText(), this.opts.profile);
      const side = symbolSide(qr.modules, this.opts.scale);
      if (typeof OffscreenCanvas === 'undefined') return null;
      if (this.surface === null || this.surface.width !== side) {
        this.surface = new OffscreenCanvas(side, side);
      }
      const ctx = (this.surface as OffscreenCanvas).getContext('2d', { alpha: false });
      if (ctx === null) return null;
      paintQr(ctx, qr, { scale: this.opts.scale, dark: this.opts.dark, rounded: this.opts.rounded });
      return (this.surface as OffscreenCanvas).transferToImageBitmap();
    } catch {
      return null;
    } finally {
      this.paintTotal += performance.now() - started;
      this.paintCount++;
    }
  }

  resize(scale: number): void {
    this.opts = { ...this.opts, scale };
    this.surface = null;
  }

  restyle(dark: string, rounded: boolean): void {
    this.opts = { ...this.opts, dark, rounded };
  }

  close(): void {
    this.surface = null;
  }
}

export function createFramePainter(opts: PainterOptions): FramePainter {
  const lookahead = opts.lookahead ?? DEFAULT_LOOKAHEAD;
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    return new WorkerPainter({ ...opts, lookahead });
  }
  return new InlinePainter(opts);
}

export { moduleScale, symbolSide };
