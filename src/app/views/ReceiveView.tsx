/**
 * Receiving screen: camera -> base44 -> Receiver -> payload -> viewer.
 *
 * Two constraints shape the structure more than anything else:
 *
 *  - **The decode loop must not be starved by React.** `onText` fires as fast as
 *    the detector can produce results; touching state there would re-render on
 *    every symbol. So the hot path only mutates refs, and a 200ms publisher
 *    interval copies the receiver's state into React at a human-visible rate.
 *  - **ETA must come from what this receiver actually achieves.** The sender
 *    shows a range across device classes precisely because it cannot know who is
 *    watching. Here we do know, so the estimate divides by the measured rate at
 *    which useful symbols land — not by the decode rate, which counts duplicates
 *    and manifest frames and would run optimistic.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { decode as base44Decode } from '../../core/base44.js';
import { sanitizeFilename } from '../../core/filename.js';
import type { Manifest } from '../../core/manifest.js';
import { openPayload, WrongPassphraseError } from '../../core/payload.js';
import { Receiver, type IntegrityState, type ReceiverProgress } from '../../core/receiver.js';
import { CameraPermissionError, Scanner, type ScannerStats } from '../../platform/camera.js';
import { deleteTransfer, listTransfers, saveTransfer, type StoredTransfer } from '../../platform/storage.js';
import { acquireWakeLock } from '../../platform/wakeLock.js';

import { focusQuality, type FocusQuality } from '../../platform/sharpness.js';
import { formatDuration, useT, type MessageKey } from '../i18n.js';
import { useAppStore } from '../store.js';
import { Viewer } from './Viewer.js';

type Phase = 'idle' | 'scanning' | 'done';

interface OpenedFile {
  name: string;
  mime: string;
  data: Uint8Array;
}

/** How often receiver state is copied into React. 5Hz is well past legible and cheap. */
const PUBLISH_MS = 200;
const SAVE_INTERVAL_MS = 5000;
const SAVE_RATIO_STEP = 0.02;
/** No successful read for this long means the user needs different advice, not a number. */
const SILENT_MS = 3000;
const FPS_WINDOW_MS = 3000;
/**
 * Window for the *useful symbol* rate that drives the ETA.
 *
 * Decode rate is the wrong divisor: the sender displays 10-12 fps, so a receiver
 * decoding faster than that re-reads the same symbol and reports a rate well
 * above the rate at which the transfer actually advances. Duplicates, manifest
 * frames and frames from a foreign stream all inflate it too. Measuring how fast
 * `progress.received` climbs is the ground truth, and it needs no fudge factor.
 */
const RATE_WINDOW_MS = 6000;
/** Below this the rate estimate is too noisy to show a number for. */
const MIN_RATE_SPAN_MS = 1500;

const EMPTY_PROGRESS: ReceiverProgress = {
  received: 0,
  needed: 0,
  ratio: 0,
  segmentsDone: 0,
  segCount: 0,
};

function permissionKey(err: unknown): MessageKey {
  if (err instanceof CameraPermissionError) {
    switch (err.reason) {
      case 'denied':
        return 'recv.permission.denied';
      case 'notfound':
        return 'recv.permission.notfound';
      case 'insecure':
        return 'recv.permission.insecure';
      default:
        return 'recv.permission.unknown';
    }
  }
  return 'recv.permission.unknown';
}

interface Coaching {
  badgeClass: string;
  qualityKey: MessageKey;
  coachKey: MessageKey;
}

/**
 * Above this ratio of decode rate to useful-symbol rate, the receiver is
 * finishing every frame it is shown and the sender's playback rate is what caps
 * the transfer. The channel carries no feedback, so the person holding the
 * camera becomes it.
 */
const SENDER_BOUND_RATIO = 1.6;

/** Fraction of this device's best observed rate that still counts as good aim. */
const GOOD_RATIO = 0.7;
/** No device is aiming well below this, however slow its ceiling. */
const GOOD_FLOOR_FPS = 2;

/**
 * Advice is keyed on decode rate rather than on progress: progress tells the user
 * where they are, decode rate tells them what to change.
 *
 * The thresholds are *relative to this device's own best rate*, not absolute.
 * An absolute 6fps bar would tell every iPhone it was aiming badly even when
 * perfectly aligned — iOS Safari tops out near 4fps because it decodes in wasm.
 * Comparing against the best rate seen this session self-calibrates: 4fps is
 * excellent on a device whose ceiling is 4, and mediocre on one that hits 8.
 */
