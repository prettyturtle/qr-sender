/**
 * Generates the PWA icon set. Written by hand rather than pulled from a
 * rasteriser dependency: the glyph is a grid of squares, which is a dozen lines
 * of fillRect-equivalent, and it keeps the build free of native modules.
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(OUT, { recursive: true });

const BG = [0x0e, 0x0e, 0x11];
const FG = [0x5b, 0x8c, 0xff];

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

function encodePng(rgba, width, height) {
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
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))),
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
const GRID = 11;
function glyph() {
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

function renderIcon(size, { maskableSafeArea = 0.8 } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    rgba[i * 4] = BG[0];
    rgba[i * 4 + 1] = BG[1];
    rgba[i * 4 + 2] = BG[2];
    rgba[i * 4 + 3] = 0xff;
  }

  const g = glyph();
  const art = size * maskableSafeArea;
  const cell = art / GRID;
  const off = (size - art) / 2;

  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      if (!g[gy][gx]) continue;
      const x0 = Math.round(off + gx * cell);
      const y0 = Math.round(off + gy * cell);
      const x1 = Math.round(off + (gx + 1) * cell) - Math.max(1, Math.round(cell * 0.1));
      const y1 = Math.round(off + (gy + 1) * cell) - Math.max(1, Math.round(cell * 0.1));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * size + x) * 4;
          rgba[i] = FG[0];
          rgba[i + 1] = FG[1];
          rgba[i + 2] = FG[2];
        }
      }
    }
  }
  return encodePng(rgba, size, size);
}

const svgCells = glyph()
  .flatMap((row, y) =>
    row.map((on, x) =>
      on ? `<rect x="${x + 0.05}" y="${y + 0.05}" width="0.9" height="0.9" rx="0.12"/>` : '',
    ),
  )
  .join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}">
  <rect width="${GRID}" height="${GRID}" rx="2.2" fill="#0e0e11"/>
  <g fill="#5b8cff">${svgCells}</g>
</svg>
`;

writeFileSync(join(OUT, 'icon.svg'), svg);
writeFileSync(join(OUT, 'icon-192.png'), renderIcon(192));
writeFileSync(join(OUT, 'icon-512.png'), renderIcon(512));
console.log('wrote public/icon.svg, icon-192.png, icon-512.png');
