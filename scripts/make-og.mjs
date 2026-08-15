/**
 * Generates the social preview card. The rasteriser lives in ./lib/render.mjs.
 *
 *   node scripts/make-og.mjs
 *
 * PNG rather than SVG: every major crawler that renders link previews — Facebook,
 * X, Slack, Discord, KakaoTalk — refuses SVG for `og:image`, so a vector card
 * would silently produce no preview at all.
 *
 * The card carries the mark and nothing else. Rendering a wordmark would mean
 * shipping a font rasteriser for seven glyphs, and every surface that shows this
 * image already prints `og:title` and `og:description` beside it — so the text
 * would be duplicated at best and inconsistent with the localised title at worst.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng, fillGradient, drawGlyph } from './lib/render.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
mkdirSync(OUT, { recursive: true });

/** The size every platform scales from; 1.91:1 is the ratio they all crop to. */
export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

const WHITE = [0xff, 0xff, 0xff];

const rgba = new Uint8Array(OG_WIDTH * OG_HEIGHT * 4);
fillGradient(rgba, OG_WIDTH, OG_HEIGHT);
drawGlyph(rgba, OG_WIDTH, {
  // Sized against the short edge: the card is cropped toward square on some
  // surfaces, and a mark measured against the width would lose its corners.
  art: OG_HEIGHT * 0.52,
  cx: OG_WIDTH / 2,
  cy: OG_HEIGHT / 2,
  colour: WHITE,
});

// Level 6: the card is a smooth gradient, where level 9 costs several times the
// time for a fraction of a percent.
writeFileSync(join(OUT, 'og.png'), encodePng(rgba, OG_WIDTH, OG_HEIGHT, 6));
console.log(`wrote public/og.png (${OG_WIDTH}x${OG_HEIGHT})`);
