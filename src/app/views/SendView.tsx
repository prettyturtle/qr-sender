/**
 * Sending half of the UI: pick a source, build the payload, then drive the QR
 * carousel.
 *
 * Three properties drive most of the shape of this file:
 *
 * 1. The channel is one-way. The sender can never learn that the receiver
 *    finished, so the UI never claims completion — it shows the loop counter and
 *    tells the user to check the other device (`send.noCompletionSignal`).
 * 2. Playback timing is the throughput budget. A frame held for less than two
 *    camera frames is a frame the receiver may never see, so the loop runs on a
 *    fixed timestep off `performance.now()` and pre-builds the next symbol one
 *    frame ahead, keeping `QRCode.create` (5-15ms) out of the critical path.
 * 3. `buildPayload` runs 600k PBKDF2 iterations on the main thread. The
 *    "preparing" state must therefore paint *before* the call, not after.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import QRCode from 'qrcode';
import {
  DEFAULT_N,
  DESIGN_MAX_VERSION,
  chooseLayout,
  type StageLayout,
  PLAYBACK_FPS_OPTIONS,
  maxKForFps,
} from '../../core/params.js';
import { buildPayload } from '../../core/payload.js';
import { resolveMime } from '../../core/mime.js';
import { Emitter } from '../../core/emitter.js';
import { encode as base44Encode } from '../../core/base44.js';
import { buildQr, drawQr, type RenderedQr } from '../../platform/qrRender.js';
import { acquireWakeLock, type WakeLockHandle } from '../../platform/wakeLock.js';
import { estimateTransfer, formatBytes } from '../estimate.js';
import { formatDuration, useT } from '../i18n.js';
import { useAppStore, type PlaybackFps } from '../store.js';
import { QR_COLORS } from '../palette.js';

/** Filename used when the source is typed text rather than a file. */
const TEXT_FILENAME = 'message.txt';

const SIDE_QR_CSS_SIZE = 108;
const MIN_STAGE_CSS_SIZE = 200;
/** Stage chrome (side QR, caption, controls) reserved when fitting to height. */
const STAGE_CHROME_PX = 200;

/**
 * `.qr-stage` is forced white in both themes so the symbol is never inverted —
 * which means controls inside it cannot inherit the theme's text colour.
 */
const STAGE_BTN: CSSProperties = { background: '#fff', color: '#16161a', borderColor: '#c9c9d1' };
const STAGE_TEXT: CSSProperties = { color: '#444', fontSize: '12px', margin: 0 };

type Source = { kind: 'file'; file: File } | { kind: 'text'; text: string };

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  /** The layout is fixed for the life of a stream: `blockSize` is in every header. */
  | { kind: 'playing'; emitter: Emitter; layout: StageLayout };

/**
 * Width the stage will get, computed before it exists so the QR version can be
 * chosen up front. Mirrors the shell's max-width and padding plus the stage's
 * own padding.
 */
function stageAreaEstimate(): { width: number; height: number } {
  // The playing stage breaks out of the shell's max-width, so the whole viewport
  // is available. A square symbol on a landscape screen wastes the horizontal
  // half of it, which is what makes tiling worth the complexity.
  const width = Math.max(MIN_STAGE_CSS_SIZE, (globalThis.innerWidth ?? 400) - 32);
  const height = Math.max(MIN_STAGE_CSS_SIZE, (globalThis.innerHeight ?? 700) - STAGE_CHROME_PX);
  return { width, height };
}

