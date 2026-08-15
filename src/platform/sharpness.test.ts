import { describe, expect, it } from 'vitest';
import { createSharpnessMeter, focusQuality } from './sharpness.js';

describe('focusQuality', () => {
  it('reports unknown before the first reading rather than guessing', () => {
    // -1 is the "no measurement yet" sentinel. Reporting it as `poor` would put
    // a red bar and a "move the screen" instruction on screen the instant the
    // camera opens, before anything has been looked at.
    expect(focusQuality(-1)).toBe('unknown');
  });

  it('bands a blurred symbol as poor', () => {
    expect(focusQuality(0)).toBe('poor');
    expect(focusQuality(0.33)).toBe('poor');
  });

  it('bands a marginal symbol as fair', () => {
    expect(focusQuality(0.34)).toBe('fair');
    expect(focusQuality(0.61)).toBe('fair');
  });

  it('bands a sharp symbol as good', () => {
    expect(focusQuality(0.62)).toBe('good');
    expect(focusQuality(1)).toBe('good');
  });

  it('is monotonic, so the bar never moves the wrong way', () => {
    const rank = { unknown: -1, poor: 0, fair: 1, good: 2 };
    let previous = -1;
    for (let v = 0; v <= 1.0001; v += 0.02) {
      const current = rank[focusQuality(v)];
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

describe('createSharpnessMeter', () => {
  it('returns null where OffscreenCanvas is absent instead of throwing', () => {
    // The scanner treats null as "no focus readout" and carries on. A throw
    // here would take the whole receive screen down on an older browser.
    expect(createSharpnessMeter()).toBeNull();
  });
});
