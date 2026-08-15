/**
 * AC-1 — end-to-end loopback over the simulated channel.
 *
 * Every case asserts the recovered bytes hash-match the original. The optical
 * layer (QR render -> camera -> detector) is deliberately out of scope here; see
 * `barcode-fidelity.test.ts` for that boundary.
 */

import { describe, expect, it } from 'vitest';
import { buildPayload, openPayload, WrongPassphraseError } from '../payload.js';
import { DEFAULT_K, DEFAULT_N, DEFAULT_PROFILE } from '../params.js';
import { sha256Hex } from '../sha256.js';
import { Receiver } from '../receiver.js';
import { packFrame } from '../frame.js';
import { PROTOCOL_VERSION } from '../params.js';
import { compressibleBytes, randomBytes, runChannel } from './harness.js';

const BLOCK = DEFAULT_PROFILE.blockSize;

async function build(data: Uint8Array, extra: Partial<Parameters<typeof buildPayload>[0]> = {}) {
  return buildPayload({
    name: 'report.pdf',
    mime: 'application/pdf',
    data,
    k: DEFAULT_K,
    n: DEFAULT_N,
    blockSize: BLOCK,
    streamId: 0xa1b2c3d4,
    ...extra,
  });
}

describe('AC-1a — lossless', () => {
  it('reconstructs a 500KB payload byte-for-byte', async () => {
    const data = randomBytes(500 * 1024, 1);
    const { payload, manifest, streamId } = await build(data);
    const res = runChannel(payload, manifest, streamId);

    expect(res.completed).toBe(true);
    expect(res.receiver.verifyIntegrity()).toBe('verified');
    const env = await openPayload(res.receiver.payload(), res.receiver.manifest!);
    expect(sha256Hex(env.data)).toBe(sha256Hex(data));
    expect(env.name).toBe('report.pdf');
    // Systematic code, clean channel: no coding overhead at all.
    expect(res.captureOverhead).toBeLessThanOrEqual(1.1);
  });
});

describe('AC-1b — 30% frame loss', () => {
  it('still reconstructs', async () => {
    const data = randomBytes(300 * 1024, 2);
    const { payload, manifest, streamId } = await build(data);
    const res = runChannel(payload, manifest, streamId, { lossRate: 0.3, seed: 77 });

    expect(res.completed).toBe(true);
    expect(res.receiver.verifyIntegrity()).toBe('verified');
    const env = await openPayload(res.receiver.payload(), res.receiver.manifest!);
    expect(sha256Hex(env.data)).toBe(sha256Hex(data));
  });
});

describe('AC-1c — mid-stream join', () => {
  it('reconstructs from an arbitrary entry point', async () => {
    const data = randomBytes(200 * 1024, 3);
    const { payload, manifest, streamId } = await build(data);

    for (const startOffset of [1, 37, 500, 1234, 4096, 9999]) {
      const res = runChannel(payload, manifest, streamId, { startOffset, seed: 100 + startOffset });
      expect(res.completed, `startOffset=${startOffset}`).toBe(true);
      expect(res.receiver.verifyIntegrity()).toBe('verified');
      const env = await openPayload(res.receiver.payload(), res.receiver.manifest!);
      expect(sha256Hex(env.data)).toBe(sha256Hex(data));
      // Joining mid-carousel costs nothing: any K distinct symbols will do.
      expect(res.captureOverhead, `startOffset=${startOffset}`).toBeLessThanOrEqual(2.2);
    }
  });
});

describe('AC-1d — 10% corrupted frames', () => {
  it('drops them on CRC and keeps going', async () => {
    const data = randomBytes(200 * 1024, 4);
    const { payload, manifest, streamId } = await build(data);
    const res = runChannel(payload, manifest, streamId, { corruptRate: 0.1, seed: 55 });

    expect(res.completed).toBe(true);
    expect(res.receiver.framesRejected).toBeGreaterThan(0);
    expect(res.receiver.verifyIntegrity()).toBe('verified');
    const env = await openPayload(res.receiver.payload(), res.receiver.manifest!);
    expect(sha256Hex(env.data)).toBe(sha256Hex(data));
  });
});

describe('AC-1f — scheduler under capture rate < 1', () => {
  // Small blocks keep the byte arithmetic cheap while preserving the schedule
  // dynamics that matter: many segments, realistic K/N, periodic subsampling.
  const smallBlock = 512;

  async function buildSmall(segCount: number) {
    const data = randomBytes(segCount * DEFAULT_K * smallBlock - 1000, 9);
    return buildPayload({
      name: 'big.bin',
      mime: 'application/octet-stream',
      data,
      k: DEFAULT_K,
      n: DEFAULT_N,
      blockSize: smallBlock,
      streamId: 0x5566aabb,
      compress: false,
    });
  }

  it('completes at every capture rate down to the design minimum, from any join point', async () => {
    const { payload, manifest, streamId } = await buildSmall(90);

    for (const captureRate of [1, 0.8, 0.6, 0.4]) {
      for (const startOffset of [0, 7777]) {
        const res = runChannel(payload, manifest, streamId, {
          captureRate,
          startOffset,
          seed: 4242,
        });
        const label = `r=${captureRate} offset=${startOffset}`;
        expect(res.completed, label).toBe(true);
        expect(res.receiver.verifyIntegrity(), label).toBe('verified');
        expect(res.codingOverhead, label).toBeLessThanOrEqual(1.1);
        // Joining at a pass boundary must not waste camera time; a mid-pass join
        // pays for duplicates across the boundary but never more than one extra pass.
        expect(res.captureOverhead, label).toBeLessThanOrEqual(startOffset === 0 ? 1.3 : 2.2);
        expect(res.framesDisplayed, label).toBeLessThanOrEqual(2 * DEFAULT_N * 90);
      }
    }
  });

  it('holds repair symbols bounded well below the output size', async () => {
    const { payload, manifest, streamId } = await buildSmall(90);
    const res = runChannel(payload, manifest, streamId, { captureRate: 0.4, seed: 31 });
    expect(res.completed).toBe(true);
    // Systematic symbols land straight in the output buffer; only repairs are held.
    expect(res.peakRepairBytes).toBeLessThan(res.receiver.outputBytes);
  });

  it('survives a sampling period that divides the segment count', async () => {
    // 64 segments sampled at exactly 1/2 is the aliasing trap a naive
    // `for symbol: for segment` schedule would fall into.
    const { payload, manifest, streamId } = await buildSmall(64);
    const res = runChannel(payload, manifest, streamId, {
      captureRate: 0.5,
      captureMode: 'periodic',
      seed: 8,
    });
    expect(res.completed).toBe(true);
    expect(res.receiver.verifyIntegrity()).toBe('verified');
  });
});

