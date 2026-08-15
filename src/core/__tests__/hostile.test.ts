/**
 * Adversarial input.
 *
 * A receiver points a camera at whatever happens to be on a screen, so every
 * byte it parses is attacker-controlled: header fields, manifest JSON, envelope
 * lengths, filename, MIME type. Nothing here should be reachable in normal use;
 * all of it is reachable by displaying a hostile QR animation.
 */

import { describe, expect, it } from 'vitest';
import { packFrame, unpackFrame } from '../frame.js';
import { decodeManifest, encodeManifest, type Manifest } from '../manifest.js';
import { unwrapEnvelope, wrapEnvelope } from '../envelope.js';
import { decode as base44Decode } from '../base44.js';
import { Receiver } from '../receiver.js';
import {
  FLAG_MANIFEST,
  MANIFEST_INDEX,
  MAX_BLOCK_SIZE,
  MAX_RECEIVE_BYTES,
  PROTOCOL_VERSION,
} from '../params.js';
import { randomBytes } from './harness.js';

function forge(
  overrides: Partial<Parameters<typeof packFrame>[0]>,
  payloadLength?: number,
): Uint8Array {
  const header = {
    version: PROTOCOL_VERSION,
    flags: 0,
    streamId: 0xdeadbeef,
    segIndex: 0,
    symIndex: 0,
    segCount: 1,
    k: 96,
    n: 255,
    blockSize: 64,
    ...overrides,
  };
  return packFrame(header, new Uint8Array(payloadLength ?? header.blockSize));
}

describe('memory exhaustion via forged headers', () => {
  it('rejects a stream whose declared size would exhaust memory', () => {
    // Worst case that survives the per-field limits:
    // 65535 segments x 255 blocks x 4096 bytes = 68 GB.
    const bomb = forge({ segCount: 65535, k: 255, n: 255, blockSize: MAX_BLOCK_SIZE }, MAX_BLOCK_SIZE);
    const declared = 65535 * 255 * MAX_BLOCK_SIZE;
    expect(declared).toBeGreaterThan(60e9);

    const receiver = new Receiver();
    expect(receiver.ingest(bomb)).toBe('invalid');
    expect(receiver.oversizedStream).toBe(true);
    expect(receiver.initialised).toBe(false);
    expect(receiver.outputBytes).toBe(0);
  });

  it('rejects a blockSize no QR profile could carry', () => {
    const oversized = forge({ blockSize: MAX_BLOCK_SIZE + 1 }, MAX_BLOCK_SIZE + 1);
    expect(unpackFrame(oversized)).toBeNull();
  });

  it('rejects a zero segment count', () => {
    expect(unpackFrame(forge({ segCount: 0 }))).toBeNull();
  });

  it('accepts a stream just inside the ceiling', () => {
    // 1024 segments x 96 x 2048 = 201 MB, under the 256 MB cap.
    const ok = forge({ segCount: 1024, k: 96, n: 255, blockSize: 2048 }, 2048);
    expect(1024 * 96 * 2048).toBeLessThan(MAX_RECEIVE_BYTES);
    const receiver = new Receiver();
    expect(receiver.ingest(ok)).toBe('ok');
    expect(receiver.oversizedStream).toBe(false);
  });
});

describe('forged frames against a locked stream', () => {
  const base = { segCount: 4, k: 96, n: 255, blockSize: 64 };

  function lockedReceiver(): Receiver {
    const receiver = new Receiver();
    expect(receiver.ingest(forge(base))).toBe('ok');
    return receiver;
  }

  it('refuses frames that change the stream geometry mid-transfer', () => {
    const receiver = lockedReceiver();
    // Same streamId, different K — would corrupt the buffer layout if honoured.
    expect(receiver.ingest(forge({ ...base, k: 32, symIndex: 1 }))).toBe('invalid');
    expect(receiver.ingest(forge({ ...base, segCount: 9, symIndex: 1 }))).toBe('invalid');
    expect(receiver.ingest(forge({ ...base, blockSize: 128, symIndex: 1 }, 128))).toBe('invalid');
    expect(receiver.k).toBe(96);
    expect(receiver.segCount).toBe(4);
  });

  it('refuses a segment index past the declared count', () => {
    expect(unpackFrame(forge({ ...base, segIndex: 4 }))).toBeNull();
  });

  it('refuses a symbol index past N', () => {
    expect(unpackFrame(forge({ ...base, symIndex: 255 }))).toBeNull();
  });

  it('refuses a manifest frame without the sentinel indices', () => {
    expect(unpackFrame(forge({ ...base, flags: FLAG_MANIFEST, segIndex: 0, symIndex: 0 }))).toBeNull();
  });

  it('refuses a data frame wearing manifest sentinel indices', () => {
    expect(
      unpackFrame(forge({ ...base, flags: 0, segIndex: MANIFEST_INDEX, symIndex: MANIFEST_INDEX })),
    ).toBeNull();
  });
});

