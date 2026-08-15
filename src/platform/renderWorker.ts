/// <reference lib="webworker" />

/**
 * Builds one QR symbol and returns it as a ready-to-blit bitmap.
 *
 * Encoding a V40 symbol costs about 7ms on a fast desktop and several times
 * that on a phone; painting a styled one adds thousands of path operations on
 * top. Doing that on the main thread inside the playback loop means the frame
 * rate is capped by encoding cost rather than by anything optical, and the cost
 * lands as visible jitter.
 *
 * Order does not matter here. Every frame carries its own segment and symbol
 * index, so a batch may complete out of order and the receiver is unaffected —
 * which is what lets several of these run in parallel with no sequencing.
 */

import { buildQr, paintToBitmap } from './qrRender.js';
import type { QrProfile } from '../core/params.js';

export interface RenderRequest {
  id: number;
  /** base44 payload for one frame. */
  text: string;
  profile: QrProfile;
  /** Device pixels per module. */
  scale: number;
  dark: string;
  rounded: boolean;
}

export interface RenderResponse {
  id: number;
  bitmap: ImageBitmap | null;
  ms: number;
}

self.onmessage = (event: MessageEvent<RenderRequest>): void => {
  const { id, text, profile, scale, dark, rounded } = event.data;
  const started = performance.now();
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = paintToBitmap(buildQr(text, profile), { scale, dark, rounded });
  } catch {
    bitmap = null;
  }
  const response: RenderResponse = { id, bitmap, ms: performance.now() - started };
  self.postMessage(response, bitmap === null ? [] : [bitmap]);
};
