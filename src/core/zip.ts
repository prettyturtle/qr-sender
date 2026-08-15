/**
 * ZIP central-directory reader — listing only, no decompression.
 *
 * A received archive is otherwise a completely opaque blob: the viewer can say
 * how many bytes arrived and nothing about what they are. Reading the central
 * directory is a few dozen lines and turns that into a file list, which is
 * usually all anyone wants before deciding whether to save it.
 *
 * Everything here is bounds-checked against hostile input — the archive came off
 * a screen, and an End-of-Central-Directory record can claim any offset it likes.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/** EOCD is 22 bytes plus a comment of at most 65535. */
const MAX_EOCD_SEARCH = 22 + 0xffff;

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  directory: boolean;
}

export interface ZipListing {
  entries: ZipEntry[];
  /** True when the archive declares more entries than the directory yielded. */
  truncated: boolean;
  zip64: boolean;
}

export function readZipListing(bytes: Uint8Array, maxEntries = 2000): ZipListing | null {
  if (bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  const from = Math.max(0, bytes.length - MAX_EOCD_SEARCH);
  for (let i = bytes.length - 22; i >= from; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const declared = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);

  const zip64 =
    eocd >= 20 &&
    (view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE ||
      directoryOffset === 0xffffffff ||
      declared === 0xffff);

  if (directoryOffset >= bytes.length) return { entries: [], truncated: true, zip64 };

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const entries: ZipEntry[] = [];
  const end = Math.min(bytes.length, directoryOffset + directorySize || bytes.length);

  let p = directoryOffset;
  while (p + 46 <= end && entries.length < maxEntries) {
    if (view.getUint32(p, true) !== CENTRAL_SIGNATURE) break;
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const nameStart = p + 46;
    if (nameStart + nameLen > bytes.length) break;

    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    entries.push({
      name,
      compressedSize,
      uncompressedSize,
      directory: name.endsWith('/'),
    });
    p = nameStart + nameLen + extraLen + commentLen;
  }

  return { entries, truncated: entries.length < declared, zip64 };
}
