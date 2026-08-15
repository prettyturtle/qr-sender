/**
 * GF(2^8) arithmetic with primitive polynomial 0x11D (x^8 + x^4 + x^3 + x^2 + 1).
 *
 * Addition and subtraction are both XOR. Multiplication goes through log/exp
 * tables; hot loops use per-coefficient 256-entry lookup tables so the inner
 * operation is `dst[i] ^= table[src[i]]` — one load and one xor per byte.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('gf256: division by zero');
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

export function gfInv(a: number): number {
  if (a === 0) throw new Error('gf256: inverse of zero');
  return EXP[255 - LOG[a]];
}

const MUL_TABLES: Array<Uint8Array | undefined> = new Array(256);

/** 256-entry table `t` such that `t[x] === gfMul(c, x)`. Cached per coefficient. */
export function gfMulTable(c: number): Uint8Array {
  let t = MUL_TABLES[c];
  if (t === undefined) {
    t = new Uint8Array(256);
    if (c !== 0) {
      const lc = LOG[c];
      for (let i = 1; i < 256; i++) t[i] = EXP[lc + LOG[i]];
    }
    MUL_TABLES[c] = t;
  }
  return t;
}

/** `dst[i] ^= gfMul(c, src[i])` over `len` bytes. */
export function gfMulAddInto(dst: Uint8Array, src: Uint8Array, c: number, len: number): void {
  if (c === 0) return;
  if (c === 1) {
    for (let i = 0; i < len; i++) dst[i] ^= src[i];
    return;
  }
  const t = gfMulTable(c);
  for (let i = 0; i < len; i++) dst[i] ^= t[src[i]];
}
