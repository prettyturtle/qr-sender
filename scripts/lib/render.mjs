/**
 * Shared rasteriser for the generated app artwork (icons + iOS launch images).
 *
 * Hand-written rather than pulled from a rasteriser dependency: the mark is a
 * handful of rounded rectangles and circles, which is cheaper to express as
 * signed distance fields than to take on a native build dependency for.
 *
 * Shapes are antialiased analytically — coverage comes from the distance to the
 * edge rather than from supersampling. That matters more than it sounds: a home
 * screen icon is authored at 512px and displayed at 48–60px, and hard-edged art
 * downscaled that far turns to gravel. Curves have to be genuinely smooth at the
 * source size to survive the trip.
 */

import { deflateSync } from 'node:zlib';

/** Splash background: the app's dark surface, so launch does not flash. */
export const BG = [0x0e, 0x0e, 0x11];
/** Brand blue, used for the mark wherever it sits on the dark background. */
export const FG = [0x5b, 0x8c, 0xff];

/** Icon background gradient, top-left to bottom-right. */
const GRAD_FROM = [0x4c, 0x8d, 0xff];
const GRAD_TO = [0x6c, 0x3c, 0xe9];

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

/* ─── signed distance fields ─────────────────────────────────────────────── */

function sdRoundedRect(px, py, cx, cy, halfW, halfH, r) {
  const dx = Math.abs(px - cx) - (halfW - r);
  const dy = Math.abs(py - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/**
 * Distance to a shape's edge, converted to how much of the pixel it covers.
 *
 * `distance` arrives in mark units, so it has to be scaled into pixels before
 * the half-pixel ramp means anything. Skipping that spreads the antialiasing
 * over a whole unit — about 18px on a 192px icon — and the mark comes out
 * looking like it is behind frosted glass.
 */
function coverage(distance, unit) {
  return Math.min(1, Math.max(0, 0.5 - distance * unit));
}

/* ─── the mark ───────────────────────────────────────────────────────────── */

/**
 * The mark, laid out on a 7-unit square.
 *
 * Three rounded finder eyes and a diagonal trail of shrinking dots where a real
 * QR's fourth corner would be. The eyes are what make it read as a QR code at a
 * glance — they are the single most recognisable thing about one — and the trail
 * is the sending. The old mark scattered eleven rows of small squares, which is
 * legible on a spec sheet and mush at 48px.
 *
 * Returned as primitives rather than drawn directly so the same geometry backs
 * both the rasteriser and the SVG.
 */
export function markShapes() {
  const shapes = [];

  // Standard finder proportions, thickened for small sizes: a ring the width of
  // a hairline reads as grey rather than as a shape once the icon is downscaled.
  const EYE = 3;
  const RING = 0.56;
  const GAP = 0.34;
  for (const [ox, oy] of [
    [0, 0],
    [4, 0],
    [0, 4],
  ]) {
    const cx = ox + EYE / 2;
    const cy = oy + EYE / 2;
    shapes.push({ kind: 'ring', cx, cy, half: EYE / 2, r: 0.62, thickness: RING });
    const pupil = EYE / 2 - RING - GAP;
    shapes.push({ kind: 'rect', cx, cy, half: pupil, r: 0.26 });
  }

  // Data leaving the code. Shrinking rather than uniform, so it reads as motion
  // in one direction instead of as three unrelated dots.
  shapes.push({ kind: 'dot', cx: 4.62, cy: 4.62, r: 0.95 });
  shapes.push({ kind: 'dot', cx: 5.92, cy: 5.92, r: 0.6 });
  shapes.push({ kind: 'dot', cx: 6.72, cy: 6.72, r: 0.3 });

  return shapes;
}

export const MARK_UNITS = 7;

/** Coverage of the mark at a point given in mark units. */
function markCoverage(ux, uy, shapes, unit) {
  let covered = 0;
  for (const s of shapes) {
    let d;
    if (s.kind === 'dot') {
      d = sdCircle(ux, uy, s.cx, s.cy, s.r);
    } else if (s.kind === 'rect') {
      d = sdRoundedRect(ux, uy, s.cx, s.cy, s.half, s.half, s.r);
    } else {
      const outer = sdRoundedRect(ux, uy, s.cx, s.cy, s.half, s.half, s.r);
      const innerHalf = s.half - s.thickness;
      const inner = sdRoundedRect(ux, uy, s.cx, s.cy, innerHalf, innerHalf, Math.max(0.02, s.r - s.thickness));
      d = Math.max(outer, -inner);
    }
    covered = Math.max(covered, coverage(d, unit));
    if (covered >= 1) return 1;
  }
  return covered;
}

/* ─── painting ───────────────────────────────────────────────────────────── */

/** Fills an RGBA buffer with the opaque background colour. */
export function fillBackground(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = BG[0];
    rgba[i + 1] = BG[1];
    rgba[i + 2] = BG[2];
    rgba[i + 3] = 0xff;
  }
}

/** Fills with the icon's diagonal gradient. */
export function fillGradient(rgba, width, height) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(GRAD_FROM[c] + (GRAD_TO[c] - GRAD_FROM[c]) * t);
      }
      rgba[i + 3] = 0xff;
    }
  }
}

/**
 * Draws the mark into `rgba` as a square of `art` px centred on (cx, cy).
 *
 * Composites rather than overwrites, so the antialiased edge blends into
 * whatever background is already there instead of leaving a jagged silhouette.
 */
export function drawGlyph(rgba, width, { art, cx, cy, colour = FG }) {
  const shapes = markShapes();
  const unit = art / MARK_UNITS;
  const left = cx - art / 2;
  const top = cy - art / 2;

  // Only touch the pixels the mark can reach; the launch images are mostly
  // background and scanning all of them costs seconds.
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(width, Math.ceil(left + art));
  const y1 = Math.min(Math.ceil(top + art), rgba.length / 4 / width);

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // Sample at the pixel centre, and express the distance in mark units so
      // the SDF radii stay resolution independent.
      const a = markCoverage((x + 0.5 - left) / unit, (y + 0.5 - top) / unit, shapes, unit);
      if (a <= 0) continue;
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(rgba[i + c] * (1 - a) + colour[c] * a);
      }
    }
  }
}

/** SVG body for the mark, in a `0 0 7 7` coordinate system. */
export function markSvg(fill) {
  const parts = markShapes().map((s) => {
    if (s.kind === 'dot') return `<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}"/>`;
    const size = s.half * 2;
    const x = s.cx - s.half;
    const y = s.cy - s.half;
    if (s.kind === 'rect') {
      return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${s.r}"/>`;
    }
    // A ring is one path with the hole wound the other way, so `evenodd` keeps
    // it hollow without needing a second colour painted back over the middle.
    const ih = s.half - s.thickness;
    const ir = Math.max(0.02, s.r - s.thickness);
    return (
      `<path fill-rule="evenodd" d="` +
      roundedRectPath(x, y, size, s.r) +
      roundedRectPath(s.cx - ih, s.cy - ih, ih * 2, ir) +
      `"/>`
    );
  });
  return `<g fill="${fill}">${parts.join('')}</g>`;
}

function roundedRectPath(x, y, size, r) {
  const n = (v) => Number(v.toFixed(3));
  return (
    `M${n(x + r)} ${n(y)}h${n(size - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(r)}` +
    `v${n(size - 2 * r)}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(r)}` +
    `h${n(-(size - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(-r)} ${n(-r)}` +
    `v${n(-(size - 2 * r))}a${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(-r)}z`
  );
}

export const GRADIENT = { from: GRAD_FROM, to: GRAD_TO };
export const hex = (c) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
