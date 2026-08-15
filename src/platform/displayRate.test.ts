import { describe, expect, it } from 'vitest';
import { adviseRates, decodeCeilingFps } from './displayRate.js';
import { PLAYBACK_FPS_OPTIONS } from '../core/params.js';

const ALL = PLAYBACK_FPS_OPTIONS;

describe('adviseRates', () => {
  it('does not offer a rate the panel cannot refresh at', () => {
    const advice = adviseRates(60, ALL);
    expect(advice.options).not.toContain(120);
    expect(advice.options).toEqual([15, 20, 30, 60]);
  });

  it('offers 60 on a 60Hz panel measured a hair low', () => {
    // Panels rarely measure at exactly their nominal rate, and rounding a 59.9Hz
    // reading down would silently halve the ceiling on the most common display
    // there is.
    expect(adviseRates(59.9, ALL).options).toContain(60);
  });

  it('drops 60 on a 30Hz panel', () => {
    const advice = adviseRates(30, ALL);
    expect(advice.options).toEqual([15, 20, 30]);
    expect(advice.recommended).toBe(30);
  });

  it('recommends the fastest offered rate', () => {
    expect(adviseRates(144, ALL).recommended).toBe(60);
    expect(adviseRates(60, ALL).recommended).toBe(60);
    expect(adviseRates(24, ALL).recommended).toBe(20);
  });

  it('never returns an empty list, even for an implausible reading', () => {
    const advice = adviseRates(1, ALL);
    expect(advice.options.length).toBeGreaterThan(0);
    expect(ALL).toContain(advice.recommended as (typeof ALL)[number]);
  });

  it('only ever recommends a rate it also offers', () => {
    for (const hz of [10, 24, 30, 48, 50, 60, 90, 120, 240]) {
      const advice = adviseRates(hz, ALL);
      expect(advice.options).toContain(advice.recommended);
    }
  });
});

describe('decodeCeilingFps', () => {
  it('counts the whole pool, not one worker', () => {
    // 8 workers at 100ms each is 80 decodes per second. Reporting 10 would tell
    // the user to slow the sender down by a factor of eight for no reason.
    expect(decodeCeilingFps(8, 100, 1000)).toBeCloseTo(80);
  });

  it('is capped by what the camera actually delivers', () => {
    expect(decodeCeilingFps(8, 100, 30)).toBe(30);
  });

  it('ignores an unknown camera rate rather than reporting zero', () => {
    expect(decodeCeilingFps(4, 50, 0)).toBeCloseTo(80);
  });

  it('returns zero before any measurement exists', () => {
    expect(decodeCeilingFps(8, 0, 30)).toBe(0);
    expect(decodeCeilingFps(0, 100, 30)).toBe(0);
  });

  it('reports a slow phone as slow', () => {
    // 2 workers at 400ms is 5fps: well under the 15fps floor, which is exactly
    // the case where the sender must be told not to play at 60.
    expect(decodeCeilingFps(2, 400, 30)).toBeCloseTo(5);
  });
});
