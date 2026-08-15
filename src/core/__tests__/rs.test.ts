import { describe, expect, it } from 'vitest';
import { gfDiv, gfInv, gfMul } from '../gf256.js';
import { cauchyRow, encodeSymbol, invertMatrix, recoverSegment, type ReceivedSymbol } from '../rs.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

describe('GF(256)', () => {
  it('is a field: a/b*b === a for all non-zero b', () => {
    for (let a = 0; a < 256; a++) {
      for (let b = 1; b < 256; b++) {
        expect(gfMul(gfDiv(a, b), b)).toBe(a);
      }
    }
  });

  it('inverse is exact', () => {
    for (let a = 1; a < 256; a++) expect(gfMul(a, gfInv(a))).toBe(1);
  });

  it('multiplication is commutative and distributive', () => {
    const r = rng(7);
    for (let i = 0; i < 5000; i++) {
      const a = Math.floor(r() * 256);
      const b = Math.floor(r() * 256);
      const c = Math.floor(r() * 256);
      expect(gfMul(a, b)).toBe(gfMul(b, a));
      expect(gfMul(a, b ^ c)).toBe(gfMul(a, b) ^ gfMul(a, c));
    }
  });
});

describe('Cauchy matrix', () => {
  it('never contains a zero coefficient', () => {
    const k = 96;
    for (let i = 0; i < 255 - k; i++) {
      const row = cauchyRow(k, i);
      for (let j = 0; j < k; j++) expect(row[j]).not.toBe(0);
    }
  });

  it('every square submatrix is invertible', () => {
    const k = 32;
    const r = rng(11);
    for (let trial = 0; trial < 200; trial++) {
      const size = 1 + Math.floor(r() * 8);
      const rowIdx = new Set<number>();
      const colIdx = new Set<number>();
      while (rowIdx.size < size) rowIdx.add(Math.floor(r() * (255 - k)));
      while (colIdx.size < size) colIdx.add(Math.floor(r() * k));
      const rows = [...rowIdx].map((ri) => {
        const full = cauchyRow(k, ri);
        return Uint8Array.from([...colIdx].map((cj) => full[cj]));
      });
      expect(invertMatrix(rows, size)).not.toBeNull();
    }
  });

  it('inverse times original is the identity', () => {
    const size = 12;
    const k = 64;
    const orig: Uint8Array[] = [];
    for (let t = 0; t < size; t++) orig.push(cauchyRow(k, t).slice(0, size));
    const copy = orig.map((r) => r.slice());
    const inv = invertMatrix(copy, size)!;
    expect(inv).not.toBeNull();
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        let acc = 0;
        for (let t = 0; t < size; t++) acc ^= gfMul(orig[i][t], inv[t][j]);
        expect(acc).toBe(i === j ? 1 : 0);
      }
    }
  });
});

describe('systematic RS round-trip', () => {
  const k = 96;
  const n = 255;
  const blockSize = 1211;

  function makeSegment(seed: number): Uint8Array {
    const r = rng(seed);
    const seg = new Uint8Array(k * blockSize);
    for (let i = 0; i < seg.length; i++) seg[i] = Math.floor(r() * 256);
    return seg;
  }

  it('systematic symbols are the source blocks verbatim', () => {
    const seg = makeSegment(1);
    const out = new Uint8Array(blockSize);
    for (const s of [0, 1, 47, k - 1]) {
      encodeSymbol(seg, k, blockSize, s, out);
      expect(out).toEqual(seg.subarray(s * blockSize, (s + 1) * blockSize));
    }
  });

  it('recovers from any K of N symbols', () => {
    const seg = makeSegment(2);
    const r = rng(99);

    for (let trial = 0; trial < 25; trial++) {
      // Choose an arbitrary K-subset of the N symbol indices.
      const all = Array.from({ length: n }, (_, i) => i);
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(r() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
      }
      const subset = all.slice(0, k);

      const recovered = new Uint8Array(k * blockSize);
      const present = new Uint8Array(k);
      const repairs: ReceivedSymbol[] = [];

      for (const s of subset) {
        const data = new Uint8Array(blockSize);
        encodeSymbol(seg, k, blockSize, s, data);
        if (s < k) {
          recovered.set(data, s * blockSize);
          present[s] = 1;
        } else {
          repairs.push({ sym: s, data });
        }
      }

      expect(recoverSegment(recovered, k, blockSize, present, repairs)).toBe(true);
      expect(recovered).toEqual(seg);
    }
  });

  it('reports failure when fewer than K symbols are available', () => {
    const seg = makeSegment(3);
    const recovered = new Uint8Array(k * blockSize);
    const present = new Uint8Array(k);
    const repairs: ReceivedSymbol[] = [];

    // 90 systematic + 3 repair = 93 < 96
    for (let s = 0; s < 90; s++) {
      const data = new Uint8Array(blockSize);
      encodeSymbol(seg, k, blockSize, s, data);
      recovered.set(data, s * blockSize);
      present[s] = 1;
    }
    for (let s = k; s < k + 3; s++) {
      const data = new Uint8Array(blockSize);
      encodeSymbol(seg, k, blockSize, s, data);
      repairs.push({ sym: s, data });
    }

    expect(recoverSegment(recovered, k, blockSize, present, repairs)).toBe(false);
  });

  it('is a no-op when nothing is missing', () => {
    const seg = makeSegment(4);
    const recovered = seg.slice();
    const present = new Uint8Array(k).fill(1);
    expect(recoverSegment(recovered, k, blockSize, present, [])).toBe(true);
    expect(recovered).toEqual(seg);
  });

  it('handles the worst case: every systematic symbol lost', () => {
    const seg = makeSegment(5);
    const recovered = new Uint8Array(k * blockSize);
    const present = new Uint8Array(k);
    const repairs: ReceivedSymbol[] = [];
    for (let s = k; s < k + k; s++) {
      const data = new Uint8Array(blockSize);
      encodeSymbol(seg, k, blockSize, s, data);
      repairs.push({ sym: s, data });
    }
    expect(recoverSegment(recovered, k, blockSize, present, repairs)).toBe(true);
    expect(recovered).toEqual(seg);
  });
});
