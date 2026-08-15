import { describe, expect, it } from 'vitest';
import { moduleScale, moduleScaleExact, symbolSide } from './qrRender.js';

/** V40, the profile the throughput ladder tops out at. */
const V40 = 177;
const QUIET_TOTAL = 8;

describe('moduleScaleExact', () => {
  it('fills the budget instead of rounding down to the next whole pixel', () => {
    // A 393pt phone at dpr 3: the case that motivated this. The integer scale
    // leaves 15% of the width as margin, and that margin is throughput.
    const devicePx = Math.floor((393 - 32) * 3);
    const exact = moduleScaleExact(V40, devicePx);
    const floored = moduleScale(V40, devicePx);

    expect(floored).toBe(5);
    expect(exact).toBeGreaterThan(5.8);
    expect(symbolSide(V40, exact)).toBe(devicePx);
    // The whole point: meaningfully more symbol on the same screen.
    expect(symbolSide(V40, exact) / symbolSide(V40, floored)).toBeGreaterThan(1.15);
  });

  it('agrees with the integer scale where the budget divides evenly', () => {
    // The exact path must be a strict generalisation, not a different renderer:
    // where nothing was being lost, nothing changes.
    const devicePx = 6 * (V40 + QUIET_TOTAL);
    expect(moduleScaleExact(V40, devicePx)).toBe(6);
    expect(moduleScale(V40, devicePx)).toBe(6);
  });

  it('never goes below one device pixel per module', () => {
    expect(moduleScaleExact(V40, 10)).toBe(1);
    expect(moduleScaleExact(V40, 0)).toBe(1);
  });

  it('produces a symbol that fits the budget exactly, at any size', () => {
    for (const devicePx of [400, 733, 1083, 1440, 2001]) {
      for (const modules of [57, 97, 137, V40]) {
        const side = symbolSide(modules, moduleScaleExact(modules, devicePx));
        expect(side).toBeLessThanOrEqual(devicePx);
        // Rounding may cost at most half a pixel; anything more is a bug.
        expect(devicePx - side).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('edge snapping', () => {
  /** Mirrors the boundary table `paintQr` builds, so the invariants are testable. */
  function edges(modules: number, scale: number): Int32Array {
    const off = 4 * scale;
    const out = new Int32Array(modules + 1);
    for (let i = 0; i <= modules; i++) out[i] = Math.round(off + i * scale);
    return out;
  }

  it('leaves no gap or overlap between neighbouring modules', () => {
    // Each module starts exactly where the previous one ended: sharing the edge
    // value is what removes the grey seam that fractional rectangles produce.
    const scale = moduleScaleExact(V40, 1083);
    const e = edges(V40, scale);
    for (let i = 0; i < V40; i++) {
      expect(e[i + 1]).toBeGreaterThan(e[i]);
    }
  });

  it('keeps module pitch within one pixel of uniform', () => {
    // Decoders resolve the grid from the finder patterns rather than assuming a
    // constant pitch, but the variation still has to stay small and bounded.
    const scale = moduleScaleExact(V40, 1083);
    const e = edges(V40, scale);
    const widths = Array.from({ length: V40 }, (_, i) => e[i + 1] - e[i]);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(1);
  });

  it('lands on exact multiples when the scale is a whole number', () => {
    const e = edges(V40, 6);
    for (let i = 0; i <= V40; i++) expect(e[i]).toBe(24 + i * 6);
  });
});
