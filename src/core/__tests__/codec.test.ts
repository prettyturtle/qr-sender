import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { ALPHABET, capacityForChars, decode, encode, encodedLength } from '../base44.js';
import { unwrapEnvelope, wrapEnvelope } from '../envelope.js';
import { packFrame, unpackFrame } from '../frame.js';
import { decodeManifest, encodeManifest, type Manifest } from '../manifest.js';
import { DEFAULT_PROFILE, PROTOCOL_VERSION, QR_PROFILES } from '../params.js';
import { Sha256, sha256Hex } from '../sha256.js';
import { randomBytes, rng } from './harness.js';

describe('base44', () => {
  it('uses only QR alphanumeric characters and excludes SPACE', () => {
    expect(ALPHABET.length).toBe(44);
    expect(ALPHABET).not.toContain(' ');
    expect(new Set(ALPHABET).size).toBe(44);
    // Every character must be encodable by QR's alphanumeric mode.
    for (const ch of ALPHABET) {
      expect(() => QRCode.create([{ data: ch, mode: 'alphanumeric' }], { errorCorrectionLevel: 'L' })).not.toThrow();
    }
  });

  it('packs 2 bytes into 3 characters — no density loss versus base45', () => {
    expect(encodedLength(2)).toBe(3);
    expect(encodedLength(1)).toBe(2);
    expect(encodedLength(1234)).toBe(1851);
    expect(capacityForChars(1853)).toBe(1235);
  });

  it('round-trips every single byte and every byte pair', () => {
    for (let a = 0; a < 256; a++) {
      const one = new Uint8Array([a]);
      expect(decode(encode(one))).toEqual(one);
      for (let b = 0; b < 256; b += 7) {
        const two = new Uint8Array([a, b]);
        expect(decode(encode(two))).toEqual(two);
      }
    }
  });

  it('round-trips random buffers of every length up to a full frame', () => {
    for (let len = 0; len <= 40; len++) {
      const buf = randomBytes(len, len + 1);
      expect(decode(encode(buf))).toEqual(buf);
    }
    const full = randomBytes(DEFAULT_PROFILE.frameBytes, 99);
    const text = encode(full);
    expect(text.length).toBeLessThanOrEqual(DEFAULT_PROFILE.chars);
    expect(decode(text)).toEqual(full);
  });

  it('rejects malformed text instead of returning garbage', () => {
    expect(decode('A')).toBeNull(); // length % 3 === 1
    expect(decode('A B')).toBeNull(); // SPACE is not in the alphabet
    expect(decode('a00')).toBeNull(); // lowercase
    expect(decode('한글일')).toBeNull();
    expect(decode(':::')).toBeNull(); // 43 + 43*44 + 43*1936 > 0xffff
    expect(decode('::')).toBeNull(); // 43 + 43*44 > 0xff
  });
});

describe('envelope', () => {
  it('round-trips name, mime and data including unicode', () => {
    const data = randomBytes(500, 3);
    const env = unwrapEnvelope(wrapEnvelope('보고서 2026.pdf', 'application/pdf', data))!;
    expect(env).not.toBeNull();
    expect(env.name).toBe('보고서 2026.pdf');
    expect(env.mime).toBe('application/pdf');
    expect(new Uint8Array(env.data)).toEqual(data);
  });

  it('rejects truncated input', () => {
    const buf = wrapEnvelope('a.txt', 'text/plain', new Uint8Array([1, 2, 3]));
    expect(unwrapEnvelope(buf.subarray(0, 2))).toBeNull();
  });
});

