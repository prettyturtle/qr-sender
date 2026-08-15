/**
 * QR detection with two backends behind one interface.
 *
 *  - `BarcodeDetector` (Android Chrome): hardware-backed, and it accepts the
 *    `<video>` element directly so there is no pixel readback at all. It only
 *    exposes `rawValue` as a DOMString, which is exactly why the wire format is
 *    base44 text rather than raw bytes.
 *  - `zxing-wasm`: everywhere else, notably iOS Safari and Firefox. Needs an
 *    `ImageData` readback.
 *
 * Both backends see identical characters, so a stream produced for one decodes
 * on the other.
 */

export type DetectorKind = 'barcode-detector' | 'zxing-wasm';

export interface FrameDetector {
  readonly kind: DetectorKind;
  /**
   * Both backends are handed the same cropped, downscaled region.
   *
   * `BarcodeDetector` accepts the `<video>` element directly, and passing it
   * avoids a pixel readback — but it then has to locate a symbol across the full
   * 1920x1080 frame, and that search dominates its latency. Feeding it the same
   * centre crop the wasm decoder gets trades a few milliseconds of readback for
   * a much smaller search area.
   *
   * @param canvas cropped region, already drawn
   * @param pixels lazily reads it back for backends that cannot take a canvas
   */
  detect(canvas: HTMLCanvasElement, pixels: () => ImageData): Promise<string[]>;
  close(): void;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource | Blob | ImageData): Promise<Array<{ rawValue: string; format: string }>>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts?: { formats?: string[] }): BarcodeDetectorLike;
      getSupportedFormats?(): Promise<string[]>;
    };
  }
}

export async function barcodeDetectorAvailable(): Promise<boolean> {
  const ctor = globalThis.window?.BarcodeDetector;
  if (ctor === undefined) return false;
  try {
    const formats = (await ctor.getSupportedFormats?.()) ?? [];
    return formats.includes('qr_code');
  } catch {
    return false;
  }
}

function createNativeDetector(): FrameDetector {
  const ctor = globalThis.window!.BarcodeDetector!;
  const impl = new ctor({ formats: ['qr_code'] });
  return {
    kind: 'barcode-detector',
    async detect(canvas) {
      const found = await impl.detect(canvas);
      return found.map((f) => f.rawValue);
    },
    close() {},
  };
}

async function createZxingDetector(): Promise<FrameDetector> {
  const [{ readBarcodes, prepareZXingModule }, wasmUrl] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url').then((m) => m.default),
  ]);

  await prepareZXingModule({
    overrides: { locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) },
    fireImmediately: true,
  });

  return {
    kind: 'zxing-wasm',
    async detect(_canvas, pixels) {
      const results = await readBarcodes(pixels(), {
        formats: ['QRCode'],
        tryHarder: false,
        tryRotate: false,
        tryInvert: false,
        // A sender may tile up to six symbols across a wide screen.
        maxNumberOfSymbols: 8,
      });
      return results.map((r) => r.text);
    },
    close() {},
  };
}

export interface CreateDetectorOptions {
  /** Force a backend. Used by the A/B benchmark page and by the settings toggle. */
  force?: DetectorKind;
}

export async function createDetector(opts: CreateDetectorOptions = {}): Promise<FrameDetector> {
  if (opts.force === 'zxing-wasm') return createZxingDetector();
  if (opts.force === 'barcode-detector') {
    if (!(await barcodeDetectorAvailable())) throw new Error('BarcodeDetector is not available here');
    return createNativeDetector();
  }
  if (await barcodeDetectorAvailable()) return createNativeDetector();
  return createZxingDetector();
}
