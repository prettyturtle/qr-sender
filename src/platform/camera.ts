/**
 * Camera capture and the scan loop.
 *
 * Receiving is throughput-bound on distinct frames decoded per second, and three
 * things decide that number:
 *
 *  - **Parallel decoding.** Decodes run several at a time through `DecodePool`,
 *    on worker threads where the decoder is wasm. Decoding serially on the main
 *    thread capped the whole app at one-over-decode-latency, which is where the
 *    old ~8fps ceiling came from.
 *  - **One capture per camera frame.** `requestVideoFrameCallback` fires exactly
 *    when a new frame exists, so nothing is decoded twice and nothing is missed.
 *    `requestAnimationFrame` is tied to the display instead and does both.
 *  - **Cropping on the compositor.** `createImageBitmap` crops the centre square
 *    off-thread and transfers without copying, so the main thread never touches
 *    pixel data.
 */

import { createDecodePool, decodeConcurrency, type DecodePool } from './decodePool.js';
import type { DetectorKind } from './detect.js';

export interface ScannerStats {
  /** Frames the decoder was run on, per second. */
  attemptFps: number;
  /** Frames that yielded a QR, per second — the number the coaching UI reacts to. */
  decodeFps: number;
  detector: DetectorKind;
  resolution: string;
  /** Edge length currently handed to the decoder. */
  roi: number;
  /** How many decodes may run at once. */
  concurrency: number;
  /** Mean decoder latency in milliseconds. */
  latencyMs: number;
}

/**
 * Default region handed to the decoder: a centre square crop.
 *
 * A square crop discards the parts of a landscape frame a square symbol never
 * occupies, which both speeds up the search and keeps every pixel spent on the
 * symbol itself.
 */
const ROI_FAST = 800;

/**
 * Escalated region, used when nothing is decoding.
 *
 * A webcam reading a *phone* screen is resolution-starved rather than
 * CPU-starved: a 125-module symbol on a 6cm screen is about 0.5mm per module, so
 * downscaling costs roughly a quarter of the working distance at exactly the
 * moment it is scarcest.
 */
const ROI_HIGH = 1440;

/** How long to persist with one region size before trying the other. */
const ROI_SWITCH_MS = 4000;

export interface ScannerOptions {
  video: HTMLVideoElement;
  onText: (text: string) => void;
  onStats?: (stats: ScannerStats) => void;
  onError?: (err: unknown) => void;
  force?: DetectorKind;
  /** Overrides the adaptive region sizing. Used by benchmarks, not by the app. */
  roiSize?: number;
  /** Overrides the pool size. Used by benchmarks. */
  concurrency?: number;
}

export class CameraPermissionError extends Error {
  constructor(public readonly reason: 'denied' | 'notfound' | 'insecure' | 'unknown') {
    super(`camera-${reason}`);
    this.name = 'CameraPermissionError';
  }
}

function classifyMediaError(err: unknown): CameraPermissionError {
  if (!globalThis.isSecureContext) return new CameraPermissionError('insecure');
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return new CameraPermissionError('denied');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return new CameraPermissionError('notfound');
  return new CameraPermissionError('unknown');
}

/**
 * `requestVideoFrameCallback` is in the DOM lib but not in every browser, so it
 * is reached through an optional shape rather than assumed present.
 */
interface FrameCallbackCapable {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

export class Scanner {
  private stream: MediaStream | null = null;
  private pool: DecodePool | null = null;
  private handle = 0;
  private usingFrameCallback = false;
  private stopped = false;
  /** Bitmap creation is async too, so it counts against the pool budget. */
  private grabbing = 0;

  private attempts = 0;
  private decodes = 0;
  private windowStart = 0;
  private lastDecodeAt = 0;
  private highRoi = false;
  private stats: ScannerStats = {
    attemptFps: 0,
    decodeFps: 0,
    detector: 'zxing-wasm',
    resolution: '',
    roi: ROI_FAST,
    concurrency: 1,
    latencyMs: 0,
  };

  private constructor(private readonly opts: ScannerOptions) {}

  static async start(opts: ScannerOptions): Promise<Scanner> {
    const scanner = new Scanner(opts);
    await scanner.init();
    return scanner;
  }