describe('AC-1g — compression path', () => {
  it('compresses when it helps and round-trips', async () => {
    const data = compressibleBytes(400 * 1024, 5);
    const { payload, manifest, streamId } = await build(data, { name: 'log.txt', mime: 'text/plain' });

    expect(manifest.compressed).toBe(true);
    expect(payload.length).toBeLessThan(data.length * 0.5);

    const res = runChannel(payload, manifest, streamId);
    expect(res.completed).toBe(true);
    const env = await openPayload(res.receiver.payload(), res.receiver.manifest!);
    expect(sha256Hex(env.data)).toBe(sha256Hex(data));
    expect(env.name).toBe('log.txt');
  });

  it('skips compression on incompressible input', async () => {
    const data = randomBytes(64 * 1024, 6);
    const { manifest } = await build(data);
    expect(manifest.compressed).toBe(false);
  });
});

describe('AC-1h — a second transmission appears mid-transfer', () => {
  it('keeps the locked stream and reports the intruder', async () => {
    const data = randomBytes(120 * 1024, 7);
    const a = await build(data, { streamId: 0x11111111 });
    const b = await build(randomBytes(120 * 1024, 8), { streamId: 0x22222222 });

    const receiver = new Receiver();
    const { Emitter } = await import('../emitter.js');
    const ea = new Emitter({ ...a, k: DEFAULT_K, n: DEFAULT_N, blockSize: BLOCK });
    const eb = new Emitter({ ...b, k: DEFAULT_K, n: DEFAULT_N, blockSize: BLOCK });

    for (let i = 0; i < 200; i++) receiver.ingest(ea.next());
    const beforeRatio = receiver.progress.ratio;
    expect(beforeRatio).toBeGreaterThan(0);

    for (let i = 0; i < 50; i++) expect(receiver.ingest(eb.next())).toBe('other-stream');

    expect(receiver.foreignStreamId).toBe(0x22222222);
    expect(receiver.streamId).toBe(0x11111111);
    expect(receiver.progress.ratio).toBe(beforeRatio);

    while (!receiver.complete) receiver.ingest(ea.next());
    expect(receiver.verifyIntegrity()).toBe('verified');
    const env = await openPayload(receiver.payload(), receiver.manifest!);
    expect(sha256Hex(env.data)).toBe(sha256Hex(data));
  });
});

describe('AC-5 — encryption round-trip', () => {
  it('recovers with the right passphrase and hides metadata from the manifest', async () => {
    const data = randomBytes(80 * 1024, 10);
    const { payload, manifest, streamId } = await build(data, {
      passphrase: 'correct horse battery staple',
      name: 'salary-2026.xlsx',
      mime: 'application/vnd.ms-excel',
    });

    expect(manifest.encrypted).toBe(true);
    expect(manifest.name).toBeUndefined();
    expect(manifest.mime).toBeUndefined();
    expect(manifest.plainSize).toBeUndefined();
    // The filename must not be recoverable from anything broadcast in the clear.
    expect(JSON.stringify(manifest)).not.toContain('salary');

    const res = runChannel(payload, manifest, streamId);
    expect(res.completed).toBe(true);
    const env = await openPayload(res.receiver.payload(), res.receiver.manifest!, 'correct horse battery staple');
    expect(sha256Hex(env.data)).toBe(sha256Hex(data));
    expect(env.name).toBe('salary-2026.xlsx');
  });

  it('fails fast and clearly on a wrong passphrase', async () => {
    const data = randomBytes(16 * 1024, 11);
    const { payload, manifest, streamId } = await build(data, { passphrase: 'right' });
    const res = runChannel(payload, manifest, streamId);
    await expect(openPayload(res.receiver.payload(), res.receiver.manifest!, 'wrong')).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
  });
});

describe('frame validation', () => {
  it('rejects a frame whose header claims the wrong protocol version', () => {
    const receiver = new Receiver();
    const frame = packFrame(
      {
        version: PROTOCOL_VERSION + 1,
        flags: 0,
        streamId: 1,
        segIndex: 0,
        symIndex: 0,
        segCount: 1,
        k: 4,
        n: 8,
        blockSize: 16,
      },
      new Uint8Array(16),
    );
    expect(receiver.ingest(frame)).toBe('invalid');
  });

  it('rejects truncated and garbage input', () => {
    const receiver = new Receiver();
    expect(receiver.ingest(new Uint8Array(4))).toBe('invalid');
    expect(receiver.ingest(new Uint8Array(1235))).toBe('invalid');
  });
});
