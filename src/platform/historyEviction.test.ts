import { describe, expect, it } from 'vitest';
import { HISTORY_MAX_BYTES, planEviction } from './storage.js';

const MB = 1024 * 1024;

/** Newest first, the order `listHistory` actually returns. */
function entries(...sizes: number[]): { receivedAt: number; size: number }[] {
  return sizes.map((size, i) => ({ receivedAt: 1000 - i, size }));
}

describe('planEviction', () => {
  it('evicts nothing while there is room', () => {
    const plan = planEviction(entries(10 * MB, 10 * MB), 10 * MB);
    expect(plan).toEqual({ reject: false, evict: [] });
  });

  it('evicts oldest first, and only as many as it needs', () => {
    // Three 80MB entries plus an incoming 80MB is 320MB against a 200MB cap:
    // two must go, and the third must survive.
    const existing = entries(80 * MB, 80 * MB, 80 * MB);
    const plan = planEviction(existing, 80 * MB);
    expect(plan.reject).toBe(false);
    // 998 and 999 are the two oldest of {1000, 999, 998}.
    expect(plan.evict).toEqual([998, 999]);
  });

  it('rejects a payload larger than the entire budget instead of emptying history', () => {
    // Wiping everything a user chose to keep, to make room for one file they
    // never asked to keep, is the wrong trade — so the incoming one loses.
    const existing = entries(1 * MB, 1 * MB);
    const plan = planEviction(existing, HISTORY_MAX_BYTES + 1);
    expect(plan.reject).toBe(true);
    expect(plan.evict).toEqual([]);
  });

  it('accepts a payload exactly at the cap by clearing what it must', () => {
    const existing = entries(50 * MB);
    const plan = planEviction(existing, HISTORY_MAX_BYTES);
    expect(plan.reject).toBe(false);
    expect(plan.evict).toEqual([1000]);
  });

  it('is not fooled by the newest-first order it is handed', () => {
    // `listHistory` sorts newest first; evicting in that order would delete the
    // most recent transfer and keep the stale one.
    const newestFirst = [
      { receivedAt: 3000, size: 150 * MB },
      { receivedAt: 1000, size: 150 * MB },
    ];
    expect(planEviction(newestFirst, 10 * MB).evict).toEqual([1000]);
  });

  it('always leaves the total within the cap', () => {
    const sizes = [90, 5, 60, 30, 12, 45].map((n) => n * MB);
    for (const incoming of [1 * MB, 40 * MB, 120 * MB, 199 * MB]) {
      const existing = entries(...sizes);
      const plan = planEviction(existing, incoming);
      expect(plan.reject).toBe(false);
      const kept = existing
        .filter((e) => !plan.evict.includes(e.receivedAt))
        .reduce((sum, e) => sum + e.size, 0);
      expect(kept + incoming).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
    }
  });

  it('handles an empty history', () => {
    expect(planEviction([], 5 * MB)).toEqual({ reject: false, evict: [] });
  });
});
