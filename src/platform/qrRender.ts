/**
 * QR rendering. Alphanumeric mode is forced explicitly rather than left to the
 * encoder's auto-selection, so a payload that happens to look numeric cannot
 * silently switch modes and change the frame capacity mid-stream.
 */

import QRCode from 'qrcode';
import type { QrProfile } from '../core/params.js';

/** Quiet zone in modules, per the QR spec. Dropping below 4 costs detection rate. */
const QUIET_ZONE = 4;

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

export interface DrawOptions {
  /** CSS pixels available for the whole symbol including its quiet zone. */
  cssSize: number;
  devicePixelRatio?: number;
  dark?: string;
  light?: string;
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

  ctx.fillStyle = opts.light ?? '#ffffff';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = opts.dark ?? '#000000';

  const off = QUIET_ZONE * scale;
  const n = qr.modules;
  for (let y = 0; y < n; y++) {
    const rowBase = y * n;
    let x = 0;
    while (x < n) {
      if (qr.data[rowBase + x] === 0) {
        x++;
        continue;
      }
      // Coalesce horizontal runs into one fillRect — roughly 3x fewer draw calls.
      let run = 1;
      while (x + run < n && qr.data[rowBase + x + run] !== 0) run++;
      ctx.fillRect(off + x * scale, off + y * scale, run * scale, scale);
      x += run;
    }
  }
}

