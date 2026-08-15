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

import {
  createDecodePool,
  decodeConcurrency,
  type DecodePool,
  type SymbolBox,
} from './decodePool.js';
import type { DetectorKind } from './detect.js';
import { createSharpnessMeter, type SharpnessMeter } from './sharpness.js';

export interface ScannerStats {
  /** Frames the decoder was run on, per second. */
  attemptFps: number;
  /** Frames that yielded a QR, per second — the number the coaching UI reacts to. */
  decodeFps: number;
  detector: DetectorKind;
  resolution: string;
  /** Edge length currently handed to the decoder. */
  roi: number;
  /** Fraction of the frame's short side the crop currently covers; 1 means no tracking. */
  cropFraction: number;
  /** Current ISP zoom, or 0 where the camera does not offer it. */
  zoom: number;
  /** Focus quality of the tracked region, 0..1, or -1 before the first reading. */
  sharpness: number;
  /** True where the camera exposes no continuous autofocus — most PC webcams. */
  fixedFocus: boolean;
  /** Frame rate the camera actually settled on, which caps safe playback rates. */
  cameraFps: number;
  /** How many decodes may run at once. */
  concurrency: number;
  /** Mean decoder latency in milliseconds. */
  latencyMs: number;
}

/**
 * Region handed to the decoder: the centre square, at native resolution.
 *
 * This used to downscale to 800px, which was sized for V25 symbols. V40 has 185
 * modules including the quiet zone, and a symbol filling ~70% of a 1080 frame
 * then lands at 3.0 pixels per module — exactly the floor this project sets for
 * itself, with no margin for imperfect framing. Raising the symbol version
 * silently invalidated the crop constant, and the escalation below could not
 * rescue it because partial success keeps resetting the idle timer.
 *
 * At native resolution the same symbol gets 5.8 px/module and stays readable
 * down to about half the frame. Eight parallel workers absorb the extra pixels.
 */
const ROI_NATIVE = 1440;

/** Downscaled fallback, tried only when nothing decodes — cheaper, blurrier. */
const ROI_FAST = 960;

/** How long to persist with one region size before trying the other. */
const ROI_SWITCH_MS = 4000;

/**
 * Padding around a tracked symbol, as a fraction of its size.
 *
 * Cropping to the symbol is the single cheapest way to buy pixels per module: a
 * user who frames it at half the width is throwing away three quarters of the
 * sensor's budget for it. The margin has to absorb hand movement between one
 * frame and the next, so it is generous rather than tight.
 */
const TRACK_MARGIN = 0.35;

/** Give up on a track after this many consecutive misses and re-acquire wide. */
const TRACK_MISS_LIMIT = 8;

/** Never crop below this, or a momentary bad box would lock the scanner onto noise. */
const MIN_TRACK_FRACTION = 0.25;

/**
 * Fraction of the frame the symbol should occupy before zoom stops chasing it.
 *
 * Cropping in software cannot create pixels the sensor never captured — it only
 * shrinks the decoder's search area. Optical/ISP zoom is different: the sensor
 * is cropped *before* the pipeline scales to the output resolution, so a symbol
 * that fills more of the frame genuinely gets more pixels per module. That is
 * the only lever on this side that raises the sampling rate itself.
 */
const ZOOM_TARGET_FRACTION = 0.68;

/** Do not react to noise; only correct when the symbol is meaningfully off target. */
const ZOOM_DEADBAND = 0.12;

/** Seconds between zoom corrections, so autofocus is not thrashed. */
const ZOOM_INTERVAL_MS = 1200;

/**
 * Measure focus every Nth frame.
 *
 * Focus changes at the speed of a hand, not a frame, so measuring every frame
 * would spend real time to track something that cannot move that fast.
 */
const SHARPNESS_EVERY = 6;

