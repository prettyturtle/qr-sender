/**
 * Module colours offered on the send screen.
 *
 * Every entry is checked against white at build time by `palette.test.ts`: a
 * camera reads luminance, so a colour that looks fine on a monitor but sits too
 * close to the background in brightness simply stops decoding. Anything below
 * the contrast floor is rejected at draw time anyway — this list exists so the
 * user never has to discover that by failing to scan.
 */

export interface QrColor {
  hex: string;
  /** Not translated: these are proper-noun-ish swatch labels, shown as tooltips. */
  name: string;
}

export const QR_COLORS: readonly QrColor[] = [
  { hex: '#111111', name: 'Ink' },
  { hex: '#1b3a8f', name: 'Navy' },
  { hex: '#0f5132', name: 'Forest' },
  { hex: '#6b1839', name: 'Wine' },
  { hex: '#3d2b8f', name: 'Violet' },
  { hex: '#7a3300', name: 'Rust' },
];
