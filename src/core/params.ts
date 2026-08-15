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

/** Declared early: the capture-rate constants below are derived from it. */
const DEFAULT_PLAYBACK_FPS_VALUE = 10;

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
  V15_L: profile(15, 'L', 77, 758),
  V20_L: profile(20, 'L', 97, 1249),
  V25_L: profile(25, 'L', 117, 1853),
  V30_L: profile(30, 'L', 137, 2520),
  V40_L: profile(40, 'L', 177, 4296),
};

/** Smallest first — `chooseProfile` walks this and takes the largest that fits. */
export const PROFILE_LADDER: readonly QrProfile[] = [
  QR_PROFILES.V15_L,
  QR_PROFILES.V20_L,
  QR_PROFILES.V25_L,
  QR_PROFILES.V30_L,
  QR_PROFILES.V40_L,
];

export const DEFAULT_PROFILE = QR_PROFILES.V25_L;

export const QUIET_ZONE_MODULES = 4;

/**
 * CSS pixels per module the shipping configuration actually achieves: a phone in
 * portrait gives the stage about 318 CSS px, and V25 at 125 total modules works
 * there today. Used as the calibration floor so no device is ever downgraded
 * below what is already known to decode. Holding this constant keeps the *physical*
 * module size identical as the version climbs, so a camera at the same distance
 * resolves it just as well — the symbol simply grows.
 */
const MIN_CSS_PX_PER_MODULE = 2.5;

/** Below three device pixels a module degrades into LCD subpixel and moire noise. */
const MIN_DEVICE_PX_PER_MODULE = 3;

/**
 * Largest QR version the sending screen can display without shrinking modules
 * past what is known to work.
 *
 * This is the single biggest throughput lever: V40 carries 2,840 payload bytes
 * against V25's 1,211. Unlike raising the frame rate it costs nothing on the
 * receiving side — the capture-rate constraint and the two-camera-frame hold are
 * both untouched, because the number of frames per second does not change.
 *
 * The sender cannot know what camera is watching, so screen size is only a
 * proxy. Guessing high degrades decode rate but never correctness: the carousel
 * simply takes longer.
 */
export function chooseProfile(stageCssSize: number, devicePixelRatio = 1): QrProfile {
  let best = PROFILE_LADDER[0];
  for (const p of PROFILE_LADDER) {
    const total = p.modules + QUIET_ZONE_MODULES * 2;
    const cssPerModule = stageCssSize / total;
    const devicePerModule = Math.floor((stageCssSize * devicePixelRatio) / total);
    if (cssPerModule >= MIN_CSS_PX_PER_MODULE && devicePerModule >= MIN_DEVICE_PX_PER_MODULE) best = p;
  }
  return best;
}

/** Source symbols per segment. Constrained by `MIN_CAPTURE_RATE * N >= K`. */
export const DEFAULT_K = 96;

/** Total symbols per segment. GF(256) Cauchy construction requires K + R <= 256. */
export const DEFAULT_N = 255;

/** Decode rate of the slowest supported receiver: iOS Safari on the wasm decoder. */
export const SLOWEST_DECODE_FPS = 4;

/**
 * Worst-case receiver capture rate at the default playback rate. Kept as a named
 * constant because the whole schedule rests on `MIN_CAPTURE_RATE * N >= K`.
 */
export const MIN_CAPTURE_RATE = SLOWEST_DECODE_FPS / DEFAULT_PLAYBACK_FPS_VALUE;

/**
 * Ceiling on K for a given playback rate.
 *
 * Capture rate is `slowestDecodeFps / playbackFps`, so displaying faster makes
 * the slowest receiver capture a *smaller* fraction of each carousel cycle. K
 * has to come down with it or that receiver stops finishing in one pass. K
 * travels in the frame header, so this costs nothing on the wire.
 */
export function maxKForFps(playbackFps: number): number {
  return Math.max(1, Math.floor((SLOWEST_DECODE_FPS / playbackFps) * DEFAULT_N));
}

/** Consecutive symbols emitted per segment before moving on, to amortise file reads. */
export const BURST = 8;

/**
 * A manifest frame is emitted every Nth frame. At 40 the overhead is 2.4% and a
 * late-joining receiver still learns the filename within ~4s, which is well
 * inside the time it takes to steady a camera.
 */
export const MANIFEST_INTERVAL = 40;

/**
 * Playback rates must divide 30 and 60 so each frame is held for at least two
 * camera frames. 15 is the arithmetic limit on a 30fps camera and leaves no
 * margin — a camera that drops to 24fps in low light violates the hold — so it
 * is offered but not the default.
 */
export const PLAYBACK_FPS_OPTIONS = [10, 12, 15] as const;
export const DEFAULT_PLAYBACK_FPS = DEFAULT_PLAYBACK_FPS_VALUE;

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
