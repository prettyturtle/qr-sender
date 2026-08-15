/** CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320). */

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[i] = c >>> 0;
}

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) c = (TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
