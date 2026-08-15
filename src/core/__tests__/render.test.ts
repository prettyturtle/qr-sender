/**
 * The throughput and appearance changes both trade against optical margin, so
 * each is pinned here: profile selection must never drop below what already
 * works, colours must keep a real luminance gap, and a rounded symbol must still
 * come back out of a genuine decoder.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import QRCode from 'qrcode';
import { encode } from '../base44.js';
import {
  DEFAULT_N,
  DESIGN_MAX_VERSION,
  PROFILE_LADDER,
  QR_PROFILES,
  chooseProfile,
  maxKForFps,
  SLOWEST_DECODE_FPS,
} from '../params.js';
import { QR_COLORS } from '../../app/palette.js';
import { MIN_CONTRAST, contrastRatio, relativeLuminance, safeColours } from '../../platform/qrRender.js';
import { randomBytes } from './harness.js';
import { rasteriseQrRounded } from './png.js';

const require = createRequire(import.meta.url);
let readBarcodes: (typeof import('zxing-wasm/reader'))['readBarcodes'];

beforeAll(async () => {
  const mod = await import('zxing-wasm/reader');
  const wasmBinary = new Uint8Array(readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm')));
  await (mod.prepareZXingModule as (o: unknown) => Promise<unknown>)({
    overrides: { wasmBinary },
    fireImmediately: true,
  });
  readBarcodes = mod.readBarcodes;
}, 120_000);

describe('adaptive QR profile', () => {
  it('caps the version when the user asks for design over density', () => {
    expect(chooseProfile(688, 2).version).toBe(40);
    expect(chooseProfile(688, 2, DESIGN_MAX_VERSION).version).toBe(25);
    // A phone is already below the cap, so nothing changes there.
    expect(chooseProfile(318, 3, DESIGN_MAX_VERSION).version).toBe(25);
  });

  it('keeps a portrait phone on the profile that already works', () => {
    // ~318 CSS px is what the stage gets on a 390px viewport.
    expect(chooseProfile(318, 3).version).toBe(25);
    expect(chooseProfile(318, 2).version).toBe(25);
  });

  it('climbs to V40 on a desktop-width stage', () => {
    expect(chooseProfile(688, 2).version).toBe(40);
    expect(chooseProfile(1200, 1).version).toBe(40);
  });

  it('steps down on a small phone rather than shrinking modules', () => {
    // A 320px viewport leaves the stage ~248 CSS px.
    expect(chooseProfile(248, 2).version).toBe(15);
    expect(chooseProfile(260, 2).version).toBe(15);
  });

  it('honours both module-size floors wherever any profile can', () => {
    const ok = (p: (typeof PROFILE_LADDER)[number], css: number, dpr: number): boolean => {
      const total = p.modules + 8;
      return css / total >= 2.5 && Math.floor((css * dpr) / total) >= 3;
    };

    for (const css of [248, 318, 400, 500, 688, 1400]) {
      for (const dpr of [1, 2, 3]) {
        const label = `css=${css} dpr=${dpr}`;
        const chosen = chooseProfile(css, dpr);
        // Where no symbol can satisfy the floors — a viewport narrower than any
        // current device at dpr 1 — the smallest is the best available answer,
        // not a promise that it will decode well.
        if (PROFILE_LADDER.some((p) => ok(p, css, dpr))) {
          expect(ok(chosen, css, dpr), `${label} v=${chosen.version}`).toBe(true);
        } else {
          expect(chosen, label).toBe(PROFILE_LADDER[0]);
        }
      }
    }
  });

  it('falls back to the smallest profile when nothing can satisfy the floors', () => {
    // Below any real device width there is no good answer; returning the
    // smallest symbol is best-effort rather than a promise.
    expect(chooseProfile(120, 1).version).toBe(15);
  });

  it('V40 carries more than twice V25', () => {
    expect(QR_PROFILES.V40_L.blockSize / QR_PROFILES.V25_L.blockSize).toBeGreaterThan(2.3);
  });

  it('every profile in the ladder is a real encoder capacity', () => {
    for (const p of PROFILE_LADDER) {
      const text = '0'.repeat(p.chars);
      const opts = { version: p.version, errorCorrectionLevel: p.ecc };
      expect(() => QRCode.create([{ data: text, mode: 'alphanumeric' }], opts)).not.toThrow();
      expect(() => QRCode.create([{ data: text + '0', mode: 'alphanumeric' }], opts)).toThrow();
    }
  });
});

describe('K ceiling follows the playback rate', () => {
  it('keeps the slowest receiver inside a single carousel cycle', () => {
    for (const fps of [10, 12, 15]) {
      const k = maxKForFps(fps);
      const captureRate = SLOWEST_DECODE_FPS / fps;
      expect(captureRate * DEFAULT_N, `fps=${fps}`).toBeGreaterThanOrEqual(k);
    }
  });

  it('shrinks as playback speeds up', () => {
    expect(maxKForFps(10)).toBeGreaterThan(maxKForFps(12));
    expect(maxKForFps(12)).toBeGreaterThan(maxKForFps(15));
  });
});

describe('colour safety', () => {
  it('every offered colour clears the contrast floor against white', () => {
    for (const c of QR_COLORS) {
      expect(contrastRatio(c.hex, '#ffffff'), c.name).toBeGreaterThanOrEqual(MIN_CONTRAST);
      expect(safeColours(c.hex, '#ffffff').dark, c.name).toBe(c.hex);
    }
  });

  it('falls back to black when contrast is too low', () => {
    expect(safeColours('#cccccc', '#ffffff')).toEqual({ dark: '#000000', light: '#ffffff' });
    expect(safeColours('#888888', '#ffffff').dark).toBe('#000000');
  });

  it('refuses an inverted symbol', () => {
    // Light modules on a dark field defeat decoders that do not retry inverted.
    expect(safeColours('#ffffff', '#000000')).toEqual({ dark: '#000000', light: '#ffffff' });
  });

  it('rejects malformed colours instead of drawing something unreadable', () => {
    expect(safeColours('not-a-colour', '#ffffff').dark).toBe('#000000');
    expect(relativeLuminance('#zzzzzz')).toBeNull();
  });
});

describe('styled symbols still decode', () => {
  async function readBack(png: Uint8Array): Promise<string | null> {
    const results = await readBarcodes(png, { formats: ['QRCode'], tryHarder: true });
    return results.length > 0 ? results[0].text : null;
  }

  it('fully rounded modules and styled finder patterns survive a real decoder', async () => {
    // 0.5 turns an isolated module into a circle, and the eyes become a rounded
    // ring with a round pupil — the whole point of the styled look. If detection
    // were going to break on either, it breaks here.
    for (const p of PROFILE_LADDER) {
      const text = encode(randomBytes(p.frameBytes, p.version));
      const sym = QRCode.create([{ data: text, mode: 'alphanumeric' }], {
        version: p.version,
        errorCorrectionLevel: p.ecc,
      });
      const { png } = rasteriseQrRounded(sym.modules.data as unknown as Uint8Array, sym.modules.size, 6, 0.5);
      expect(await readBack(png), `V${p.version} styled`).toBe(text);
    }
  }, 60_000);

  it('styling survives at the smallest module size the renderer allows', async () => {
    // The renderer only rounds at three device pixels per module or more.
    const p = QR_PROFILES.V40_L;
    const text = encode(randomBytes(p.frameBytes, 11));
    const sym = QRCode.create([{ data: text, mode: 'alphanumeric' }], {
      version: p.version,
      errorCorrectionLevel: p.ecc,
    });
    const { png } = rasteriseQrRounded(sym.modules.data as unknown as Uint8Array, sym.modules.size, 3, 0.5);
    expect(await readBack(png), 'V40 styled at 3px/module').toBe(text);
  }, 30_000);

  it('decodes at the luminance of the darkest-permitted palette colour', async () => {
    // Map the worst-case colour to its equivalent grey so the raster carries the
    // same contrast the browser would produce.
    const worst = QR_COLORS.reduce((a, b) =>
      (relativeLuminance(a.hex) ?? 0) > (relativeLuminance(b.hex) ?? 0) ? a : b,
    );
    const lum = relativeLuminance(worst.hex)!;
    const grey = Math.round(255 * (lum <= 0.0031308 ? lum * 12.92 : 1.055 * lum ** (1 / 2.4) - 0.055));
    expect(grey).toBeLessThan(120);

    const text = encode(randomBytes(QR_PROFILES.V25_L.frameBytes, 7));
    const sym = QRCode.create([{ data: text, mode: 'alphanumeric' }], {
      version: 25,
      errorCorrectionLevel: 'L',
    });
    const { png } = rasteriseQrRounded(
      sym.modules.data as unknown as Uint8Array,
      sym.modules.size,
      6,
      0.5,
      4,
      grey,
    );
    expect(await readBack(png), `${worst.name} (grey ${grey})`).toBe(text);
  }, 30_000);
});