export interface ScannerOptions {
  video: HTMLVideoElement;
  /**
   * Returns whether the text belonged to the transfer being received.
   *
   * The answer steers symbol tracking. A sender's screen also shows a small
   * static onboarding QR beside the animated one; without this the tracker
   * would happily lock onto that and never see the data symbol again.
   */
  onText: (text: string) => boolean;
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
  private degraded = false;
  /** Last known symbol location, in video pixels. */
  private track: SymbolBox | null = null;
  private trackMisses = 0;
  private lastCropFraction = 1;
  private zoomTrack: MediaStreamTrack | null = null;
  private zoomRange: { min: number; max: number; step: number } | null = null;
  private zoomValue = 1;
  private lastZoomAt = 0;
  private meter: SharpnessMeter | null = null;
  private frameCount = 0;
  private sharpness = -1;
  private stats: ScannerStats = {
    attemptFps: 0,
    decodeFps: 0,
    detector: 'zxing-wasm',
    resolution: '',
    roi: ROI_NATIVE,
    cropFraction: 1,
    zoom: 0,
    sharpness: -1,
    fixedFocus: false,
    cameraFps: 0,
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

    const track = this.stream.getVideoTracks()[0] ?? null;
    this.zoomTrack = track;
    this.readZoomRange(track);
    this.requestAutofocus(track);
    this.meter = createSharpnessMeter();
    const settings = track?.getSettings();
    this.stats.resolution = settings ? `${settings.width ?? '?'}x${settings.height ?? '?'}` : '';
    // The playback rate a sender can safely use is capped by this: each symbol
    // has to survive at least two camera frames.
    this.stats.cameraFps = Math.round(settings?.frameRate ?? 0);

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

    const crop = this.cropRegion(video);
    const { sx, sy, side } = crop;
    if (side < 1) return;

    // Measured on the crop, so it reports the symbol's focus rather than the
    // scene's: a sharp desk behind a soft phone must not read as "in focus".
    if (this.meter !== null && ++this.frameCount % SHARPNESS_EVERY === 0) {
      const score = this.meter.measure(video, sx, sy, side);
      if (score >= 0) {
        // Lightly smoothed: an unsmoothed readout jitters too much to aim by.
        this.sharpness = this.sharpness < 0 ? score : this.sharpness + (score - this.sharpness) * 0.3;
      }
    }
    const roi = this.targetRoi();

    this.grabbing++;
    // Resize here rather than in the worker: the compositor does it, and it is
    // the only place that reaches *both* backends — the native detector takes
    // the bitmap as-is and would otherwise search a full-resolution frame.
    this.lastCropFraction = side / Math.min(video.videoWidth, video.videoHeight);
    const target = Math.min(roi, side);
    const resize: ImageBitmapOptions =
      target < side ? { resizeWidth: target, resizeHeight: target, resizeQuality: 'medium' } : {};

    void createImageBitmap(video, sx, sy, side, side, resize)
      .then(async (bitmap) => {
        this.grabbing--;
        if (this.stopped) {
          bitmap.close();
          return;
        }
        const { texts, box } = await pool.decode(bitmap);
        this.attempts++;
        let useful = false;
        if (texts.length > 0) {
          this.decodes++;
          this.lastDecodeAt = Date.now();
          for (const t of texts) useful = this.opts.onText(t) || useful;
        }
        if (useful) {
          this.updateTrack(crop, target, box);
        } else if (++this.trackMisses >= TRACK_MISS_LIMIT) {
          // Lost it: widen back out rather than hunting inside a stale window.
          this.track = null;
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
      this.degraded = !this.degraded;
      this.lastDecodeAt = Date.now();
    }

    this.stats = {
      ...this.stats,
      attemptFps: (this.attempts * 1000) / elapsed,
      decodeFps: (this.decodes * 1000) / elapsed,
      roi: this.targetRoi(),
      cropFraction: this.lastCropFraction,
      zoom: this.zoomRange === null ? 0 : this.zoomValue,
      sharpness: this.sharpness,
      latencyMs: this.pool?.latencyMs ?? 0,
    };
    this.attempts = 0;
    this.decodes = 0;
    this.windowStart = now;
    this.opts.onStats?.(this.stats);
  }

  /**
   * Where to crop this frame: the tracked symbol if one is known, otherwise the
   * centre square.
   */
  private cropRegion(video: HTMLVideoElement): { sx: number; sy: number; side: number } {
    const full = Math.min(video.videoWidth, video.videoHeight);
    const track = this.track;
    if (track === null) {
      return {
        sx: Math.round((video.videoWidth - full) / 2),
        sy: Math.round((video.videoHeight - full) / 2),
        side: full,
      };
    }
    const padded = track.size * (1 + TRACK_MARGIN * 2);
    const side = Math.min(
      Math.max(padded, full * MIN_TRACK_FRACTION),
      video.videoWidth,
      video.videoHeight,
    );
    const cx = track.x + track.size / 2;
    const cy = track.y + track.size / 2;
    const rounded = Math.round(side);
    return {
      sx: Math.round(Math.max(0, Math.min(video.videoWidth - rounded, cx - rounded / 2))),
      sy: Math.round(Math.max(0, Math.min(video.videoHeight - rounded, cy - rounded / 2))),
      side: rounded,
    };
  }

  /** Map the decoder's box back into video coordinates and keep it for next time. */
  private updateTrack(
    crop: { sx: number; sy: number; side: number },
    bitmapSide: number,
    box: SymbolBox | null,
  ): void {
    this.trackMisses = 0;
    if (box === null || box.size <= 0) return;
    const factor = crop.side / bitmapSide;
    this.track = {
      x: crop.sx + box.x * factor,
      y: crop.sy + box.y * factor,
      size: box.size * factor,
    };
    const frameShort = Math.min(this.opts.video.videoWidth, this.opts.video.videoHeight);
    if (frameShort > 0) this.adjustZoom(this.track.size / frameShort);
  }

  /**
   * Ask for continuous autofocus where the camera has any.
   *
   * Phones default to it already; the call matters for the cameras that support
   * focus but start in a single-shot or manual mode. Where the capability is
   * absent the lens is fixed and no amount of asking will move it — that is the
   * case the sharpness meter exists for.
   */
  private requestAutofocus(track: MediaStreamTrack | null): void {
    if (track === null || typeof track.getCapabilities !== 'function') return;
    try {
      const caps = track.getCapabilities() as MediaTrackCapabilities & { focusMode?: string[] };
      const modes = caps.focusMode ?? [];
      this.stats = { ...this.stats, fixedFocus: !modes.includes('continuous') };
      if (!modes.includes('continuous')) return;
      void track
        .applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
        .catch(() => {
          /* refused; continuous was already the default or is unavailable */
        });
    } catch {
      /* capability probing is best-effort */
    }
  }

  /** Zoom is an optional capability; absence is normal and not an error. */
  private readZoomRange(track: MediaStreamTrack | null): void {
    if (track === null || typeof track.getCapabilities !== 'function') return;
    try {
      const caps = track.getCapabilities() as MediaTrackCapabilities & {
        zoom?: { min: number; max: number; step: number };
      };
      const zoom = caps.zoom;
      if (zoom === undefined || zoom.max <= zoom.min) return;
      this.zoomRange = { min: zoom.min, max: zoom.max, step: zoom.step || 0.1 };
      this.zoomValue = zoom.min;
    } catch {
      /* capability probing is best-effort */
    }
  }

  /**
   * Nudge the ISP zoom so the symbol fills a useful share of the frame.
   *
   * Runs on a slow cadence and inside a deadband: zoom changes re-trigger
   * autofocus, and a scanner that hunts is worse than one that is slightly wide.
   */
  private adjustZoom(symbolFraction: number): void {
    const range = this.zoomRange;
    const track = this.zoomTrack;
    if (range === null || track === null || symbolFraction <= 0) return;

    const now = Date.now();
    if (now - this.lastZoomAt < ZOOM_INTERVAL_MS) return;
    if (Math.abs(symbolFraction - ZOOM_TARGET_FRACTION) < ZOOM_DEADBAND) return;

    const wanted = this.zoomValue * (ZOOM_TARGET_FRACTION / symbolFraction);
    const clamped = Math.min(range.max, Math.max(range.min, wanted));
    if (Math.abs(clamped - this.zoomValue) < range.step) return;

    this.lastZoomAt = now;
    this.zoomValue = clamped;
    void track
      .applyConstraints({ advanced: [{ zoom: clamped } as MediaTrackConstraintSet] })
      .catch(() => {
        // Refused mid-stream: stop trying rather than retrying every second.
        this.zoomRange = null;
      });
  }

  private targetRoi(): number {
    if (this.opts.roiSize !== undefined) return this.opts.roiSize;
    return this.degraded ? ROI_FAST : ROI_NATIVE;
  }

  stop(): void {
    this.stopped = true;
    const video = this.opts.video as HTMLVideoElement & FrameCallbackCapable;
    if (this.usingFrameCallback) video.cancelVideoFrameCallback?.(this.handle);
    else cancelAnimationFrame(this.handle);
    this.pool?.close();
    this.pool = null;
    this.zoomTrack = null;
    this.zoomRange = null;
    this.meter?.close();
    this.meter = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.opts.video.srcObject = null;
  }
}
