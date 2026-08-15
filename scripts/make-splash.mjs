/**
 * Generates the iOS launch ("splash") images and rewrites the
 * `apple-touch-startup-image` block in index.html.
 *
 *   node scripts/make-splash.mjs
 *
 * Android/Chrome composes its splash from the manifest (background_color + the
 * 512px icon + name) and needs nothing here. Safari ignores the manifest for
 * this and demands one pre-rendered image per device resolution *and*
 * orientation, matched by media query — hence the table below. A device with no
 * match gets a blank white flash on launch, which is why the list covers every
 * iPhone and iPad still receiving iOS updates rather than just the current ones.
 *
 * Regenerate whenever a new device resolution ships; the images are pure
 * background + glyph, so they are a few KB each despite the pixel counts.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng, fillBackground, drawGlyph } from './lib/render.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'splash');
const INDEX = join(ROOT, 'index.html');

const START = '<!-- splash:start -->';
const END = '<!-- splash:end -->';

/**
 * CSS device dimensions as reported in portrait, with the device pixel ratio.
 * Both orientations are emitted per entry; iOS keeps device-width/device-height
 * fixed and distinguishes the two with `orientation`.
 */
const DEVICES = [
  [320, 568, 2, 'iPhone SE (1st gen), 5s'],
  [375, 667, 2, 'iPhone SE (2nd/3rd gen), 8, 7, 6s'],
  [414, 736, 3, 'iPhone 8 Plus, 7 Plus, 6s Plus'],
  [375, 812, 3, 'iPhone X, XS, 11 Pro, 12 mini, 13 mini'],
  [414, 896, 2, 'iPhone XR, 11'],
  [414, 896, 3, 'iPhone XS Max, 11 Pro Max'],
  [390, 844, 3, 'iPhone 12, 12 Pro, 13, 13 Pro, 14, 16e'],
  [428, 926, 3, 'iPhone 12 Pro Max, 13 Pro Max, 14 Plus'],
  [393, 852, 3, 'iPhone 14 Pro, 15, 15 Pro, 16'],
  [430, 932, 3, 'iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus'],
  [402, 874, 3, 'iPhone 16 Pro'],
  [440, 956, 3, 'iPhone 16 Pro Max'],
  [768, 1024, 2, 'iPad 9.7", mini 4'],
  [744, 1133, 2, 'iPad mini 8.3"'],
  [810, 1080, 2, 'iPad 10.2"'],
  [820, 1180, 2, 'iPad Air 10.9"/11"'],
  [834, 1112, 2, 'iPad Pro 10.5"'],
  [834, 1194, 2, 'iPad Pro 11"'],
  [834, 1210, 2, 'iPad Pro 11" (M4)'],
  [1024, 1366, 2, 'iPad Pro 12.9", Air 13"'],
  [1032, 1376, 2, 'iPad Pro 13" (M4)'],
];

function renderSplash(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  fillBackground(rgba);
  drawGlyph(rgba, width, {
    art: Math.round(Math.min(width, height) * 0.24),
    cx: width / 2,
    cy: height / 2,
  });
  return encodePng(rgba, width, height, 6);
}

mkdirSync(OUT, { recursive: true });

const links = [];
let bytes = 0;

for (const [cssW, cssH, dpr, label] of DEVICES) {
  for (const orientation of ['portrait', 'landscape']) {
    const w = (orientation === 'portrait' ? cssW : cssH) * dpr;
    const h = (orientation === 'portrait' ? cssH : cssW) * dpr;
    const file = `apple-splash-${w}x${h}.png`;

    const png = renderSplash(w, h);
    writeFileSync(join(OUT, file), png);
    bytes += png.length;

    links.push(
      `    <!-- ${label} — ${orientation} -->\n` +
        `    <link\n` +
        `      rel="apple-touch-startup-image"\n` +
        `      media="(device-width: ${cssW}px) and (device-height: ${cssH}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: ${orientation})"\n` +
        `      href="/splash/${file}"\n` +
        `    />`,
    );
  }
}

const html = readFileSync(INDEX, 'utf8');
const start = html.indexOf(START);
const end = html.indexOf(END);
if (start === -1 || end === -1) {
  throw new Error(`index.html is missing the ${START} / ${END} markers`);
}

const next =
  html.slice(0, start + START.length) +
  '\n' +
  links.join('\n') +
  '\n    ' +
  html.slice(end);
writeFileSync(INDEX, next);

console.log(
  `wrote ${links.length} launch images to public/splash/ (${(bytes / 1024).toFixed(0)} KB) ` +
    `and updated index.html`,
);
