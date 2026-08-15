/**
 * Generates the PWA icon set. The rasteriser lives in ./lib/render.mjs.
 *
 *   node scripts/make-icons.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GRADIENT, encodePng, fillGradient, drawGlyph, hex, markSvg } from './lib/render.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(OUT, { recursive: true });

const WHITE = [0xff, 0xff, 0xff];

/**
 * `safeArea` is the fraction of the icon edge the mark spans.
 *
 * A maskable icon may be cropped to a circle of 80% diameter, so a *square*
 * mark has to fit inside that circle: 0.8 / sqrt(2) = 0.566 is the largest side
 * that never clips a corner. The `any` variant has no such constraint.
 *
 * The artwork bleeds to the edge rather than drawing its own rounded corners.
 * Every platform that shows these applies its own mask — iOS a squircle,
 * Android whatever the launcher picked — and art that rounds itself first ends
 * up with a dark crescent trapped between the two curves.
 */
function renderIcon(size, { safeArea = 0.66 } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  fillGradient(rgba, size, size);
  drawGlyph(rgba, size, { art: size * safeArea, cx: size / 2, cy: size / 2, colour: WHITE });
  return encodePng(rgba, size, size);
}

// The SVG favicon is the one place the art is shown unmasked, at tab size, so
// it keeps its own rounded corners.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${hex(GRADIENT.from)}"/>
      <stop offset="1" stop-color="${hex(GRADIENT.to)}"/>
    </linearGradient>
  </defs>
  <rect width="10" height="10" rx="2.2" fill="url(#g)"/>
  <g transform="translate(1.5 1.5)">${markSvg('#ffffff')}</g>
</svg>
`;

writeFileSync(join(OUT, 'icon.svg'), svg);
writeFileSync(join(OUT, 'icon-192.png'), renderIcon(192));
writeFileSync(join(OUT, 'icon-512.png'), renderIcon(512));
writeFileSync(join(OUT, 'icon-512-maskable.png'), renderIcon(512, { safeArea: 0.55 }));
console.log('wrote public/icon.svg, icon-192.png, icon-512.png, icon-512-maskable.png');