function coachingFor(
  hasSignal: boolean,
  fps: number,
  peakFps: number,
  silent: boolean,
  symbolRate: number,
  focus: FocusQuality,
  fixedFocus: boolean,
): Coaching {
  // Focus outranks everything else that could be said. A defocused symbol is
  // not a slow transfer, it is no transfer, and every other piece of advice —
  // hold steady, move closer, avoid glare — is wasted while it stands.
  if (focus === 'poor') {
    return {
      badgeClass: 'badge warn',
      qualityKey: 'recv.quality.blurry',
      coachKey: fixedFocus ? 'recv.coach.fixedFocus' : 'recv.coach.focus',
    };
  }
  if (!hasSignal) return { badgeClass: 'badge', qualityKey: 'recv.waiting', coachKey: 'recv.aim' };
  if (silent) return { badgeClass: 'badge', qualityKey: 'recv.quality.none', coachKey: 'recv.coach.steady' };
  // Sharp enough to see a symbol but not a dense one: the fix is on the sending
  // side, and no amount of aiming here will substitute for it.
  if (focus === 'fair' && fps < GOOD_FLOOR_FPS) {
    return { badgeClass: 'badge warn', qualityKey: 'recv.quality.slow', coachKey: 'recv.coach.lowerDensity' };
  }
  // Decoding far more frames than are useful means the symbols on screen are
  // being re-read: this device has headroom and the sender does not.
  if (symbolRate > 1 && fps > symbolRate * SENDER_BOUND_RATIO) {
    return { badgeClass: 'badge ok', qualityKey: 'recv.quality.good', coachKey: 'recv.coach.senderSlow' };
  }
  if (fps >= GOOD_FLOOR_FPS && fps >= peakFps * GOOD_RATIO) {
    return { badgeClass: 'badge ok', qualityKey: 'recv.quality.good', coachKey: 'recv.coach.ok' };
  }
  if (fps >= 1) return { badgeClass: 'badge warn', qualityKey: 'recv.quality.slow', coachKey: 'recv.coach.closer' };
  return { badgeClass: 'badge warn', qualityKey: 'recv.quality.slow', coachKey: 'recv.coach.glare' };
}

