/**
 * How well focused the camera is on what it is pointed at.
 *
 * Most laptop and USB webcams are **fixed focus**: the lens is glued at a focal
 * plane somewhere around 40–70cm and there is no API, on any platform, that can
 * move it. Phones autofocus and so the problem never shows up there. On a PC the
 * transfer simply fails, with no indication of why — the picture looks fine to a
 * person, because a human reading a slightly soft image is nothing like a
 * decoder trying to resolve 177 module edges across it.
 *
 * Since the focus cannot be corrected in software, the next best thing is to
 * make it *visible*: measure it, show it, and let the user move the phone until
 * the number peaks. That converts an invisible failure into a three-second
 * physical adjustment, and it works on cameras that expose no focus controls at
 * all — which is nearly all of them.
 *
 * The metric is mean absolute luma gradient, the classic Tenengrad-style
 * estimate. It is measured on the tracked symbol rather than the whole frame,
 * so a sharp desk behind a blurry phone cannot flatter the reading.
 */

/** Analysis grid. Small enough to be free, large enough to resolve module edges. */
const GRID = 96;

/**
 * Mean gradient of a well-focused symbol, used to normalise into 0..1.
 *
 * QR modules are full black-to-white transitions, so a sharp symbol produces a
 * very large gradient and a defocused one collapses toward the blur radius.
 * Calibrated so that "in focus enough for V40 to decode" lands near 1.
 */
const SHARP_REFERENCE = 46;

export interface SharpnessMeter {
  /** Measure the given region of the video. Returns 0..1, or -1 if unavailable. */
  measure(source: CanvasImageSource, sx: number, sy: number, side: number): number;
  close(): void;
}

export function createSharpnessMeter(): SharpnessMeter | null {
  if (typeof OffscreenCanvas === 'undefined') return null;
  const canvas = new OffscreenCanvas(GRID, GRID);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (ctx === null) return null;

  return {
    measure(source, sx, sy, side): number {
      if (side < 8) return -1;
      try {
        ctx.drawImage(source, sx, sy, side, side, 0, 0, GRID, GRID);
      } catch {
        // Video not ready, or a cross-origin source. Neither is worth reporting.
        return -1;
      }
      const { data } = ctx.getImageData(0, 0, GRID, GRID);

      let total = 0;
      let count = 0;
      for (let y = 0; y < GRID - 1; y++) {
        for (let x = 0; x < GRID - 1; x++) {
          const i = (y * GRID + x) * 4;
          // Green alone, not a full luma conversion: it carries most of the
          // luminance, and every camera samples it at twice the rate of red or
          // blue, so it is both the cheapest and the least interpolated channel.
          const here = data[i + 1];
          total += Math.abs(data[i + 5] - here) + Math.abs(data[i + GRID * 4 + 1] - here);
          count += 2;
        }
      }
      if (count === 0) return -1;
      return Math.min(1, total / count / SHARP_REFERENCE);
    },

    close(): void {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

export type FocusQuality = 'unknown' | 'poor' | 'fair' | 'good';

/**
 * Bands chosen from where decoding actually starts working, not from taste.
 *
 * Below `poor` a dense symbol has no chance and the user needs to move; the
 * `fair` band is where low versions decode and high ones do not, which is
 * exactly when telling the sender to lower its density is the right advice.
 */
export function focusQuality(sharpness: number): FocusQuality {
  if (sharpness < 0) return 'unknown';
  if (sharpness < 0.34) return 'poor';
  if (sharpness < 0.62) return 'fair';
  return 'good';
}