export function SendView(): JSX.Element {
  const t = useT();
  const locale = useAppStore((s) => s.locale);
  const fps = useAppStore((s) => s.playbackFps);
  const setPlaybackFps = useAppStore((s) => s.setPlaybackFps);
  const qrColor = useAppStore((s) => s.qrColor);
  const setQrColor = useAppStore((s) => s.setQrColor);
  const qrRounded = useAppStore((s) => s.qrRounded);
  const setQrRounded = useAppStore((s) => s.setQrRounded);
  const designPriority = useAppStore((s) => s.qrDesignPriority);
  const setDesignPriority = useAppStore((s) => s.setQrDesignPriority);

  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState(false);
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [wakeLockSupported, setWakeLockSupported] = useState(true);
  const [stats, setStats] = useState({ frames: 0, passes: 0 });
  const [stageArea, setStageArea] = useState(stageAreaEstimate);

  // Payload per tick is the throughput lever: a denser symbol where the screen
  // can resolve it, and more than one symbol where the screen has room.
  const layout = useMemo(
    () =>
      chooseLayout(
        stageArea.width,
        stageArea.height,
        globalThis.devicePixelRatio || 1,
        designPriority ? DESIGN_MAX_VERSION : undefined,
        designPriority ? 1 : undefined,
      ),
    [stageArea, designPriority],
  );

  useEffect(() => {
    const onResize = (): void => setStageArea(stageAreaEstimate());
    window.addEventListener('resize', onResize);
    globalThis.screen?.orientation?.addEventListener('change', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      globalThis.screen?.orientation?.removeEventListener('change', onResize);
    };
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const tileRefs = useRef<Array<HTMLCanvasElement | null>>([]);
  const sideCanvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Read by the rAF loop so a resize never restarts playback. */
  const stageSizeRef = useRef(MIN_STAGE_CSS_SIZE);
  /** Bumped on stop, so an in-flight `buildPayload` cannot resurrect playback. */
  const runIdRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const source = useMemo<Source | null>(() => {
    if (file !== null) return { kind: 'file', file };
    if (text.trim().length > 0) return { kind: 'text', text };
    return null;
  }, [file, text]);

  /**
   * Estimated from the *plain* size: compression and encryption only run at
   * start, and the user needs the number before committing to a transfer.
   */
  const sourceBytes = useMemo(() => {
    if (source === null) return 0;
    return source.kind === 'file' ? source.file.size : new TextEncoder().encode(source.text).length;
  }, [source]);

  const estimate = useMemo(
    () =>
      sourceBytes > 0
        ? estimateTransfer(sourceBytes, layout.profile, maxKForFps(fps), fps, layout.cols * layout.rows)
        : null,
    [sourceBytes, layout, fps],
  );

  const receiveUrl = useMemo(() => {
    const loc = globalThis.location;
    return loc === undefined ? '' : `${loc.origin}${loc.pathname}#receive`;
  }, []);

  const formatSeconds = (seconds: number): string => formatDuration(seconds, locale);

  /* ─── playback ────────────────────────────────────────────────────────── */

  useEffect(() => {
    if (phase.kind !== 'playing') return;
    const emitter = phase.emitter;
    const tiles = emitter.isStatic ? 1 : phase.layout.cols * phase.layout.rows;
    const style = { dark: qrColor, rounded: qrRounded };

    const nextFrame = (): RenderedQr => buildQr(base44Encode(emitter.next()), phase.layout.profile);

    // A transfer that fits in one frame has nothing to animate. Draw it once and
    // leave it on screen — no timer, no repaint, and any scanner gets it in a
    // single glance.
    if (emitter.isStatic) {
      const canvas = tileRefs.current[0];
      if (canvas !== null && canvas !== undefined) {
        drawQr(canvas, nextFrame(), { cssSize: stageSizeRef.current, ...style });
      }
      return;
    }

    const interval = 1000 / fps;

    let raf = 0;
    let last = -1;
    let pending: RenderedQr[] | null = null;

    const buildBatch = (): RenderedQr[] => Array.from({ length: tiles }, nextFrame);

    const show = (): void => {
      const batch = pending ?? buildBatch();
      for (let i = 0; i < tiles; i++) {
        const canvas = tileRefs.current[i];
        if (canvas === null || canvas === undefined) continue;
        drawQr(canvas, batch[i], { cssSize: stageSizeRef.current, ...style });
      }
      // One-tick lookahead: build the *next* batch right after painting so the
      // encode cost lands in the idle tail of the period instead of between the
      // deadline and the paint, where it would show up as playback jitter.
      pending = buildBatch();
    };

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      if (last < 0) {
        last = now;
        show();
        return;
      }
      const elapsed = now - last;
      if (elapsed < interval) return;
      // Fixed timestep: advance by exactly one period so rAF jitter does not
      // accumulate into drift. If we fell far behind — backgrounded tab, GC
      // pause — resync rather than burning through a catch-up burst the camera
      // could never resolve.
      last = elapsed > interval * 3 ? now : last + interval;
      show();
    };

    // rAF is throttled to a stop while hidden; restarting from a stale
    // timestamp would fire a burst of frames on return.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') last = -1;
    };

    document.addEventListener('visibilitychange', onVisibility);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [phase, fps, qrColor, qrRounded]);

  /* ─── canvas sizing ───────────────────────────────────────────────────── */

  // Derived from the viewport, not measured from the stage: the stage's height
  // comes from the canvas it contains, so measuring it to size that canvas is
  // circular and yields a near-zero first reading.
  useEffect(() => {
    if (phase.kind !== 'playing') return;
    const { cols, rows, tileSize } = phase.layout;
    const gap = 8 * (Math.max(cols, rows) - 1);
    const width = (stageArea.width - 24 - gap) / cols;
    const height = (stageArea.height - 24 - gap) / rows;
    const fitted = Math.floor(Math.min(width, height, tileSize));
    stageSizeRef.current = Math.max(MIN_STAGE_CSS_SIZE, fitted);
  }, [phase, stageArea, fullscreen]);

  /* ─── static onboarding QR ────────────────────────────────────────────── */

  useEffect(() => {
    if (phase.kind !== 'playing') return;
    const canvas = sideCanvasRef.current;
    if (canvas === null || receiveUrl === '') return;
    // Not `buildQr`: that pins the stream's fixed version/ECC profile, which is
    // far larger than a URL needs. Byte mode at ECC-M keeps this one small.
    const symbol = QRCode.create(receiveUrl, { errorCorrectionLevel: 'M' });
    drawQr(canvas, { modules: symbol.modules.size, data: symbol.modules.data }, { cssSize: SIDE_QR_CSS_SIZE });
  }, [phase, receiveUrl]);

  /* ─── wake lock ───────────────────────────────────────────────────────── */

  useEffect(() => {
    if (phase.kind !== 'playing') return;
    let handle: WakeLockHandle | null = null;
    let released = false;

    void acquireWakeLock().then((acquired) => {
      if (released) {
        acquired.release();
        return;
      }
      handle = acquired;
      setWakeLockSupported(acquired.supported);
    });

    return () => {
      released = true;
      handle?.release();
    };
  }, [phase]);

  /* ─── stats polling ───────────────────────────────────────────────────── */

  useEffect(() => {
    if (phase.kind !== 'playing') return;
    const emitter = phase.emitter;
    // Polled rather than pushed from the loop: re-rendering on every frame would
    // put React's reconciler on the playback critical path for no visible gain.
    const sample = (): void => setStats({ frames: emitter.framesEmitted, passes: emitter.passes });
    sample();
    const id = globalThis.setInterval(sample, 250);
    return () => globalThis.clearInterval(id);
  }, [phase]);

  /* ─── fullscreen ──────────────────────────────────────────────────────── */

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  /* ─── actions ─────────────────────────────────────────────────────────── */

  function pickFile(next: File | null): void {
    setFile(next);
    setError(null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files.item(0);
    if (dropped !== null) pickFile(dropped);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>): void {
    // Ignore bubbling leaves from children, which would otherwise flicker.
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDragging(false);
  }

  function stop(): void {
    runIdRef.current++;
    setFullscreen(false);
    setWakeLockSupported(true);
    setPhase({ kind: 'idle' });
  }

  async function start(): Promise<void> {
    if (source === null) return;
    const runId = ++runIdRef.current;
    setError(null);
    setPhase({ kind: 'preparing' });

    // Yield one macrotask so the spinner actually paints: everything below this
    // line blocks the main thread, PBKDF2 for seconds on a slow phone.
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, 0);
    });

    const stale = (): boolean => !aliveRef.current || runIdRef.current !== runId;

    try {
      const data =
        source.kind === 'file'
          ? new Uint8Array(await source.file.arrayBuffer())
          : new TextEncoder().encode(source.text);
      if (stale()) return;

      const built = await buildPayload({
        name: source.kind === 'file' ? source.file.name : TEXT_FILENAME,
        // `File.type` is empty for a lot of real files; resolving from the bytes
        // and the name here is what lets the receiver preview them at all.
        mime:
          source.kind === 'file'
            ? resolveMime(source.file.type, source.file.name, data)
            : 'text/plain',
        data,
        passphrase: usePassphrase ? passphrase : undefined,
        // K is capped by the playback rate: displaying faster shrinks the slowest
        // receiver's share of each carousel cycle.
        k: maxKForFps(fps),
        n: DEFAULT_N,
        blockSize: layout.profile.blockSize,
      });
      if (stale()) return;

      setPhase({
        kind: 'playing',
        layout,
        emitter: new Emitter({
          payload: built.payload,
          manifest: built.manifest,
          streamId: built.streamId,
          // K is derived from the finished payload, not fixed at the ceiling.
          k: built.manifest.k,
          n: built.manifest.n,
          blockSize: built.manifest.blockSize,
        }),
      });
    } catch (cause) {
      if (stale()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase({ kind: 'idle' });
    }
  }

  const canStart = source !== null && !(usePassphrase && passphrase.length === 0);

  /* ─── render ──────────────────────────────────────────────────────────── */

  if (phase.kind === 'preparing') {
    return (
      <section className="card">
        <div className="notice" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <span>{usePassphrase ? t('send.encrypting') : t('send.preparing')}</span>
        </div>
        <div className="btn-row" style={{ marginTop: '14px' }}>
          <button type="button" className="btn" onClick={stop}>
            {t('common.cancel')}
          </button>
        </div>
      </section>
    );
  }

  if (phase.kind === 'playing') {
    const emitter = phase.emitter;
    const tileCount = emitter.isStatic ? 1 : phase.layout.cols * phase.layout.rows;
    const tileCols = emitter.isStatic ? 1 : phase.layout.cols;
    return (
      <>
        <div className={fullscreen ? 'qr-stage bleed fullscreen' : 'qr-stage bleed'} ref={stageRef}>
          <div
            className="tile-grid"
            style={{ gridTemplateColumns: `repeat(${tileCols}, max-content)` }}
            aria-label={t('app.send')}
            role="img"
          >
            {Array.from({ length: tileCount }, (_, i) => (
              <canvas
                key={i}
                ref={(el) => {
                  tileRefs.current[i] = el;
                }}
              />
            ))}
          </div>

          <div className="qr-side">
            <canvas ref={sideCanvasRef} aria-hidden="true" />
            <span>{t('send.receiverHint')}</span>
          </div>

          <p style={STAGE_TEXT} aria-live="polite">
            {t('send.loops', { n: stats.passes + 1 })}
          </p>

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-sm"
              style={STAGE_BTN}
              aria-pressed={fullscreen}
              onClick={() => setFullscreen(!fullscreen)}
            >
              {t('send.fullscreen')}
            </button>
            <button type="button" className="btn btn-sm" style={STAGE_BTN} onClick={stop}>
              {t('send.stop')}
            </button>
          </div>
        </div>

        <section className="card">
          <dl className="stats">
            <div className="stat">
              <dt>{t('send.segments')}</dt>
              <dd>{emitter.segCount}</dd>
            </div>
            <div className="stat">
              <dt>{t('send.symbols')}</dt>
              <dd>{emitter.totalSymbols}</dd>
            </div>
            <div className="stat">
              <dt>{t('send.frames')}</dt>
              <dd>{stats.frames}</dd>
            </div>
            <div className="stat">
              <dt>{t('send.loop')}</dt>
              <dd>{stats.passes}</dd>
            </div>
          </dl>
          {stats.passes > 0 && (
            <p style={{ marginBottom: 0 }}>
              <span className="badge ok">{t('send.loopDone')}</span>
            </p>
          )}
        </section>

        <p className="notice">{t('send.noCompletionSignal')}</p>
        {!wakeLockSupported && <p className="notice warn">{t('send.wakeLockUnsupported')}</p>}
      </>
    );
  }

  return (
    <>
      <div
        className={dragging ? 'dropzone active' : 'dropzone'}
        role="button"
        tabIndex={0}
        aria-label={t('send.drop')}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {dragging ? t('send.dropActive') : t('send.drop')}
      </div>
      <input
        ref={fileInputRef}
        className="sr-only"
        type="file"
        aria-label={t('send.drop')}
        // Clearing on open lets the same file be re-picked; otherwise selecting
        // an identical path twice fires no change event.
        onClick={(event) => {
          event.currentTarget.value = '';
        }}
        onChange={(event) => pickFile(event.target.files?.item(0) ?? null)}
      />

      {file === null ? (
        <div className="field">
          <label htmlFor="send-text">{t('send.orText')}</label>
          <textarea
            id="send-text"
            value={text}
            placeholder={t('send.textPlaceholder')}
            onChange={(event) => setText(event.target.value)}
          />
        </div>
      ) : (
        <div className="btn-row">
          <button type="button" className="btn btn-sm" onClick={() => pickFile(null)}>
            {t('common.cancel')}
          </button>
        </div>
      )}

      {estimate !== null && source !== null && (
        <section className="card">
          <p className="card-title">{source.kind === 'file' ? source.file.name : t('send.textName')}</p>
          <dl className="stats">
            <div className="stat">
              <dt>{t('view.size')}</dt>
              <dd>{formatBytes(sourceBytes)}</dd>
            </div>
            <div className="stat">
              <dt>{t('send.segments')}</dt>
              <dd>{estimate.segCount}</dd>
            </div>
            <div className="stat">
              <dt>{t('send.estimate')}</dt>
              <dd>
                {t('send.estimateValue', {
                  a: formatSeconds(estimate.fastestSeconds),
                  b: formatSeconds(estimate.slowestSeconds),
                })}
              </dd>
            </div>
          </dl>
          <p className="mono" style={{ marginBottom: 0 }}>
            {t('send.estimateRange')}
          </p>
        </section>
      )}

      {estimate?.overSoftLimit === true && <p className="notice warn">{t('send.overLimit')}</p>}

      <section className="card">
        <label className="switch">
          <input
            type="checkbox"
            checked={usePassphrase}
            onChange={(event) => setUsePassphrase(event.target.checked)}
          />
          <span>{t('send.encrypt')}</span>
        </label>

        {usePassphrase && (
          <div className="field" style={{ marginTop: '12px' }}>
            <label htmlFor="send-passphrase">{t('send.passphrase')}</label>
            <input
              id="send-passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
            <span className="mono">{t('send.passphraseHint')}</span>
          </div>
        )}
      </section>

      <p className={usePassphrase ? 'notice' : 'notice warn'}>
        {usePassphrase ? t('send.encryptedNotice') : t('send.clearWarning')}
      </p>

      <section className="card">
        <p className="card-title">{t('send.qrStyle')}</p>

        <div className="field">
          <label htmlFor="send-fps">{t('send.speed')}</label>
          <select
            id="send-fps"
            value={fps}
            onChange={(event) => setPlaybackFps(Number(event.target.value) as PlaybackFps)}
          >
            {PLAYBACK_FPS_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {`${option} fps`}
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ marginTop: 14 }}>
          <span id="send-color-label">{t('send.qrColor')}</span>
          <div className="swatches" role="group" aria-labelledby="send-color-label">
            {QR_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                className={qrColor === c.hex ? 'swatch selected' : 'swatch'}
                style={{ background: c.hex }}
                aria-label={c.name}
                aria-pressed={qrColor === c.hex}
                onClick={() => setQrColor(c.hex)}
              />
            ))}
          </div>
        </div>

        <label className="switch" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={qrRounded}
            onChange={(event) => setQrRounded(event.target.checked)}
          />
          <span>{t('send.qrRounded')}</span>
        </label>

        <label className="switch" style={{ marginTop: 10 }}>
          <input
            type="checkbox"
            checked={designPriority}
            onChange={(event) => setDesignPriority(event.target.checked)}
          />
          <span>{t('send.qrDesign')}</span>
        </label>

        <p className="mono" style={{ marginTop: 10, marginBottom: 0 }}>
          {t('send.qrStyleNote')}
        </p>
      </section>

      {error !== null && (
        <p className="notice danger">
          {t('send.buildFailed')} <span className="mono">{error}</span>
        </p>
      )}

      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={!canStart} onClick={() => void start()}>
          {t('send.start')}
        </button>
      </div>
    </>
  );
}