export function ReceiveView(): JSX.Element {
  const t = useT();
  const locale = useAppStore((s) => s.locale);
  const detectorPreference = useAppStore((s) => s.detectorPreference);

  const videoRef = useRef<HTMLVideoElement>(null);
  const receiverRef = useRef<Receiver | null>(null);
  const scannerRef = useRef<Scanner | null>(null);
  const aliveRef = useRef(true);
  const finishingRef = useRef(false);

  // Decode-rate telemetry. `Scanner` reports roughly once a second; a 3s window
  // stops a single unlucky second from flipping the coaching message.
  const samplesRef = useRef<Array<{ at: number; fps: number }>>([]);
  const lastReadAtRef = useRef(0);
  /** (timestamp, symbols accepted) pairs — see RATE_WINDOW_MS. */
  const rateSamplesRef = useRef<Array<{ at: number; received: number }>>([]);
  const statsRef = useRef<ScannerStats | null>(null);

  const lastSaveAtRef = useRef(0);
  const lastSaveRatioRef = useRef(0);

  const foreignIdRef = useRef<number | null>(null);
  const foreignDismissedRef = useRef(false);

  const payloadRef = useRef<Uint8Array | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [resumable, setResumable] = useState<StoredTransfer | null>(null);
  const [progress, setProgress] = useState<ReceiverProgress>(EMPTY_PROGRESS);
  const [decodeFps, setDecodeFps] = useState(0);
  /** Best rate this device has reached, the reference the coaching compares against. */
  const [peakFps, setPeakFps] = useState(0);
  const [sharpness, setSharpness] = useState(-1);
  const [fixedFocus, setFixedFocus] = useState(false);
  /** Useful symbols per second, measured. 0 means "not enough data yet". */
  const [symbolRate, setSymbolRate] = useState(0);
  const [engine, setEngine] = useState('');
  const [silent, setSilent] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [otherStream, setOtherStream] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const [cameraError, setCameraError] = useState<MessageKey | null>(null);

  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [integrity, setIntegrity] = useState<IntegrityState>('unknown');
  const [opened, setOpened] = useState<OpenedFile | null>(null);

  const [passphrase, setPassphrase] = useState('');
  const [deriving, setDeriving] = useState(false);
  const [openError, setOpenError] = useState<MessageKey | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'idle') return;
    let cancelled = false;
    void listTransfers().then((all) => {
      if (cancelled || !aliveRef.current) return;
      setResumable(all[0] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const finish = useCallback((r: Receiver): void => {
    if (finishingRef.current) return;
    finishingRef.current = true;

    scannerRef.current?.stop();
    scannerRef.current = null;

    const m = r.manifest;
    if (m === null) return;
    // `payload()` is a view onto the receiver's buffer, which is never rewritten
    // in place — `reset()` allocates a fresh one — so no copy is needed here.
    const payload = r.payload();
    payloadRef.current = payload;

    if (r.streamId !== null) void deleteTransfer(r.streamId);
    if (typeof navigator.vibrate === 'function') navigator.vibrate([120, 60, 120]);

    setManifest(m);
    setIntegrity(r.verifyIntegrity());
    setPhase('done');

    if (m.encrypted) return;
    void openPayload(payload, m)
      .then((env) => {
        if (!aliveRef.current) return;
        setOpened({ name: env.name, mime: env.mime, data: env.data });
      })
      .catch(() => {
        if (aliveRef.current) setOpenError('recv.mismatch');
      });
  }, []);

  const handleText = useCallback((text: string): boolean => {
    const r = receiverRef.current;
    if (r === null) return false;
    const bytes = base44Decode(text);
    if (bytes === null) return false;

    const result = r.ingest(bytes);
    // A foreign or duplicate frame still proves the camera is reading, which is
    // what the silence timer is actually asking about. The foreign stream itself
    // is picked up from `receiver.foreignStreamId` by the publisher.
    if (result !== 'invalid') lastReadAtRef.current = Date.now();
    // Only frames from *this* transfer are worth aiming the crop at — the
    // sender's screen also carries a static onboarding QR.
    return result === 'ok' || result === 'duplicate' || result === 'manifest';
  }, []);

  const handleStats = useCallback((stats: ScannerStats): void => {
    samplesRef.current.push({ at: Date.now(), fps: stats.decodeFps });
    statsRef.current = stats;
  }, []);

  // Publisher: the only place receiver state crosses into React.
  useEffect(() => {
    if (phase !== 'scanning') return;
    const id = window.setInterval(() => {
      const r = receiverRef.current;
      if (r === null) return;

      const now = Date.now();
      const p = r.progress;
      setProgress((prev) =>
        prev.received === p.received && prev.needed === p.needed && prev.segmentsDone === p.segmentsDone
          ? prev
          : p,
      );

      const raw = r.manifest?.name;
      const name = raw === undefined ? null : sanitizeFilename(raw);
      setFileName((prev) => (prev === name ? prev : name));

      const samples = samplesRef.current.filter((s) => now - s.at <= FPS_WINDOW_MS);
      samplesRef.current = samples;
      const avg = samples.length === 0 ? 0 : samples.reduce((sum, s) => sum + s.fps, 0) / samples.length;
      setDecodeFps((prev) => (Math.abs(prev - avg) < 0.05 ? prev : avg));
      setPeakFps((prev) => (avg > prev ? avg : prev));

      const hw = statsRef.current;
      const label =
        hw === null
          ? ''
          : `${hw.detector === 'barcode-detector' ? 'native' : 'wasm'} ×${hw.concurrency}` +
            (hw.cameraFps > 0 ? ` · ${hw.cameraFps}fps` : '') +
            // Below 1 means the crop is locked onto the symbol rather than the
            // whole frame, which is where the pixels-per-module gain comes from.
            (hw.cropFraction < 0.95 ? ` · ×${(1 / hw.cropFraction).toFixed(1)}` : '') +
            // Zoom is the only one of these that raises the sampling rate
            // itself; the crop factor only shrinks the decoder's search.
            (hw.zoom > 1.05 ? ` · zoom ${hw.zoom.toFixed(1)}` : '');
      setEngine((prev) => (prev === label ? prev : label));

      const focus = hw?.sharpness ?? -1;
      setSharpness((prev) => (Math.abs(prev - focus) < 0.02 ? prev : focus));
      setFixedFocus(hw?.fixedFocus ?? false);
      setSilent(now - lastReadAtRef.current >= SILENT_MS);

      const rateSamples = rateSamplesRef.current.filter((s) => now - s.at <= RATE_WINDOW_MS);
      rateSamples.push({ at: now, received: p.received });
      rateSamplesRef.current = rateSamples;
      const oldest = rateSamples[0];
      const span = now - oldest.at;
      const rate = span >= MIN_RATE_SPAN_MS ? ((p.received - oldest.received) * 1000) / span : 0;
      setSymbolRate((prev) => (Math.abs(prev - rate) < 0.05 ? prev : rate));

      // A *different* foreign id means a different transfer, so an earlier
      // "keep receiving" no longer answers the question being asked.
      const foreign = r.foreignStreamId;
      if (foreign !== foreignIdRef.current) {
        foreignIdRef.current = foreign;
        foreignDismissedRef.current = false;
      }
      setOtherStream(foreign !== null && !foreignDismissedRef.current);
      setTooLarge(r.oversizedStream);

      if (r.complete) {
        finish(r);
        return;
      }

      if (r.streamId === null || p.received === 0) return;
      const due =
        now - lastSaveAtRef.current >= SAVE_INTERVAL_MS || p.ratio - lastSaveRatioRef.current >= SAVE_RATIO_STEP;
      if (!due) return;
      const snapshot = r.snapshot();
      if (snapshot === null) return;
      lastSaveAtRef.current = now;
      lastSaveRatioRef.current = p.ratio;
      void saveTransfer({
        streamId: r.streamId,
        updatedAt: now,
        snapshot,
        ratio: p.ratio,
        name: r.manifest?.name ?? null,
      });
    }, PUBLISH_MS);

    return () => window.clearInterval(id);
  }, [phase, finish]);

  // Camera lifecycle. `Scanner.start` is async, so the cleanup has to be able to
  // stop a scanner that has not been assigned to the ref yet.
  useEffect(() => {
    if (phase !== 'scanning') return;
    const video = videoRef.current;
    if (video === null) return;

    let cancelled = false;
    void Scanner.start({
      video,
      onText: handleText,
      onStats: handleStats,
      ...(detectorPreference !== null ? { force: detectorPreference } : {}),
    })
      .then((scanner) => {
        if (cancelled || !aliveRef.current) {
          scanner.stop();
          return;
        }
        scannerRef.current = scanner;
      })
      .catch((err: unknown) => {
        if (cancelled || !aliveRef.current) return;
        setCameraError(permissionKey(err));
        setPhase('idle');
      });

    return () => {
      cancelled = true;
      scannerRef.current?.stop();
      scannerRef.current = null;
    };
  }, [phase, detectorPreference, handleText, handleStats]);

  // The sender holds a wake lock while playing; the receiver needs one just as
  // much. A locked screen stops a transfer that may be half an hour from done.
  useEffect(() => {
    if (phase !== 'scanning') return;
    let handle: { release: () => void } | null = null;
    let released = false;
    void acquireWakeLock().then((acquired) => {
      if (released) {
        acquired.release();
        return;
      }
      handle = acquired;
    });
    return () => {
      released = true;
      handle?.release();
    };
  }, [phase]);

  const beginScan = useCallback((restored: Receiver | null): void => {
    const r = restored ?? new Receiver();
    receiverRef.current = r;

    foreignIdRef.current = null;
    foreignDismissedRef.current = false;
    finishingRef.current = false;
    samplesRef.current = [];
    rateSamplesRef.current = [];
    payloadRef.current = null;

    const now = Date.now();
    lastReadAtRef.current = now;
    lastSaveAtRef.current = now;
    lastSaveRatioRef.current = r.progress.ratio;

    setProgress(r.progress);
    setFileName(r.manifest?.name ?? null);
    setDecodeFps(0);
    setPeakFps(0);
    setEngine('');
    statsRef.current = null;
    setSilent(false);
    setOtherStream(false);
    setTooLarge(false);
    setCameraError(null);
    setManifest(null);
    setIntegrity('unknown');
    setOpened(null);
    setOpenError(null);
    setPassphrase('');
    setResumable(null);
    setPhase('scanning');
  }, []);

  /** Persist immediately rather than losing up to `SAVE_INTERVAL_MS` of work. */
  const stopScan = useCallback((): void => {
    const r = receiverRef.current;
    if (r !== null && r.streamId !== null && !r.complete) {
      const snapshot = r.snapshot();
      const p = r.progress;
      if (snapshot !== null && p.received > 0) {
        void saveTransfer({
          streamId: r.streamId,
          updatedAt: Date.now(),
          snapshot,
          ratio: p.ratio,
          name: r.manifest?.name ?? null,
        });
      }
    }
    setPhase('idle');
  }, []);

  const discardResume = useCallback((entry: StoredTransfer): void => {
    void deleteTransfer(entry.streamId);
    setResumable(null);
  }, []);

  /** Explicit user choice — a foreign stream is never dropped on its own. */
  const switchStream = useCallback((): void => {
    const r = receiverRef.current;
    if (r === null) return;
    r.reset();
    foreignIdRef.current = null;
    foreignDismissedRef.current = false;
    rateSamplesRef.current = [];
    setSymbolRate(0);
    lastSaveAtRef.current = Date.now();
    lastSaveRatioRef.current = 0;
    setOtherStream(false);
    setProgress(EMPTY_PROGRESS);
    setFileName(null);
  }, []);

  const keepStream = useCallback((): void => {
    foreignDismissedRef.current = true;
    setOtherStream(false);
  }, []);

  const unlock = useCallback(async (): Promise<void> => {
    const payload = payloadRef.current;
    if (manifest === null || payload === null || deriving) return;

    setDeriving(true);
    setOpenError(null);
    // Yield once so the spinner is painted before key derivation begins: 600k
    // PBKDF2 rounds take seconds on a low-end phone, and silence there is
    // indistinguishable from a hang.
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    try {
      const env = await openPayload(payload, manifest, passphrase);
      if (!aliveRef.current) return;
      setOpened({ name: env.name, mime: env.mime, data: env.data });
    } catch (err) {
      if (!aliveRef.current) return;
      setOpenError(err instanceof WrongPassphraseError ? 'recv.wrongPassphrase' : 'recv.mismatch');
    } finally {
      if (aliveRef.current) setDeriving(false);
    }
  }, [manifest, passphrase, deriving]);

  const reset = useCallback((): void => {
    receiverRef.current?.reset();
    receiverRef.current = null;
    payloadRef.current = null;
    finishingRef.current = false;
    setOpened(null);
    setManifest(null);
    setIntegrity('unknown');
    setOpenError(null);
    setPassphrase('');
    setProgress(EMPTY_PROGRESS);
    setFileName(null);
    setPhase('idle');
  }, []);

  if (phase === 'idle') {
    return (
      <section className="card">
        <h2 className="card-title">{t('app.receive')}</h2>
        {cameraError !== null && <p className="notice danger">{t(cameraError)}</p>}
        {resumable !== null && (
          <>
            <p className="notice">
              {t('recv.resumeFound', { ratio: Math.round(resumable.ratio * 100) })}
            </p>
            <div className="btn-row" style={{ marginBottom: 12 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => beginScan(Receiver.restore(resumable.snapshot))}
              >
                {t('recv.resume')}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => discardResume(resumable)}>
                {t('recv.discard')}
              </button>
            </div>
          </>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => beginScan(null)}>
            {t('recv.start')}
          </button>
        </div>
      </section>
    );
  }

  if (phase === 'scanning') {
    const hasSignal = progress.needed > 0;
    const focus = focusQuality(sharpness);
    const coach = coachingFor(hasSignal, decodeFps, peakFps, silent, symbolRate, focus, fixedFocus);
    const remaining = Math.max(0, progress.needed - progress.received);
    // Divide by the measured useful-symbol rate, not the decode rate — a rate of
    // 0 yields Infinity, which the formatter renders as "—" rather than a lie.
    const etaSeconds = remaining / symbolRate;
    const formatSeconds = (seconds: number): string => formatDuration(seconds, locale);
    const percent = Math.round(progress.ratio * 100);

    return (
      <>
        {/*
          The camera area carries only what helps the user aim. Progress numbers
          used to live here too, and an empty progress track cut a dark band
          across the viewfinder before any signal arrived — telemetry occluding
          the thing it is measuring.
        */}
        <div className="viewfinder">
          <video ref={videoRef} playsInline muted />
          <div className="reticle" />
          {/* Focus is the one thing a user can fix by moving, and the only way
              to fix it on a fixed-focus webcam. It needs a live readout right
              on the viewfinder, not a number in a table below it — you cannot
              aim at something you have to look away to read. */}
          {sharpness >= 0 && (
            <div className={`focus-meter ${focus}`}>
              <span>{t('recv.focus')}</span>
              <div className="focus-track">
                <div className="focus-fill" style={{ width: `${Math.round(sharpness * 100)}%` }} />
              </div>
            </div>
          )}
          <div className="overlay">
            <span className={coach.badgeClass}>{t(coach.qualityKey)}</span>
            <span aria-live="polite">{t(coach.coachKey)}</span>
          </div>
        </div>

        {hasSignal && (
          <section className="card tight">
            {fileName !== null && <p className="card-title">{fileName}</p>}
            <div className="progress">
              <div style={{ width: `${percent}%` }} />
            </div>
            <dl className="stats" style={{ marginTop: 12 }}>
              <div className="stat">
                <dt>{t('recv.percent')}</dt>
                <dd>{percent}%</dd>
              </div>
              <div className="stat">
                <dt>{t('recv.blocks')}</dt>
                <dd>
                  {progress.received}
                  <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> / {progress.needed}</span>
                </dd>
              </div>
              <div className="stat">
                <dt>{t('recv.rate')}</dt>
                <dd>{decodeFps.toFixed(1)} fps</dd>
              </div>
              <div className="stat">
                <dt>{t('recv.useful')}</dt>
                <dd>{symbolRate.toFixed(1)} /s</dd>
              </div>
              <div className="stat">
                <dt>{t('common.detector')}</dt>
                <dd style={{ fontSize: 13 }}>{engine}</dd>
              </div>
              <div className="stat">
                <dt>{t('recv.remaining')}</dt>
                <dd>{formatSeconds(etaSeconds)}</dd>
              </div>
            </dl>
          </section>
        )}

        {tooLarge && <p className="notice danger">{t('recv.tooLarge')}</p>}

        {otherStream && (
          <>
            <p className="notice warn">{t('recv.otherStream')}</p>
            <div className="btn-row">
              <button type="button" className="btn btn-sm" onClick={switchStream}>
                {t('recv.otherStreamSwitch')}
              </button>
              <button type="button" className="btn btn-sm" onClick={keepStream}>
                {t('recv.otherStreamKeep')}
              </button>
            </div>
          </>
        )}

        <div className="btn-row">
          <button type="button" className="btn btn-danger" onClick={stopScan}>
            {t('recv.stop')}
          </button>
        </div>
      </>
    );
  }

  if (opened !== null) {
    return (
      <Viewer
        name={opened.name}
        mime={opened.mime}
        data={opened.data}
        integrity={integrity}
        onReset={reset}
      />
    );
  }

  return (
    <section className="card" aria-live="polite">
      <h2 className="card-title">{t('recv.complete')}</h2>
      {integrity !== 'unknown' && (
        <p>
          <span className={integrity === 'verified' ? 'badge ok' : 'badge danger'}>
            {t(integrity === 'verified' ? 'recv.verified' : 'recv.mismatch')}
          </span>
        </p>
      )}
      {openError !== null && <p className="notice danger">{t(openError)}</p>}

      {manifest?.encrypted === true ? (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            void unlock();
          }}
        >
          <label htmlFor="recv-passphrase">{t('recv.needPassphrase')}</label>
          <input
            id="recv-passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={deriving}
            autoComplete="off"
          />
          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={deriving || passphrase.length === 0}>
              {deriving ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <span className="spinner" aria-hidden="true" />
                  {t('recv.deriving')}
                </span>
              ) : (
                t('recv.unlock')
              )}
            </button>
          </div>
        </form>
      ) : (
        openError === null && (
          <p className="notice">
            <span className="spinner" aria-hidden="true" />
            {t('send.preparing')}
          </p>
        )
      )}

      <div className="btn-row" style={{ marginTop: 12 }}>
        <button type="button" className="btn" onClick={reset}>
          {t('view.newTransfer')}
        </button>
      </div>
    </section>
  );
}
