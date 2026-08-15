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
   * @param video live element, used directly by backends that accept it
   * @param grab  lazily produces an ImageData readback for backends that need one
   */
  detect(video: HTMLVideoElement, grab: () => ImageData): Promise<string[]>;
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
    async detect(video) {
      // Passing the video element skips the readback entirely.
      const found = await impl.detect(video);
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
    async detect(_video, grab) {
      const results = await readBarcodes(grab(), {
        formats: ['QRCode'],
        tryHarder: false,
        tryRotate: false,
        tryInvert: false,
        maxNumberOfSymbols: 4,
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
