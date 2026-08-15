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

/**
 * Corner radius as a fraction of one module. At 0.5 an isolated module becomes a
 * full circle, which is the look people mean by "rounded QR" — and it is still
 * safe, because a decoder samples the module *centre*, which a circle covers
 * completely. Only corners with no dark neighbour are rounded, so runs stay
 * fused and the symbol reads as connected strokes rather than a field of dots.
 */
const CORNER_RADIUS = 0.5;

/** Finder-pattern geometry, fixed by the QR spec: 7x7 ring, 5x5 gap, 3x3 pupil. */
const FINDER = 7;

/** Below this a curve is indistinguishable from an aliasing artefact. */
const MIN_ROUNDED_SCALE = 3;

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

/** Either canvas flavour: the sender paints on the main thread and in workers. */
export type AnyCanvasContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface RoundedContext {
  scale: number;
  off: number;
  dark: string;
  light: string;
}

/** Top-left corner of each finder pattern, in module coordinates. */
function finderOrigins(size: number): Array<[number, number]> {
  return [
    [0, 0],
    [size - FINDER, 0],
    [0, size - FINDER],
  ];
}

/**
 * Styled rendering.
 *
 * The finder patterns are drawn as shapes rather than as modules. They are the
 * single most recognisable part of a QR code and, at 7x7, the only feature large
 * enough to still read as *designed* on a dense symbol — at V40 a data module is
 * a handful of pixels, but an eye is fifty.
 *
 * This stays decodable because detection works on the run-length ratio
 * 1:1:3:1:1 along a scan line through the eye's centre. A rounded ring and a
 * circular pupil preserve those proportions exactly on the centre line; the
 * corners a decoder never samples are the only thing that changes.
 */
function drawRounded(ctx: AnyCanvasContext, qr: RenderedQr, c: RoundedContext): void {
  const { scale, off } = c;
  const n = qr.modules;
  const data = qr.data;
  const r = Math.max(1, Math.round(scale * CORNER_RADIUS));

  const inFinder = (x: number, y: number): boolean =>
    finderOrigins(n).some(([ox, oy]) => x >= ox && x < ox + FINDER && y >= oy && y < oy + FINDER);

  const dark = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < n && y < n && data[y * n + x] !== 0;

  const modules = new Path2D();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (data[y * n + x] === 0 || inFinder(x, y)) continue;
      // Only outward corners round, so adjacent modules stay fused.
      modules.roundRect(off + x * scale, off + y * scale, scale, scale, [
        !dark(x, y - 1) && !dark(x - 1, y) ? r : 0,
        !dark(x, y - 1) && !dark(x + 1, y) ? r : 0,
        !dark(x, y + 1) && !dark(x + 1, y) ? r : 0,
        !dark(x, y + 1) && !dark(x - 1, y) ? r : 0,
      ]);
    }
  }
  ctx.fillStyle = c.dark;
  ctx.fill(modules);

  for (const [ox, oy] of finderOrigins(n)) {
    const x = off + ox * scale;
    const y = off + oy * scale;

    const ring = new Path2D();
    ring.roundRect(x, y, FINDER * scale, FINDER * scale, scale * 2);
    ctx.fillStyle = c.dark;
    ctx.fill(ring);

    const gap = new Path2D();
    gap.roundRect(x + scale, y + scale, (FINDER - 2) * scale, (FINDER - 2) * scale, scale * 1.4);
    ctx.fillStyle = c.light;
    ctx.fill(gap);

    const pupil = new Path2D();
    pupil.roundRect(x + 2 * scale, y + 2 * scale, 3 * scale, 3 * scale, scale * 1.5);
    ctx.fillStyle = c.dark;
    ctx.fill(pupil);
  }
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
export interface PaintOptions {
  /** Device pixels per module; must be an integer or edges alias under a camera. */
  scale: number;
  dark?: string;
  light?: string;
  rounded?: boolean;
}

/** Total edge length in device pixels for a symbol drawn at `scale`. */
export function symbolSide(modules: number, scale: number): number {
  return scale * (modules + QUIET_ZONE * 2);
}

/** Largest integer module size that fits `devicePx`, never below one. */
export function moduleScale(modules: number, devicePx: number): number {
  return Math.max(1, Math.floor(devicePx / (modules + QUIET_ZONE * 2)));
}

/**
 * Paint a symbol onto any 2D context. Kept separate from canvas sizing so the
 * same code runs on the main thread and inside a render worker.
 */
export function paintQr(ctx: AnyCanvasContext, qr: RenderedQr, opts: PaintOptions): void {
  const { scale } = opts;
  const side = symbolSide(qr.modules, scale);
  const colours = safeColours(opts.dark ?? '#000000', opts.light ?? '#ffffff');

  ctx.fillStyle = colours.light;
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = colours.dark;

  const off = QUIET_ZONE * scale;
  const n = qr.modules;
  const data = qr.data;

  // Below three device pixels a module is too small for a curve to be anything
  // but noise, and the sharp path is faster anyway.
  if (opts.rounded === true && supportsRoundRect() && scale >= MIN_ROUNDED_SCALE) {
    drawRounded(ctx, qr, { scale, off, dark: colours.dark, light: colours.light });
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

/**
 * Draw into a canvas at an integer module size. Fractional module sizes produce
 * ragged edges under camera downsampling, which measurably hurts decode rate, so
 * the symbol is snapped down and centred rather than stretched to fill.
 */
export function drawQr(canvas: HTMLCanvasElement, qr: RenderedQr, opts: DrawOptions): void {
  const dpr = opts.devicePixelRatio ?? (globalThis.devicePixelRatio || 1);
  const devicePx = Math.floor(opts.cssSize * dpr);
  const scale = moduleScale(qr.modules, devicePx);
  const side = symbolSide(qr.modules, scale);

  if (canvas.width !== side || canvas.height !== side) {
    canvas.width = side;
    canvas.height = side;
  }
  canvas.style.width = `${side / dpr}px`;
  canvas.style.height = `${side / dpr}px`;

  const ctx = canvas.getContext('2d', { alpha: false });
  if (ctx === null) throw new Error('2d canvas context unavailable');

  paintQr(ctx, qr, {
    scale,
    ...(opts.dark !== undefined ? { dark: opts.dark } : {}),
    ...(opts.light !== undefined ? { light: opts.light } : {}),
    ...(opts.rounded !== undefined ? { rounded: opts.rounded } : {}),
  });
}

/** Paint an already-sized bitmap for the caller to blit — used by the render worker. */
export function paintToBitmap(qr: RenderedQr, opts: PaintOptions): ImageBitmap {
  const side = symbolSide(qr.modules, opts.scale);
  const surface = new OffscreenCanvas(side, side);
  const ctx = surface.getContext('2d', { alpha: false });
  if (ctx === null) throw new Error('OffscreenCanvas 2d context unavailable');
  paintQr(ctx, qr, opts);
  return surface.transferToImageBitmap();
}
