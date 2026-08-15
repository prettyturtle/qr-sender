/**
 * Wire-format constants. Anything here is part of the protocol contract between
 * sender and receiver, so changing a value requires a `PROTOCOL_VERSION` bump.
 *
 * Capacities were measured against the `qrcode` encoder rather than copied from
 * a table — see `src/core/__tests__/params.test.ts`, which fails if a dependency
 * upgrade changes them.
 */

export const PROTOCOL_VERSION = 1;

export const MAGIC_0 = 0x51; // 'Q'
export const MAGIC_1 = 0x53; // 'S'

export const HEADER_SIZE = 24;

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrProfile {
  /** QR symbol version (1-40). */
  version: number;
  ecc: QrEcc;
  /** Module count per side, for coaching/tiling math. */
  modules: number;
  /** Alphanumeric character capacity at this version/ECC. */
  chars: number;
  /** Bytes carried after base44 expansion. */
  frameBytes: number;
  /** Payload bytes per frame, after the fixed header. */
  blockSize: number;
}

function profile(version: number, ecc: QrEcc, modules: number, chars: number): QrProfile {
  const frameBytes = Math.floor(chars / 3) * 2 + (chars % 3 >= 2 ? 1 : 0);
  return { version, ecc, modules, chars, frameBytes, blockSize: frameBytes - HEADER_SIZE };
}

/** Ordered smallest-first. `V25_L` is the default; the others exist for adaptive downshift. */
export const QR_PROFILES: Record<string, QrProfile> = {
  V20_L: profile(20, 'L', 97, 1249),
  V25_L: profile(25, 'L', 117, 1853),
  V30_L: profile(30, 'L', 137, 2520),
};

export const DEFAULT_PROFILE = QR_PROFILES.V25_L;

/** Source symbols per segment. Constrained by `MIN_CAPTURE_RATE * N >= K`. */
export const DEFAULT_K = 96;

/** Total symbols per segment. GF(256) Cauchy construction requires K + R <= 256. */
export const DEFAULT_N = 255;

/**
 * Worst-case receiver capture rate (decode fps / playback fps) the schedule must
 * still complete in a single carousel cycle: iOS Safari 4fps against 10fps
 * playback. `K <= MIN_CAPTURE_RATE * N` follows from this.
 */
export const MIN_CAPTURE_RATE = 0.4;

/** Consecutive symbols emitted per segment before moving on, to amortise file reads. */
export const BURST = 8;

/** A manifest frame is emitted every Nth frame. 20 @ 10fps => visible within 2s, 5% overhead. */
export const MANIFEST_INTERVAL = 20;

/** Playback rates must divide 30 and 60 so each frame is held for >= 2 camera frames. */
export const PLAYBACK_FPS_OPTIONS = [10, 12] as const;
export const DEFAULT_PLAYBACK_FPS = 10;

/** Above this size the UI warns that the payload is outside the verified range. */
export const SOFT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Hard ceiling on what a receiver will allocate for an incoming stream.
 *
 * Every field in a frame header comes from whatever is on screen, and a receiver
 * sizes its buffer from `segCount * K * blockSize` the moment it sees the first
 * valid frame. At the maximum encodable values that product is roughly 47 GB, so
 * a single hostile QR would take the tab down. Nothing legitimate comes close:
 * 256 MB is already a multi-hour transfer.
 */
export const MAX_RECEIVE_BYTES = 256 * 1024 * 1024;

/** No QR profile carries more than this; larger values in a header are forged. */
export const MAX_BLOCK_SIZE = 4096;

/** Skip compression when it saves less than this fraction. */
export const MIN_COMPRESSION_GAIN = 0.05;

export const PBKDF2_ITERATIONS = 600_000;

/**
 * Upper bound accepted from an incoming manifest.
 *
 * The iteration count arrives from whatever is on screen, and the victim runs it
 * the moment they type a passphrase. At 1e10 the derivation never returns, and
 * there is no way to interrupt it — so it is capped at roughly 8x the value we
 * emit, which still admits any plausible future hardening by a real sender.
 */
export const MAX_PBKDF2_ITERATIONS = 5_000_000;

/** Longest filename and MIME string accepted from an envelope. */
export const MAX_NAME_LENGTH = 255;
export const MAX_MIME_LENGTH = 128;

/** Sentinel segment/symbol index marking a manifest frame. */
export const MANIFEST_INDEX = 0xffff;

export const FLAG_MANIFEST = 1 << 0;
export const FLAG_COMPRESSED = 1 << 1;
export const FLAG_ENCRYPTED = 1 << 2;
/** The frame carries its manifest inline and is the entire transfer. */
export const FLAG_INLINE = 1 << 3;

/**
 * Source symbols for a payload of `length` bytes.
 *
 * K is a ceiling, not a constant. Padding a 20-byte message out to 96 blocks
 * would broadcast 95 blocks of zeroes and make the receiver collect all of them
 * before it could finish — ten seconds to move twenty bytes. Sizing K to the
 * payload makes every transfer under one segment proportional to its actual
 * content, and `r_min * N >= K` still holds trivially because K only shrinks.
 */
export function chooseK(length: number, blockSize: number, maxK: number = DEFAULT_K): number {
  return Math.min(maxK, Math.max(1, Math.ceil(length / blockSize)));
}

export function assertParams(k: number, n: number): void {
  if (k < 1 || k > 255) throw new Error(`invalid K: ${k}`);
  if (n < k || n > 255) throw new Error(`invalid N: ${n} (K=${k})`);
  if (k + (n - k) > 256) throw new Error(`K + R exceeds GF(256) capacity`);
}
