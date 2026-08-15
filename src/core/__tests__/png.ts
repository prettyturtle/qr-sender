/**
 * Minimal grayscale PNG encoder — just enough to hand a rendered QR symbol to a
 * real decoder inside Node, so the optical-layer contract is a CI gate rather
 * than something only a phone can check.
 */

import { deflateSync } from 'node:zlib';
import { crc32 } from '../crc32.js';

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** `pixels` is one byte per pixel, row-major, 0 = black. */
export function encodeGrayPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const parts = [
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface QrRaster {
  png: Uint8Array;
  side: number;
}

/** Rasterise a QR module matrix at `scale` pixels per module, with a 4-module quiet zone. */
export function rasteriseQr(modules: Uint8Array, size: number, scale: number, quiet = 4): QrRaster {
  const side = (size + quiet * 2) * scale;
  const pixels = new Uint8Array(side * side).fill(0xff);
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (modules[my * size + mx] === 0) continue;
      const px = (quiet + mx) * scale;
      const py = (quiet + my) * scale;
      for (let dy = 0; dy < scale; dy++) {
        pixels.fill(0x00, (py + dy) * side + px, (py + dy) * side + px + scale);
      }
    }
  }
  return { png: encodeGrayPng(pixels, side, side), side };
}

/**
 * Rasterise with rounded module corners, matching what the browser renderer
 * draws. Only corners with no dark neighbour are rounded, so adjacent modules
 * stay fused — the shape a decoder still samples correctly at its centre.
 */
export function rasteriseQrRounded(
  modules: Uint8Array,
  size: number,
  scale: number,
  radiusFrac = 0.3,
  quiet = 4,
  darkLevel = 0x00,
): QrRaster {
  const side = (size + quiet * 2) * scale;
  const pixels = new Uint8Array(side * side).fill(0xff);
  const r = scale * radiusFrac;
  const dark = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < size && y < size && modules[y * size + x] !== 0;

  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!dark(mx, my)) continue;
      const up = dark(mx, my - 1);
      const down = dark(mx, my + 1);
      const left = dark(mx - 1, my);
      const right = dark(mx + 1, my);
      const x0 = (quiet + mx) * scale;
      const y0 = (quiet + my) * scale;

      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const lx = dx + 0.5;
          const ly = dy + 0.5;
          let inside = true;
          const corners: Array<[boolean, number, number]> = [
            [!up && !left, r, r],
            [!up && !right, scale - r, r],
            [!down && !right, scale - r, scale - r],
            [!down && !left, r, scale - r],
          ];
          for (const [active, cx, cy] of corners) {
            if (!active) continue;
            const outsideX = (cx < scale / 2 && lx < cx) || (cx > scale / 2 && lx > cx);
            const outsideY = (cy < scale / 2 && ly < cy) || (cy > scale / 2 && ly > cy);
            if (outsideX && outsideY && Math.hypot(lx - cx, ly - cy) > r) inside = false;
          }
          if (inside) pixels[(y0 + dy) * side + x0 + dx] = darkLevel;
        }
      }
    }
  }
  return { png: encodeGrayPng(pixels, side, side), side };
}
