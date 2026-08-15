import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_PLAYBACK_FPS, PLAYBACK_FPS_OPTIONS } from '../core/params.js';
import type { DetectorKind } from '../platform/detect.js';
import { detectLocale, type Locale } from './i18n.js';
import { QR_COLORS } from './palette.js';

export type PlaybackFps = (typeof PLAYBACK_FPS_OPTIONS)[number];
export type QrStyle = 'plain' | 'custom';

interface AppState {
  locale: Locale;
  setLocale: (locale: Locale) => void;

  playbackFps: PlaybackFps;
  setPlaybackFps: (fps: PlaybackFps) => void;

  /** null = auto-select the best available backend. */
  detectorPreference: DetectorKind | null;
  setDetectorPreference: (kind: DetectorKind | null) => void;

  /**
   * `plain` is black, square, and as dense as the screen allows — the fastest
   * the channel goes. `custom` is coloured and rounded, which only reads at a
   * lower module density, so it trades transfer speed for appearance.
   */
  qrStyle: QrStyle;
  setQrStyle: (style: QrStyle) => void;

  /** Module colour, used by `custom`. Rejected at draw time without enough contrast. */
  qrColor: string;
  setQrColor: (color: string) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      locale: detectLocale(),
      setLocale: (locale) => set({ locale }),

      playbackFps: DEFAULT_PLAYBACK_FPS,
      setPlaybackFps: (playbackFps) => set({ playbackFps }),

      detectorPreference: null,
      setDetectorPreference: (detectorPreference) => set({ detectorPreference }),

      qrStyle: 'plain',
      setQrStyle: (qrStyle) => set({ qrStyle }),

      qrColor: QR_COLORS[1].hex,
      setQrColor: (qrColor) => set({ qrColor }),
    }),
    {
      name: 'qr-sender-settings',
      version: 4,
      // Without this, a bumped version discards nothing but also migrates
      // nothing, and new fields silently arrive undefined for returning users.
      migrate: (persisted) => persisted as never,
    },
  ),
);
