/**
 * Systematic Cauchy Reed-Solomon over GF(256).
 *
 * The generator matrix is N x K:
 *   - rows `0 .. K-1`   : identity, so symbol `s < K` *is* source block `s`
 *   - rows `K .. N-1`   : Cauchy, `C[i][j] = 1 / ((K + i) XOR j)`
 *
 * The X set `{K..N-1}` and Y set `{0..K-1}` are disjoint integers, so every
 * square submatrix of C is non-singular. Selecting any K of the N rows yields
 * an invertible system: identity rows fix their own columns, and what remains
 * is a square submatrix of C. That is the MDS property this design depends on —
 * *any* K distinct symbols reconstruct the segment, which is why a receiver can
 * join the carousel at an arbitrary point and still finish with 1.0x overhead.
 *
 * Because the code is systematic, a receiver that lost nothing does no linear
 * algebra at all: the symbols are the file.
 */

import { gfInv, gfMulAddInto, gfMulTable } from './gf256.js';

export interface ReceivedSymbol {
  /** Symbol index within the segment: `< K` systematic, `>= K` repair. */
  sym: number;
  data: Uint8Array;
}

const rowCache = new Map<string, Uint8Array>();

/** Row `repairIdx` of the Cauchy submatrix, length K. */
export function cauchyRow(k: number, repairIdx: number): Uint8Array {
  const key = `${k}:${repairIdx}`;
  let row = rowCache.get(key);
  if (row === undefined) {
    row = new Uint8Array(k);
    const x = k + repairIdx;
    if (x > 255) throw new Error(`rs: repair index ${repairIdx} exceeds GF(256) with K=${k}`);
    for (let j = 0; j < k; j++) row[j] = gfInv((x ^ j) & 0xff);
    rowCache.set(key, row);
  }
  return row;
}

/**
 * Produce symbol `symIndex` of a segment.
 *
 * @param segment contiguous `k * blockSize` source buffer (zero-padded tail)
 * @param out     `blockSize` destination, overwritten
 */
export function encodeSymbol(
  segment: Uint8Array,
  k: number,
  blockSize: number,
  symIndex: number,
  out: Uint8Array,
): void {
  if (symIndex < k) {
    out.set(segment.subarray(symIndex * blockSize, (symIndex + 1) * blockSize));
    return;
  }
  out.fill(0);
  const row = cauchyRow(k, symIndex - k);
  for (let j = 0; j < k; j++) {
    const c = row[j];
    if (c === 0) continue;
    gfMulAddInto(out, segment.subarray(j * blockSize, (j + 1) * blockSize), c, blockSize);
  }
}

/**
 * Gauss-Jordan inversion over GF(256). `rows` is mutated. Returns null if singular,
 * which the Cauchy construction makes unreachable — the check is defensive only.
 */
export function invertMatrix(rows: Uint8Array[], size: number): Uint8Array[] | null {
  const inv: Uint8Array[] = [];
  for (let i = 0; i < size; i++) {
    const r = new Uint8Array(size);
    r[i] = 1;
    inv.push(r);
  }

  for (let col = 0; col < size; col++) {
    let pivot = -1;
    for (let r = col; r < size; r++) {
      if (rows[r][col] !== 0) {
        pivot = r;
        break;
      }
    }
    if (pivot < 0) return null;

    if (pivot !== col) {
      const tr = rows[pivot];
      rows[pivot] = rows[col];
      rows[col] = tr;
      const ti = inv[pivot];
      inv[pivot] = inv[col];
      inv[col] = ti;
    }

    const pv = rows[col][col];
    if (pv !== 1) {
      const t = gfMulTable(gfInv(pv));
      const rc = rows[col];
      const ic = inv[col];
      for (let j = 0; j < size; j++) {
        rc[j] = t[rc[j]];
        ic[j] = t[ic[j]];
      }
    }

    for (let r = 0; r < size; r++) {
      if (r === col) continue;
      const f = rows[r][col];
      if (f === 0) continue;
      const t = gfMulTable(f);
      const rr = rows[r];
      const ir = inv[r];
      const rc = rows[col];
      const ic = inv[col];
      for (let j = 0; j < size; j++) {
        rr[j] ^= t[rc[j]];
        ir[j] ^= t[ic[j]];
      }
    }
  }

  return inv;
}

/**
 * Recover the source blocks that were never received, writing them into `segment`.
 *
 * Only the missing columns are solved for, so a segment that lost two symbols
 * costs a 2x2 inversion rather than a KxK one. Returns false when there are not
 * enough repair symbols yet — the caller keeps collecting.
 */
export function recoverSegment(
  segment: Uint8Array,
  k: number,
  blockSize: number,
  present: Uint8Array,
  repairs: ReceivedSymbol[],
): boolean {
  const missing: number[] = [];
  for (let j = 0; j < k; j++) if (present[j] === 0) missing.push(j);

  const m = missing.length;
  if (m === 0) return true;
  if (repairs.length < m) return false;

  const chosen = repairs.slice(0, m);

  // rhs_t = repair_t - (contribution of the blocks we already have)
  const rhs: Uint8Array[] = [];
  for (let t = 0; t < m; t++) {
    const row = cauchyRow(k, chosen[t].sym - k);
    const acc = new Uint8Array(blockSize);
    acc.set(chosen[t].data.subarray(0, blockSize));
    for (let j = 0; j < k; j++) {
      if (present[j] === 0) continue;
      gfMulAddInto(acc, segment.subarray(j * blockSize, (j + 1) * blockSize), row[j], blockSize);
    }
    rhs.push(acc);
  }

  const a: Uint8Array[] = [];
  for (let t = 0; t < m; t++) {
    const row = cauchyRow(k, chosen[t].sym - k);
    const ar = new Uint8Array(m);
    for (let u = 0; u < m; u++) ar[u] = row[missing[u]];
    a.push(ar);
  }

  const b = invertMatrix(a, m);
  if (b === null) return false;

  for (let u = 0; u < m; u++) {
    const dest = segment.subarray(missing[u] * blockSize, (missing[u] + 1) * blockSize);
    dest.fill(0);
    for (let t = 0; t < m; t++) gfMulAddInto(dest, rhs[t], b[u][t], blockSize);
    present[missing[u]] = 1;
  }

  return true;
}
