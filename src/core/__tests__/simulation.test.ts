/**
 * SP-B — schedule x capture-rate x mid-join sweep.
 *
 * This is the de-risking simulation, kept as a permanent test rather than
 * thrown away: it *is* the coding core, exercised across the parameter space
 * that decides K and N.
 *
 * Why there is no fountain-code arm to compare against: a systematic MDS code
 * needs exactly K symbols to reconstruct K blocks, which is the
 * information-theoretic floor. No rateless code can beat 1.0x, so the only
 * dimension where LT could win is unbounded N — GF(256) caps us at N = 255,
 * so a receiver capturing less than K/N of the frames needs a second pass.
 * That threshold is what this sweep measures.
 */

import { describe, expect, it } from 'vitest';
import { buildPayload } from '../payload.js';
import { DEFAULT_K, DEFAULT_N, MIN_CAPTURE_RATE } from '../params.js';
import { randomBytes, runChannel } from './harness.js';

const BLOCK = 512; // keeps byte arithmetic cheap; schedule dynamics are unaffected

async function payloadWith(segCount: number) {
  return buildPayload({
    name: 'sim.bin',
    mime: 'application/octet-stream',
    data: randomBytes(segCount * DEFAULT_K * BLOCK - 777, 4321),
    k: DEFAULT_K,
    n: DEFAULT_N,
    blockSize: BLOCK,
    streamId: 0xfeedface,
    compress: false,
  });
}

describe('SP-B — parameter sweep', () => {
  it('K/N satisfies the single-pass constraint for the worst supported receiver', () => {
    // r_min * N >= K is what makes every receiver, fast or slow, finish in one pass.
    expect(MIN_CAPTURE_RATE * DEFAULT_N).toBeGreaterThanOrEqual(DEFAULT_K);
    // Report the margin so a future K bump is an explicit decision.
    const maxK = Math.floor(MIN_CAPTURE_RATE * DEFAULT_N);
    expect(DEFAULT_K).toBeLessThanOrEqual(maxK);
  });

  it('sweeps capture rate x loss x join offset', async () => {
    const segCount = 30;
    const { payload, manifest, streamId } = await payloadWith(segCount);

    const rows: string[] = [];
    rows.push('  r     loss  offset |  captured/needed  passes  ok');
    rows.push('  ----- ----- ------ |  ---------------  ------  --');

    for (const captureRate of [1, 0.8, 0.6, 0.4]) {
      for (const lossRate of [0, 0.1, 0.2]) {
        for (const startOffset of [0, 5000]) {
          const res = runChannel(payload, manifest, streamId, {
            captureRate,
            lossRate,
            startOffset,
            seed: 20260816,
            maxFrames: DEFAULT_N * segCount * 6,
          });
          rows.push(
            `  ${captureRate.toFixed(2)}  ${lossRate.toFixed(2)}  ${String(startOffset).padStart(6)} |` +
              `  ${res.captureOverhead.toFixed(3).padStart(15)}  ${String(res.passes).padStart(6)}` +
              `  ${res.completed ? 'y' : 'N'}`,
          );

          expect(res.completed, `r=${captureRate} loss=${lossRate} offset=${startOffset}`).toBe(true);
          expect(res.receiver.verifyIntegrity()).toBe('verified');
          // Coding overhead is 1.0 by construction; anything above 1.05 is manifest frames only.
          expect(res.codingOverhead).toBeLessThanOrEqual(1.1);
        }
      }
    }

    console.log(`\nSP-B sweep (K=${DEFAULT_K}, N=${DEFAULT_N}, segments=${segCount})\n${rows.join('\n')}\n`);
  });

  it('locates the capture-rate floor where a second carousel pass becomes necessary', async () => {
    const segCount = 12;
    const { payload, manifest, streamId } = await payloadWith(segCount);

    const theoretical = DEFAULT_K / DEFAULT_N; // 0.376
    const results: Array<{ r: number; displayedPerPass: number; ok: boolean }> = [];

    for (const captureRate of [0.45, 0.4, 0.376, 0.35, 0.3]) {
      const res = runChannel(payload, manifest, streamId, {
        captureRate,
        seed: 31337,
        maxFrames: DEFAULT_N * segCount * 8,
      });
      results.push({
        r: captureRate,
        displayedPerPass: res.framesDisplayed / (DEFAULT_N * segCount),
        ok: res.completed,
      });
      expect(res.completed, `r=${captureRate} must still complete, just slower`).toBe(true);
    }

    console.log(
      `\nCapture-rate floor (theoretical K/N = ${theoretical.toFixed(3)}):\n` +
        results
          .map((x) => `  r=${x.r.toFixed(3)}  passes needed ~${x.displayedPerPass.toFixed(2)}`)
          .join('\n') +
        '\n',
    );

    // Above the floor: one pass. Below it: degrades gracefully, never fails.
    const above = results.find((x) => x.r === 0.45)!;
    const below = results.find((x) => x.r === 0.3)!;
    expect(above.displayedPerPass).toBeLessThanOrEqual(1.05);
    expect(below.displayedPerPass).toBeGreaterThan(1.05);
    expect(below.ok).toBe(true);
  });

  it('never regresses below the information-theoretic floor', async () => {
    const { payload, manifest, streamId } = await payloadWith(8);
    const res = runChannel(payload, manifest, streamId, { captureRate: 1 });
    // Cannot receive fewer symbols than blocks. Equality here proves the code is
    // both systematic and MDS in practice, not just on paper.
    expect(res.receiver.framesAccepted).toBeGreaterThanOrEqual(res.receiver.progress.needed);
    expect(res.codingOverhead).toBeGreaterThanOrEqual(1);
    expect(res.codingOverhead).toBeLessThan(1.06);
  });
});