  get detectorKind(): DetectorKind {
    return this.pool?.kind ?? 'zxing-wasm';
  }

  private async init(): Promise<void> {
    if (!globalThis.isSecureContext) throw new CameraPermissionError('insecure');
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraPermissionError('notfound');

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // 60 where the hardware offers it: every camera frame is a chance to
          // decode a distinct symbol.
          frameRate: { ideal: 60 },
        },
        audio: false,
      });
    } catch (err) {
      throw classifyMediaError(err);
    }

    const video = this.opts.video;
    video.srcObject = this.stream;
    video.setAttribute('playsinline', 'true');
    video.muted = true;
    await video.play();

    this.pool = await createDecodePool({
      ...(this.opts.force !== undefined ? { force: this.opts.force } : {}),
      size: this.opts.concurrency ?? decodeConcurrency(),
    });
    this.stats.detector = this.pool.kind;
    this.stats.concurrency = this.pool.concurrency;

    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    this.stats.resolution = settings ? `${settings.width ?? '?'}x${settings.height ?? '?'}` : '';

    this.windowStart = performance.now();
    this.lastDecodeAt = Date.now();
    this.schedule();
  }

  /** One callback per camera frame where the browser offers it, per repaint otherwise. */
  private schedule(): void {
    if (this.stopped) return;
    const video = this.opts.video as HTMLVideoElement & FrameCallbackCapable;
    if (typeof video.requestVideoFrameCallback === 'function') {
      this.usingFrameCallback = true;
      this.handle = video.requestVideoFrameCallback(this.tick);
    } else {
      this.usingFrameCallback = false;
      this.handle = requestAnimationFrame(this.tick);
    }
  }

  private tick = (): void => {
    if (this.stopped) return;
    this.schedule();

    const pool = this.pool;
    const video = this.opts.video;
    if (pool === null) return;
    if (video.readyState < 2 || video.videoWidth === 0) return;
    // Every slot busy: the next camera frame is more useful than a queued one.
    if (pool.inFlight + this.grabbing >= pool.concurrency) return;

    const side = Math.min(video.videoWidth, video.videoHeight);
    const sx = (video.videoWidth - side) / 2;
    const sy = (video.videoHeight - side) / 2;
    const roi = this.targetRoi();

    this.grabbing++;
    void createImageBitmap(video, sx, sy, side, side)
      .then(async (bitmap) => {
        this.grabbing--;
        if (this.stopped) {
          bitmap.close();
          return;
        }
        const texts = await pool.decode(bitmap, roi);
        this.attempts++;
        if (texts.length > 0) {
          this.decodes++;
          this.lastDecodeAt = Date.now();
          for (const t of texts) this.opts.onText(t);
        }
        this.report();
      })
      .catch((err: unknown) => {
        this.grabbing--;
        this.opts.onError?.(err);
      });
  };

  private report(): void {
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < 1000) return;

    // Nothing is decoding: alternate between the two region sizes rather than
    // guessing which resource is short.
    if (Date.now() - this.lastDecodeAt >= ROI_SWITCH_MS) {
      this.highRoi = !this.highRoi;
      this.lastDecodeAt = Date.now();
    }

    this.stats = {
      ...this.stats,
      attemptFps: (this.attempts * 1000) / elapsed,
      decodeFps: (this.decodes * 1000) / elapsed,
      roi: this.targetRoi(),
      latencyMs: this.pool?.latencyMs ?? 0,
    };
    this.attempts = 0;
    this.decodes = 0;
    this.windowStart = now;
    this.opts.onStats?.(this.stats);
  }

  private targetRoi(): number {
    if (this.opts.roiSize !== undefined) return this.opts.roiSize;
    return this.highRoi ? ROI_HIGH : ROI_FAST;
  }

  stop(): void {
    this.stopped = true;
    const video = this.opts.video as HTMLVideoElement & FrameCallbackCapable;
    if (this.usingFrameCallback) video.cancelVideoFrameCallback?.(this.handle);
    else cancelAnimationFrame(this.handle);
    this.pool?.close();
    this.pool = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.opts.video.srcObject = null;
  }
}
