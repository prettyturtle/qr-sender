/**
 * AC-1e — the encoding-layer boundary, exercised through a real QR decoder.
 *
 * This is the test that would have caught the design's original mistake. The
 * payload used to be raw bytes in QR byte mode, which cannot survive
 * `BarcodeDetector`: the Web Barcode Detection API exposes only
 * `DetectedBarcode.rawValue`, a DOMString, so arbitrary bytes are mangled by
 * UTF-8 decoding. base44 keeps the payload inside QR's alphanumeric character
 * set, which round-trips as text losslessly.
 *
 * Running the full `bytes -> base44 -> QR -> raster -> decode -> base44 -> bytes`
 * chain in Node makes that a CI gate. The remaining uncertainty — whether
 * Android's platform decoder normalises the text in some other way — is what
 * `public/barcode-fidelity.html` checks on a real device.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import { ALPHABET, decode, encode } from '../base44.js';
import { packFrame, unpackFrame } from '../frame.js';
import { DEFAULT_PROFILE, PROTOCOL_VERSION } from '../params.js';
import { randomBytes } from './harness.js';
import { rasteriseQr } from './png.js';

const require = createRequire(import.meta.url);
let readBarcodes: (typeof import('zxing-wasm/reader'))['readBarcodes'];

beforeAll(async () => {
  const mod = await import('zxing-wasm/reader');
  // Node has no fetch for file: URLs, so hand emscripten the bytes directly
  // instead of a path it would try to download.
  const wasmBinary = new Uint8Array(readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')));
  await (mod.prepareZXingModule as (o: unknown) => Promise<unknown>)({
    overrides: { wasmBinary },
    fireImmediately: true,
  });
  readBarcodes = mod.readBarcodes;
}, 120_000);

async function throughQr(text: string, version = DEFAULT_PROFILE.version, scale = 4): Promise<string | null> {
  const sym = QRCode.create([{ data: text, mode: 'alphanumeric' }], {
    version,
    errorCorrectionLevel: DEFAULT_PROFILE.ecc,
  });
  const { png } = rasteriseQr(sym.modules.data as unknown as Uint8Array, sym.modules.size, scale);
  const results = await readBarcodes(png, { formats: ['QRCode'], tryHarder: true });
  return results.length > 0 ? results[0].text : null;
}

describe('AC-1e — base44 survives a real QR text round-trip', () => {
  it('preserves the entire alphabet, including the characters most at risk of normalisation', async () => {
    // If a decoder trimmed or case-folded anything, this is where it shows.
    const text = ALPHABET.repeat(20).slice(0, 900);
    expect(await throughQr(text)).toBe(text);
  });

  it('preserves leading and trailing punctuation that a trimming decoder would eat', async () => {
    for (const edge of ['...', ':::', '---', '$$$', '%%%', '***', '+++', '///']) {
      const text = `${edge}${ALPHABET}${edge}`.padEnd(99, '0');
      expect(await throughQr(text), `edge=${edge}`).toBe(text);
    }
  });

  it('round-trips a full-capacity frame at the default profile', async () => {
    const bytes = randomBytes(DEFAULT_PROFILE.frameBytes, 42);
    const text = encode(bytes);
    expect(text.length).toBe(DEFAULT_PROFILE.chars);

    const back = await throughQr(text);
    expect(back).toBe(text);
    expect(decode(back!)).toEqual(bytes);
  });

  it('round-trips complete protocol frames, header and all', async () => {
    for (let trial = 0; trial < 6; trial++) {
      const payload = randomBytes(DEFAULT_PROFILE.blockSize, 200 + trial);
      const frame = packFrame(
        {
          version: PROTOCOL_VERSION,
          flags: 0,
          streamId: 0x1234abcd,
          segIndex: trial,
          symIndex: trial * 37,
          segCount: 64,
          k: 96,
          n: 255,
          blockSize: DEFAULT_PROFILE.blockSize,
        },
        payload,
      );

      const back = await throughQr(encode(frame));
      expect(back, `trial=${trial}`).not.toBeNull();
      const bytes = decode(back!);
      expect(bytes).not.toBeNull();

      const parsed = unpackFrame(bytes!);
      expect(parsed, `trial=${trial}`).not.toBeNull();
      expect(parsed!.header.symIndex).toBe(trial * 37);
      expect(new Uint8Array(parsed!.payload)).toEqual(payload);
    }
  }, 60_000);

  it('works at every QR profile the app can downshift to', async () => {
    const { QR_PROFILES } = await import('../params.js');
    for (const [name, profile] of Object.entries(QR_PROFILES)) {
      const bytes = randomBytes(profile.frameBytes, profile.version);
      const text = encode(bytes);
      const back = await throughQr(text, profile.version, 4);
      expect(back, `${name}`).toBe(text);
      expect(decode(back!), `${name}`).toEqual(bytes);
    }
  }, 60_000);
});
