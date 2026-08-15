/**
 * Transfer estimation.
 *
 * The sender cannot know what device is watching — the channel is one-way — and
 * decode rate varies by more than 2x across supported receivers. So the UI shows
 * a *range* rather than a single number that would be honest for exactly one
 * platform. Presenting 18 minutes to someone whose iPhone will take 36 is worse
 * than presenting "18-36".
 */

import { DEFAULT_K, MANIFEST_INTERVAL, SOFT_MAX_BYTES, type QrProfile } from '../core/params.js';

/** Manifest frames are interleaved, so useful frames are slightly fewer than displayed frames. */
export const MANIFEST_TAX = (MANIFEST_INTERVAL + 1) / MANIFEST_INTERVAL;

export interface ReceiverProfile {
  id: 'android' | 'desktop' | 'ios';
  /** Frames per second the receiver can decode — the real throughput limiter. */
  decodeFps: number;
}

export const RECEIVER_PROFILES: ReceiverProfile[] = [
  { id: 'android', decodeFps: 8 },
  { id: 'desktop', decodeFps: 6 },
  { id: 'ios', decodeFps: 4 },
];

export interface TransferEstimate {
  payloadBytes: number;
  segCount: number;
  symbols: number;
  /** Seconds per receiver profile, fastest first. */
  seconds: Record<ReceiverProfile['id'], number>;
  fastestSeconds: number;
  slowestSeconds: number;
  /** Bytes per second for the fastest supported receiver. */
  peakGoodput: number;
  overSoftLimit: boolean;
}

export function estimateTransfer(
  payloadBytes: number,
  profile: QrProfile,
  k: number = DEFAULT_K,
): TransferEstimate {
  const segmentBytes = k * profile.blockSize;
  const segCount = Math.max(1, Math.ceil(payloadBytes / segmentBytes));
  const symbols = segCount * k;

  const seconds = {} as Record<ReceiverProfile['id'], number>;
  for (const r of RECEIVER_PROFILES) {
    seconds[r.id] = (symbols * MANIFEST_TAX) / r.decodeFps;
  }

  const values = RECEIVER_PROFILES.map((r) => seconds[r.id]);
  const fastestSeconds = Math.min(...values);
  const slowestSeconds = Math.max(...values);

  return {
    payloadBytes,
    segCount,
    symbols,
    seconds,
    fastestSeconds,
    slowestSeconds,
    peakGoodput: payloadBytes / fastestSeconds,
    overSoftLimit: payloadBytes > SOFT_MAX_BYTES,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}초`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}시간` : `${h}시간 ${rem}분`;
}

export function formatDurationEn(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} hr` : `${h} hr ${rem} min`;
}
