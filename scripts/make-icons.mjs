/**
 * Generates the PWA icon set. The rasteriser lives in ./lib/render.mjs.
 *
 *   node scripts/make-icons.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GRID, glyph, encodePng, fillBackground, drawGlyph } from './lib/render.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(OUT, { recursive: true });

/**
 * `safeArea` is the fraction of the icon edge the glyph spans.
 *
 * A maskable icon may be cropped to a circle of 80% diameter, so a *square*
 * glyph has to fit inside that circle: 0.8 / sqrt(2) = 0.566 is the largest
 * side that never clips a corner. The `any` variant has no such constraint and
 * fills 0.8 so the glyph does not look lost inside its own padding.
 */
function renderIcon(size, { safeArea = 0.8 } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  fillBackground(rgba);
  drawGlyph(rgba, size, { art: size * safeArea, cx: size / 2, cy: size / 2 });
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
writeFileSync(join(OUT, 'icon-512-maskable.png'), renderIcon(512, { safeArea: 0.55 }));
console.log('wrote public/icon.svg, icon-192.png, icon-512.png, icon-512-maskable.png');