describe('frame', () => {
  const header = {
    version: PROTOCOL_VERSION,
    flags: 0,
    streamId: 0xdeadbeef,
    segIndex: 7,
    symIndex: 200,
    segCount: 40,
    k: 96,
    n: 255,
    blockSize: 1211,
  };

  it('round-trips the header exactly', () => {
    const payload = randomBytes(1211, 4);
    const parsed = unpackFrame(packFrame(header, payload))!;
    expect(parsed).not.toBeNull();
    expect(parsed.header).toEqual(header);
    expect(new Uint8Array(parsed.payload)).toEqual(payload);
  });

  it('detects a single flipped bit anywhere in the frame', () => {
    const payload = randomBytes(1211, 5);
    const frame = packFrame(header, payload);
    const r = rng(2024);
    for (let trial = 0; trial < 400; trial++) {
      const copy = frame.slice();
      const pos = Math.floor(r() * copy.length);
      copy[pos] ^= 1 << Math.floor(r() * 8);
      expect(unpackFrame(copy), `flip at ${pos}`).toBeNull();
    }
  });

  it('rejects out-of-range indices', () => {
    expect(unpackFrame(packFrame({ ...header, segIndex: 40 }, randomBytes(1211, 6)))).toBeNull();
    expect(unpackFrame(packFrame({ ...header, symIndex: 255 }, randomBytes(1211, 6)))).toBeNull();
  });

  it('rejects a length that disagrees with the declared blockSize', () => {
    const frame = packFrame(header, randomBytes(1210, 7));
    expect(unpackFrame(frame)).toBeNull();
  });
});

describe('manifest', () => {
  const base: Manifest = {
    v: 1,
    size: 123456,
    hash: 'a'.repeat(64),
    k: 96,
    n: 255,
    blockSize: 1211,
    segCount: 2,
    compressed: false,
    encrypted: false,
    name: 'x.bin',
    mime: 'application/octet-stream',
    plainSize: 123400,
  };

  it('round-trips', () => {
    expect(decodeManifest(encodeManifest(base, 1211))).toEqual(base);
  });

  it('refuses an encrypted manifest that leaks a filename', () => {
    const bad = { ...base, encrypted: true, kdf: { salt: 'AA==', iterations: 600000 }, iv: 'AA==' };
    expect(decodeManifest(encodeManifest(bad, 1211))).toBeNull();
  });

  it('rejects a malformed hash', () => {
    const bad = { ...base, hash: 'nope' };
    expect(decodeManifest(encodeManifest(bad, 1211))).toBeNull();
  });
});

describe('sha256', () => {
  it('matches published vectors', () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(
      sha256Hex(new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches WebCrypto on random buffers, in one shot and streamed', async () => {
    for (const len of [1, 55, 56, 63, 64, 65, 1000, 100_000]) {
      const buf = randomBytes(len, len);
      const expected = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf as BufferSource))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      expect(sha256Hex(buf), `len=${len}`).toBe(expected);

      const streamed = new Sha256();
      for (let o = 0; o < buf.length; o += 37) streamed.update(buf.subarray(o, Math.min(o + 37, buf.length)));
      expect(streamed.hex(), `streamed len=${len}`).toBe(expected);
    }
  });
});

describe('QR profiles', () => {
  it('match what the encoder actually accepts (guards against dependency drift)', () => {
    for (const [name, p] of Object.entries(QR_PROFILES)) {
      const text = ALPHABET[0].repeat(p.chars);
      const fits = (s: string) => () =>
        QRCode.create([{ data: s, mode: 'alphanumeric' }], {
          version: p.version,
          errorCorrectionLevel: p.ecc,
        });

      expect(fits(text), `${name} should fit exactly ${p.chars} chars`).not.toThrow();
      expect(fits(text + ALPHABET[0]), `${name} must not fit ${p.chars + 1} chars`).toThrow();

      const sym = QRCode.create([{ data: text, mode: 'alphanumeric' }], {
        version: p.version,
        errorCorrectionLevel: p.ecc,
      });
      expect(sym.modules.size, `${name} module count`).toBe(p.modules);
    }
  });

  it('a full frame encodes into the default profile with zero slack', () => {
    const p = DEFAULT_PROFILE;
    expect(p.blockSize).toBe(1211);
    const frame = randomBytes(p.frameBytes, 1);
    const text = encode(frame);
    expect(text.length).toBe(p.chars);
    const sym = QRCode.create([{ data: text, mode: 'alphanumeric' }], {
      version: p.version,
      errorCorrectionLevel: p.ecc,
    });
    expect(sym.modules.size).toBe(117);
  });
});
