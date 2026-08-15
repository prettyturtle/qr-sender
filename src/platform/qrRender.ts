/**
 * QR rendering. Alphanumeric mode is forced explicitly rather than left to the
 * encoder's auto-selection, so a payload that happens to look numeric cannot
 * silently switch modes and change the frame capacity mid-stream.
 *
 * Styling is allowed, within limits that come from how decoders actually work:
 *
 *  - **Rounded modules are safe.** A decoder samples the *centre* of each module,
 *    so trimming corners costs nothing as long as the radius stays well under
 *    half a module. Only corners with no dark neighbour are rounded, which is
 *    what produces the connected, liquid look rather than a field of dots.
 *  - **Colour is only safe if the luminance gap survives.** Cameras read
 *    brightness, not hue, so the constraint is contrast ratio — and inverting
 *    (light modules on a dark field) breaks decoders that do not try inversion.
 *    Both are enforced here rather than left to the palette.
 */

import QRCode from 'qrcode';
import type { QrProfile } from '../core/params.js';

/** Quiet zone in modules, per the QR spec. Dropping below 4 costs detection rate. */
const QUIET_ZONE = 4;

/** Corner radius as a fraction of one module. Well below the 0.5 that would erode centres. */
const CORNER_RADIUS = 0.3;

/** Minimum contrast ratio between module and background. WCAG AAA text is 7:1. */
export const MIN_CONTRAST = 7;

export interface RenderedQr {
  modules: number;
  data: Uint8Array;
}

export function buildQr(text: string, profile: QrProfile): RenderedQr {
  const sym = QRCode.create([{ data: text, mode: 'alphanumeric' }], {
    version: profile.version,
    errorCorrectionLevel: profile.ecc,
  });
  return { modules: sym.modules.size, data: sym.modules.data as unknown as Uint8Array };
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (m === null) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function relativeLuminance(hex: string): number | null {
  const rgb = parseHex(hex);
  if (rgb === null) return null;
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  if (la === null || lb === null) return 0;
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Returns the pair actually safe to draw with. Falls back to black on white when
 * the requested colours are too close, or when the dark colour is not the darker
 * of the two — an inverted symbol is unreadable on decoders that do not retry.
 */
export function safeColours(dark: string, light: string): { dark: string; light: string } {
  const ld = relativeLuminance(dark);
  const ll = relativeLuminance(light);
  if (ld === null || ll === null) return { dark: '#000000', light: '#ffffff' };
  if (ld >= ll) return { dark: '#000000', light: '#ffffff' };
  if (contrastRatio(dark, light) < MIN_CONTRAST) return { dark: '#000000', light: '#ffffff' };
  return { dark, light };
}

let roundRectSupport: boolean | null = null;

function supportsRoundRect(): boolean {
  if (roundRectSupport === null) {
    roundRectSupport = typeof Path2D !== 'undefined' && typeof Path2D.prototype.roundRect === 'function';
  }
  return roundRectSupport;
}

export interface DrawOptions {
  /** CSS pixels available for the whole symbol including its quiet zone. */
  cssSize: number;
  devicePixelRatio?: number;
  dark?: string;
  light?: string;
  /** Rounded modules. Off falls back to the fastest possible path. */
  rounded?: boolean;
}

/**
 * Draw into a canvas at an integer module size. Fractional module sizes produce
 * ragged edges under camera downsampling, which measurably hurts decode rate, so
 * the symbol is snapped down and centred rather than stretched to fill.
 */
export function drawQr(canvas: HTMLCanvasElement, qr: RenderedQr, opts: DrawOptions): void {
  const dpr = opts.devicePixelRatio ?? (globalThis.devicePixelRatio || 1);
  const total = qr.modules + QUIET_ZONE * 2;
  const devicePx = Math.floor(opts.cssSize * dpr);
  const scale = Math.max(1, Math.floor(devicePx / total));
  const side = scale * total;

  if (canvas.width !== side || canvas.height !== side) {
    canvas.width = side;
    canvas.height = side;
  }
  canvas.style.width = `${side / dpr}px`;
  canvas.style.height = `${side / dpr}px`;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) throw new Error('2d canvas context unavailable');

  const colours = safeColours(opts.dark ?? '#000000', opts.light ?? '#ffffff');

  ctx.fillStyle = colours.light;
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = colours.dark;

  const off = QUIET_ZONE * scale;
  const n = qr.modules;
  const data = qr.data;

  // Rounding needs at least a few pixels per module to read as a curve rather
  // than as noise, and it costs a path op per module instead of one per run.
  if (opts.rounded === true && supportsRoundRect() && scale >= 4) {
    const r = Math.max(1, Math.round(scale * CORNER_RADIUS));
    const path = new Path2D();
    const dark = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < n && y < n && data[y * n + x] !== 0;

    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (data[y * n + x] === 0) continue;
        const up = dark(x, y - 1);
        const down = dark(x, y + 1);
        const left = dark(x - 1, y);
        const right = dark(x + 1, y);
        // Only outward corners round, so adjacent modules stay fused.
        path.roundRect(off + x * scale, off + y * scale, scale, scale, [
          !up && !left ? r : 0,
          !up && !right ? r : 0,
          !down && !right ? r : 0,
          !down && !left ? r : 0,
        ]);
      }
    }
    ctx.fill(path);
    return;
  }

  for (let y = 0; y < n; y++) {
    const rowBase = y * n;
    let x = 0;
    while (x < n) {
      if (data[rowBase + x] === 0) {
        x++;
        continue;
      }
      // Coalesce horizontal runs into one fillRect — roughly 3x fewer draw calls.
      let run = 1;
      while (x + run < n && data[rowBase + x + run] !== 0) run++;
      ctx.fillRect(off + x * scale, off + y * scale, run * scale, scale);
      x += run;
    }
  }
}