describe('hostile manifests', () => {
  const good: Manifest = {
    v: 1,
    size: 100,
    hash: 'b'.repeat(64),
    k: 96,
    n: 255,
    blockSize: 64,
    segCount: 4,
    compressed: false,
    encrypted: false,
  };

  function manifestFrame(m: unknown): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(m));
    const payload = new Uint8Array(64);
    new DataView(payload.buffer).setUint16(0, json.length);
    payload.set(json.subarray(0, 62), 2);
    return packFrame(
      {
        version: PROTOCOL_VERSION,
        flags: FLAG_MANIFEST,
        streamId: 0xdeadbeef,
        segIndex: MANIFEST_INDEX,
        symIndex: MANIFEST_INDEX,
        segCount: 4,
        k: 96,
        n: 255,
        blockSize: 64,
      },
      payload,
    );
  }

  it('does not pollute Object.prototype', () => {
    const payload = encodeManifest(good, 512);
    expect(decodeManifest(payload)).not.toBeNull();

    const polluted = decodeManifest(
      (() => {
        const json = new TextEncoder().encode('{"__proto__":{"polluted":true},"v":1}');
        const out = new Uint8Array(512);
        new DataView(out.buffer).setUint16(0, json.length);
        out.set(json, 2);
        return out;
      })(),
    );
    expect(polluted).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects a declared size larger than the stream can hold', () => {
    const receiver = new Receiver();
    receiver.ingest(
      packFrame(
        {
          version: PROTOCOL_VERSION,
          flags: 0,
          streamId: 0xdeadbeef,
          segIndex: 0,
          symIndex: 0,
          segCount: 4,
          k: 96,
          n: 255,
          blockSize: 64,
        },
        new Uint8Array(64),
      ),
    );
    // Buffer is 4 * 96 * 64 = 24576 bytes; claim far more.
    expect(receiver.ingest(manifestFrame({ ...good, size: 1_000_000 }))).toBe('invalid');
    expect(receiver.manifest).toBeNull();
  });

  it('rejects manifests disagreeing with the frame geometry', () => {
    const receiver = new Receiver();
    receiver.ingest(forge({ segCount: 4, k: 96, n: 255, blockSize: 64 }));
    expect(receiver.ingest(manifestFrame({ ...good, k: 32 }))).toBe('invalid');
    expect(receiver.ingest(manifestFrame({ ...good, segCount: 99 }))).toBe('invalid');
    expect(receiver.manifest).toBeNull();
  });

  it('rejects malformed and hostile field types', () => {
    for (const bad of [
      { ...good, v: 2 },
      { ...good, size: -1 },
      { ...good, size: 'lots' },
      { ...good, hash: 'not-hex' },
      { ...good, hash: 'A'.repeat(64) },
      { ...good, k: 1.5 },
      { ...good, segCount: NaN },
      { ...good, encrypted: true },
      { ...good, encrypted: true, kdf: { salt: 'AA==', iterations: 1 }, iv: 'AA==', name: 'leak.txt' },
      null,
      [],
      'string',
    ]) {
      const out = new Uint8Array(512);
      const json = new TextEncoder().encode(JSON.stringify(bad));
      new DataView(out.buffer).setUint16(0, json.length);
      out.set(json.subarray(0, 510), 2);
      expect(decodeManifest(out), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects a length prefix that overruns the payload', () => {
    const out = new Uint8Array(64);
    new DataView(out.buffer).setUint16(0, 5000);
    expect(decodeManifest(out)).toBeNull();
    new DataView(out.buffer).setUint16(0, 0);
    expect(decodeManifest(out)).toBeNull();
  });
});

describe('hostile envelopes and text', () => {
  it('rejects declared lengths that overrun the buffer', () => {
    const buf = wrapEnvelope('a.txt', 'text/plain', new Uint8Array([1, 2, 3]));
    // Claim a 60000-byte filename inside a 20-byte envelope.
    new DataView(buf.buffer, buf.byteOffset, buf.byteLength).setUint16(1, 60000);
    expect(unwrapEnvelope(buf)).toBeNull();
  });

  it('rejects a mime length that overruns the buffer', () => {
    const buf = wrapEnvelope('a', 'text/plain', new Uint8Array([1]));
    buf[1 + 2 + 1] = 250; // mimeLen byte, far past the end
    expect(unwrapEnvelope(buf)).toBeNull();
  });

  it('survives a filename that is pure control characters', () => {
    const name = ' [2J../../etc/passwd';
    const env = unwrapEnvelope(wrapEnvelope(name, 'text/plain', new Uint8Array([1])))!;
    // Sanitising is the UI's job; the codec must round-trip faithfully so the
    // viewer sees exactly what was sent rather than something half-cleaned.
    expect(env.name).toBe(name);
  });

  it('never returns partial garbage from malformed base44', () => {
    const junk = ['@@@', 'AB', ' 00', '   ', 'aaa', '::::::'];
    for (const j of junk) expect(base44Decode(j), j).toBeNull();
  });

  it('rejects random bytes as frames without throwing', () => {
    const receiver = new Receiver();
    for (let i = 0; i < 500; i++) {
      const junk = randomBytes(1 + (i % 1300), i);
      expect(() => receiver.ingest(junk)).not.toThrow();
    }
    expect(receiver.initialised).toBe(false);
    expect(receiver.framesRejected).toBe(500);
  });
});
