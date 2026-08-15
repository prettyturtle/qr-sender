/**
 * AC-2 (segment boundaries + memory constancy) and AC-7 (resume).
 *
 * Memory is measured by self-instrumentation rather than
 * `performance.measureUserAgentSpecificMemory()`: that API measures the whole
 * realm, cannot separate our symbol buffers from everything else, and is
 * sensitive to GC timing. Counting our own bytes is deterministic and runs in
 * Node, so the "constant regardless of file size" property is a real gate
 * instead of a flaky one.
 */

import { describe, expect, it } from 'vitest';
import { Emitter, segmentCountFor } from '../emitter.js';
import { DEFAULT_K, DEFAULT_N } from '../params.js';
import { buildPayload, openPayload } from '../payload.js';
import { Receiver } from '../receiver.js';
import { sha256Hex } from '../sha256.js';
import { randomBytes, runChannel } from './harness.js';

const BLOCK = 512;
const SEGMENT_BYTES = DEFAULT_K * BLOCK;

async function build(data: Uint8Array) {
  return buildPayload({
    name: 'boundary.bin',
    mime: 'application/octet-stream',
    data,
    k: DEFAULT_K,
    n: DEFAULT_N,
    blockSize: BLOCK,
    streamId: 0x0badf00d,
    compress: false,
  });
}

describe('AC-2 — segment boundary regression', () => {
  const sizes = [
    1,
    1024,
    SEGMENT_BYTES - 1,
    SEGMENT_BYTES,
    SEGMENT_BYTES + 1,
    SEGMENT_BYTES * 5,
    SEGMENT_BYTES * 5 + 7,
  ];

  for (const size of sizes) {
    it(`reconstructs exactly ${size} bytes`, async () => {
      const data = randomBytes(size, size);
      const { payload, manifest, streamId } = await build(data);
      const res = runChannel(payload, manifest, streamId, { seed: size });

      expect(res.completed).toBe(true);
      expect(res.receiver.verifyIntegrity()).toBe('verified');
      const env = await openPayload(res.receiver.payload(), res.receiver.manifest!);
      expect(env.data.length).toBe(size);
      expect(sha256Hex(env.data)).toBe(sha256Hex(data));
    });
  }

  it('computes segment counts at the boundaries', () => {
    expect(segmentCountFor(0, DEFAULT_K, BLOCK)).toBe(1);
    expect(segmentCountFor(1, DEFAULT_K, BLOCK)).toBe(1);
    expect(segmentCountFor(SEGMENT_BYTES, DEFAULT_K, BLOCK)).toBe(1);
    expect(segmentCountFor(SEGMENT_BYTES + 1, DEFAULT_K, BLOCK)).toBe(2);
  });
});

describe('AC-2 — sender memory is constant in payload size', () => {
  it('holds the same working set for a 1-segment and a 200-segment payload', async () => {
    const small = await build(randomBytes(4096, 1));
    const large = await build(randomBytes(SEGMENT_BYTES * 200, 2));

    const es = new Emitter({ ...small, k: DEFAULT_K, n: DEFAULT_N, blockSize: BLOCK });
    const el = new Emitter({ ...large, k: DEFAULT_K, n: DEFAULT_N, blockSize: BLOCK });

    expect(el.segCount).toBe(segmentCountFor(large.payload.length, DEFAULT_K, BLOCK));
    expect(el.segCount).toBeGreaterThanOrEqual(200);
    // The only per-payload growth is the payload itself, which the caller owns.
    expect(el.residentBytes).toBe(es.residentBytes);
    expect(el.residentBytes).toBeLessThan(1024 * 1024);

    // And it stays flat while running.
    for (let i = 0; i < 5000; i++) el.next();
    expect(el.residentBytes).toBe(es.residentBytes);
  });
});

describe('AC-7 — resume after the tab is closed', () => {
  it('restores mid-transfer state and finishes from there', async () => {
    const data = randomBytes(SEGMENT_BYTES * 12 + 33, 7);
    const { payload, manifest, streamId } = await build(data);

    const emitter = new Emitter({ payload, manifest, streamId, k: DEFAULT_K, n: DEFAULT_N, blockSize: BLOCK });
    const first = new Receiver();

    // Receive until roughly halfway, then "close the tab".
    while (first.progress.ratio < 0.5) first.ingest(emitter.next());
    const midRatio = first.progress.ratio;
    const midDone = first.segmentsDone;
    expect(midRatio).toBeGreaterThan(0.4);

    const snap = first.snapshot()!;
    expect(snap).not.toBeNull();

    // Round-trip through a structured-clone, the way IndexedDB would store it.
    const cloned = structuredClone(snap);
    const resumed = Receiver.restore(cloned);

    expect(resumed.progress.ratio).toBeCloseTo(midRatio, 10);
    expect(resumed.segmentsDone).toBe(midDone);
    expect(resumed.streamId).toBe(streamId);
    expect(resumed.manifest?.hash).toBe(manifest.hash);

    while (!resumed.complete) resumed.ingest(emitter.next());

    expect(resumed.verifyIntegrity()).toBe('verified');
    const env = await openPayload(resumed.payload(), resumed.manifest!);
    expect(sha256Hex(env.data)).toBe(sha256Hex(data));
  });

  it('preserves held repair symbols across the snapshot', async () => {
    const data = randomBytes(SEGMENT_BYTES * 4, 8);
    const { payload, manifest, streamId } = await build(data);
    const emitter = new Emitter({ payload, manifest, streamId, k: DEFAULT_K, n: DEFAULT_N, blockSize: BLOCK });
    const r = new Receiver();

    // Drop every third frame. Systematic symbols are emitted first, so repairs
    // only start accumulating once the carousel passes symIndex K.
    let i = 0;
    let guard = 0;
    while (r.heldRepairBytes === 0 && guard++ < DEFAULT_N * emitter.segCount * 2) {
      const f = emitter.next();
      if (i++ % 3 !== 0) r.ingest(f);
    }
    expect(r.heldRepairBytes).toBeGreaterThan(0);
    expect(r.complete).toBe(false);

    const resumed = Receiver.restore(structuredClone(r.snapshot()!));
    expect(resumed.heldRepairBytes).toBe(r.heldRepairBytes);

    while (!resumed.complete) resumed.ingest(emitter.next());
    expect(resumed.verifyIntegrity()).toBe('verified');
  });
});
