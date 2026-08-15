/// <reference lib="webworker" />

/**
 * One decoder, in its own thread, with its own wasm instance.
 *
 * The receiving side is throughput-bound on how many *distinct* frames per
 * second it can decode, and a single wasm decoder on the main thread caps that
 * at one decode at a time — a 100ms decode means 10fps no matter how fast the
 * sender plays. Several of these run in parallel instead, each holding its own
 * module, so decode rate scales with cores.
 *
 * Frames arrive as transferred `ImageBitmap`s: the crop happens on the main
 * thread's compositor, the transfer is zero-copy, and the pixel readback that
 * zxing needs happens here rather than blocking the UI.
 */

import { readBarcodes, prepareZXingModule } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

export interface DecodeRequest {
  id: number;
  /** Already cropped and sized by the caller — resampling again would only blur. */
  bitmap: ImageBitmap;
}

export interface DecodeResponse {
  id: number;
  texts: string[];
  /** Milliseconds spent inside the decoder, for the throughput readout. */
  ms: number;
}

let ready: Promise<unknown> | null = null;
let surface: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

function init(): Promise<unknown> {
  ready ??= prepareZXingModule({
    overrides: { locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) },
    fireImmediately: true,
  });
  return ready;
}

// Warm the module up immediately: the first frame should not pay for it.
void init();

function pixels(bitmap: ImageBitmap): ImageData {
  const w = bitmap.width;
  const h = bitmap.height;

  if (surface === null || surface.width !== w || surface.height !== h) {
    surface = new OffscreenCanvas(w, h);
    ctx = surface.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  const c = ctx;
  if (c === null) throw new Error('OffscreenCanvas 2d context unavailable');
  c.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, w, h);
  return c.getImageData(0, 0, w, h);
}

self.onmessage = async (event: MessageEvent<DecodeRequest>): Promise<void> => {
  const { id, bitmap } = event.data;
  const started = performance.now();
  let texts: string[] = [];
  try {
    await init();
    const results = await readBarcodes(pixels(bitmap), {
      formats: ['QRCode'],
      // Exactly one symbol is ever on screen; saying so lets the decoder stop at
      // the first hit instead of scanning the rest of the image.
      maxNumberOfSymbols: 1,
      tryHarder: false,
      tryRotate: false,
      tryInvert: false,
      tryDownscale: true,
    });
    texts = results.map((r) => r.text);
  } catch {
    texts = [];
  } finally {
    bitmap.close();
  }
  const response: DecodeResponse = { id, texts, ms: performance.now() - started };
  self.postMessage(response);
};
