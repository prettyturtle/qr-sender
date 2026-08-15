import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_PLAYBACK_FPS, PLAYBACK_FPS_OPTIONS } from '../core/params.js';
import type { DetectorKind } from '../platform/detect.js';
import { detectLocale, type Locale } from './i18n.js';

export type PlaybackFps = (typeof PLAYBACK_FPS_OPTIONS)[number];

interface AppState {
  locale: Locale;
  setLocale: (locale: Locale) => void;

  playbackFps: PlaybackFps;
  setPlaybackFps: (fps: PlaybackFps) => void;

  /** null = auto-select the best available backend. */
  detectorPreference: DetectorKind | null;
  setDetectorPreference: (kind: DetectorKind | null) => void;
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
    }),
    { name: 'qr-sender-settings', version: 1 },
  ),
);
