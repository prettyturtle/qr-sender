/**
 * 24-byte frame header. Big-endian.
 *
 *   0   magic     2   'Q' 'S'
 *   2   version   1
 *   3   flags     1   bit0 manifest | bit1 compressed | bit2 encrypted
 *   4   streamId  4   random per transmission
 *   8   segIndex  2   0xFFFF on manifest frames
 *  10   symIndex  2   0xFFFF on manifest frames
 *  12   segCount  2
 *  14   K         1
 *  15   N         1
 *  16   blockSize 2
 *  18   reserved  2
 *  20   crc32     4   over bytes 0..19 followed by the payload
 *
 * `symIndex` being explicit is what removes every synchronisation contract
 * between sender and receiver: the sender may emit in any order, reshuffle
 * between passes, or change its schedule in a later release without breaking
 * older receivers.
 */

import { crc32 } from './crc32.js';
import {
  FLAG_INLINE,
  FLAG_MANIFEST,
  HEADER_SIZE,
  MAGIC_0,
  MAGIC_1,
  MANIFEST_INDEX,
  MAX_BLOCK_SIZE,
  PROTOCOL_VERSION,
} from './params.js';

export interface FrameHeader {
  version: number;
  flags: number;
  streamId: number;
  segIndex: number;
  symIndex: number;
  segCount: number;
  k: number;
  n: number;
  blockSize: number;
}

export interface ParsedFrame {
  header: FrameHeader;
  payload: Uint8Array;
  isManifest: boolean;
  /** The frame carries its own manifest and is the whole transfer. */
  isInline: boolean;
}

export function packFrame(header: FrameHeader, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(HEADER_SIZE + payload.length);
  const view = new DataView(buf.buffer);
  buf[0] = MAGIC_0;
  buf[1] = MAGIC_1;
  buf[2] = header.version;
  buf[3] = header.flags;
  view.setUint32(4, header.streamId >>> 0);
  view.setUint16(8, header.segIndex);
  view.setUint16(10, header.symIndex);
  view.setUint16(12, header.segCount);
  buf[14] = header.k;
  buf[15] = header.n;
  view.setUint16(16, header.blockSize);
  view.setUint16(18, 0);
  buf.set(payload, HEADER_SIZE);
  view.setUint32(20, crc32Frame(buf));
  return buf;
}

/** CRC input is bytes 0..19 followed by the payload; the CRC field itself is excluded. */
function crc32Frame(buf: Uint8Array): number {
  const head = crc32(buf, 0, 20, 0);
  return crc32(buf, HEADER_SIZE, buf.length, head);
}

/**
 * Parse and validate. Returns null for anything malformed — a corrupted frame is
 * simply dropped and the carousel supplies another.
 */
export function unpackFrame(buf: Uint8Array): ParsedFrame | null {
  if (buf.length < HEADER_SIZE) return null;
  if (buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1) return null;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(20) !== crc32Frame(buf)) return null;

  const header: FrameHeader = {
    version: buf[2],
    flags: buf[3],
    streamId: view.getUint32(4),
    segIndex: view.getUint16(8),
    symIndex: view.getUint16(10),
    segCount: view.getUint16(12),
    k: buf[14],
    n: buf[15],
    blockSize: view.getUint16(16),
  };

  if (header.version !== PROTOCOL_VERSION) return null;
  if (header.k < 1 || header.n < header.k) return null;
  if (header.blockSize < 1 || header.blockSize > MAX_BLOCK_SIZE) return null;
  if (header.segCount < 1) return null;
  if (buf.length !== HEADER_SIZE + header.blockSize) return null;

  const isManifest = (header.flags & FLAG_MANIFEST) !== 0;
  const isInline = (header.flags & FLAG_INLINE) !== 0;
  if (isManifest && isInline) return null;

  if (isManifest) {
    if (header.segIndex !== MANIFEST_INDEX || header.symIndex !== MANIFEST_INDEX) return null;
  } else {
    if (header.segIndex >= header.segCount) return null;
    if (header.symIndex >= header.n) return null;
    // A single-frame transfer is exactly one block at index zero; anything else
    // claiming the flag is malformed.
    if (isInline && (header.segCount !== 1 || header.k !== 1 || header.segIndex !== 0 || header.symIndex !== 0)) {
      return null;
    }
  }

  return { header, payload: buf.subarray(HEADER_SIZE), isManifest, isInline };
}
