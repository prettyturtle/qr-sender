/**
 * Shared rasteriser for the generated app artwork (icons + iOS launch images).
 *
 * Hand-written rather than pulled from a rasteriser dependency: the glyph is a
 * grid of squares, which is a dozen lines of fillRect-equivalent, and it keeps
 * the build free of native modules.
 */

import { deflateSync } from 'node:zlib';

export const BG = [0x0e, 0x0e, 0x11];
export const FG = [0x5b, 0x8c, 0xff];

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}
const crc32 = (b, s = 0, e = b.length) => {
  let c = 0xffffffff;
  for (let i = s; i < e; i++) c = (CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/**
 * @param level zlib level. The icons are tiny so they get level 9; the launch
 *   images are up to 2064x2752 of near-uniform background, where level 6 lands
 *   within a few bytes of level 9 for a fraction of the time.
 */
export function encodePng(rgba, width, height, level = 9) {
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level }))),
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

/**
 * 11x11 glyph: three finder patterns plus a scatter of data modules — reads as
 * "QR" at 48px without being a scannable code.
 */
export const GRID = 11;
export function glyph() {
  const g = Array.from({ length: GRID }, () => new Array(GRID).fill(0));
  const finder = (ox, oy) => {
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const edge = x === 0 || y === 0 || x === 4 || y === 4;
        const core = x >= 2 && x <= 2 && y >= 2 && y <= 2;
        g[oy + y][ox + x] = edge || core ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(GRID - 5, 0);
  finder(0, GRID - 5);
  for (const [x, y] of [
    [7, 7], [9, 7], [7, 9], [10, 10], [8, 8], [6, 10], [10, 6],
    [6, 6], [9, 10], [10, 8],
  ]) {
    g[y][x] = 1;
  }
  return g;
}

/** Fills an RGBA buffer with the opaque background colour. */
export function fillBackground(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = BG[0];
    rgba[i + 1] = BG[1];
    rgba[i + 2] = BG[2];
    rgba[i + 3] = 0xff;
  }
}

/**
 * Draws the glyph into `rgba` as a square of `art` px centred on (cx, cy).
 */
export function drawGlyph(rgba, width, { art, cx, cy }) {
  const g = glyph();
  const cell = art / GRID;
  const offX = cx - art / 2;
  const offY = cy - art / 2;
  const gap = Math.max(1, Math.round(cell * 0.1));

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (!g[gy][gx]) continue;
      const x0 = Math.round(offX + gx * cell);
      const y0 = Math.round(offY + gy * cell);
      const x1 = Math.round(offX + (gx + 1) * cell) - gap;
      const y1 = Math.round(offY + (gy + 1) * cell) - gap;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          rgba[i] = FG[0];
          rgba[i + 1] = FG[1];
          rgba[i + 2] = FG[2];
        }
      }
    }
  }
}
