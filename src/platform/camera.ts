/**
 * Camera capture and the scan loop.
 *
 * Two things here matter for decode rate more than anything else in the app:
 *
 *  - **Centre-square ROI + downscale.** A 1080p full-frame readback into wasm is
 *    several times slower than an 800px centre crop, and the QR only ever
 *    occupies the middle of the viewfinder anyway.
 *  - **No overlapping decodes.** Queuing a second decode before the first
 *    returns just builds latency; the next camera frame is always more useful
 *    than a stale one.
 */

import { createDetector, type DetectorKind, type FrameDetector } from './detect.js';

export interface ScannerStats {
  /** Frames the detector was run on, per second. */
  attemptFps: number;
  /** Frames that yielded at least one QR, per second — the number the coaching UI reacts to. */
  decodeFps: number;
  detector: DetectorKind;
  resolution: string;
  /** Edge length currently handed to the detector — see the ROI note below. */
  roi: number;
}

/**
 * Longest edge of the region handed to the detector.
 *
 * This used to be a centre *square* crop, which is wrong now that a sender may
 * display several symbols side by side across a landscape screen — a square crop
 * would simply cut the outer ones off. The frame is scaled whole instead, which
 * costs some pixels per module but is the only way to see everything on screen.
 */
const ROI_FAST = 1280;

/**
 * Escalated region, used when nothing is decoding.
 *
 * The opposite case — a webcam reading a *phone* screen — is resolution-starved
 * rather than CPU-starved. A 125-module symbol on a 6cm phone screen is about
 * 0.5mm per module, so downscaling 1080p to 800 costs roughly a quarter of the
 * working distance at exactly the moment it is scarcest. Desktop targets 6fps
 * and has the headroom, so when reads stop we trade speed for pixels.
 */
const ROI_HIGH = 1920;

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

export class Scanner {
  private stream: MediaStream | null = null;
  private detector: FrameDetector | null = null;
  private raf = 0;
  private stopped = false;
  private busy = false;
  private work = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D | null = null;

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
  };

  private constructor(private readonly opts: ScannerOptions) {}

  static async start(opts: ScannerOptions): Promise<Scanner> {
    const scanner = new Scanner(opts);
    await scanner.init();
    return scanner;
  }

  get detectorKind(): DetectorKind {
    return this.detector?.kind ?? 'zxing-wasm';
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
          // 60 where the hardware offers it: the two-camera-frame hold is what
          // caps playback speed, so a faster camera directly raises the ceiling.
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

    this.detector = await createDetector(this.opts.force ? { force: this.opts.force } : {});
    this.stats.detector = this.detector.kind;

    const track = this.stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    this.stats.resolution = settings ? `${settings.width ?? '?'}x${settings.height ?? '?'}` : '';

    this.ctx = this.work.getContext('2d', { alpha: false, willReadFrequently: true });
    this.windowStart = performance.now();
    this.lastDecodeAt = Date.now();
    this.loop();
  }

  private loop = (): void => {
    if (this.stopped) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.busy) return;

    const video = this.opts.video;
    if (video.readyState < 2 || video.videoWidth === 0) return;

    this.busy = true;
    void this.tick().finally(() => {
      this.busy = false;
    });
  };

  private async tick(): Promise<void> {
    const detector = this.detector;
    if (detector === null) return;

    try {
      const texts = await detector.detect(this.drawCrop(), () => this.readBack());
      this.attempts++;
      if (texts.length > 0) {
        this.decodes++;
        this.lastDecodeAt = Date.now();
        for (const t of texts) this.opts.onText(t);
      }
    } catch (err) {
      this.opts.onError?.(err);
    }

    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      // Nothing is decoding: alternate between the two region sizes rather than
      // guessing which resource is short. One of them is usually right, and
      // trying both beats picking wrong and never recovering.
      if (Date.now() - this.lastDecodeAt >= ROI_SWITCH_MS) {
        this.highRoi = !this.highRoi;
        this.lastDecodeAt = Date.now();
      }
      this.stats = {
        ...this.stats,
        attemptFps: (this.attempts * 1000) / elapsed,
        decodeFps: (this.decodes * 1000) / elapsed,
        roi: this.targetRoi(),
      };
      this.attempts = 0;
      this.decodes = 0;
      this.windowStart = now;
      this.opts.onStats?.(this.stats);
    }
  }

  private targetRoi(): number {
    if (this.opts.roiSize !== undefined) return this.opts.roiSize;
    return this.highRoi ? ROI_HIGH : ROI_FAST;
  }

  /** Whole frame, scaled down to the target longest edge with aspect preserved. */
  private drawCrop(): HTMLCanvasElement {
    const video = this.opts.video;
    const target = this.targetRoi();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const factor = Math.min(1, target / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * factor));
    const h = Math.max(1, Math.round(vh * factor));

    if (this.work.width !== w || this.work.height !== h) {
      this.work.width = w;
      this.work.height = h;
    }
    this.ctx!.drawImage(video, 0, 0, vw, vh, 0, 0, w, h);
    return this.work;
  }

  /** Only the wasm backend needs the pixels; the native one reads the canvas directly. */
  private readBack(): ImageData {
    return this.ctx!.getImageData(0, 0, this.work.width, this.work.height);
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.detector?.close();
    this.detector = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.opts.video.srcObject = null;
  }
}
