/**
 * What frame rate this device can actually deliver, measured rather than assumed.
 *
 * Playback rate is the single biggest throughput lever, but it is the one the
 * user is least equipped to guess: offering 60fps on a 60Hz panel that cannot
 * paint a V40 symbol in 16ms produces a slower transfer than 30fps, because
 * every frame the compositor drops is a symbol the receiver never sees. The
 * options list is therefore filtered by what the display refreshes at, and the
 * default is the fastest rate the device can be shown to sustain.
 *
 * Two things are measured, and they are different:
 *
 *  - **Refresh rate** — a hard ceiling. Nothing can be displayed faster than the
 *    panel updates, so a rate above it is not fast, it is aliased.
 *  - **Paint throughput** — how quickly the render pool can produce symbols.
 *    This is the one that varies by an order of magnitude between a laptop and
 *    a mid-range phone.
 */

/** rAF deltas below this are the browser coalescing callbacks, not real frames. */
const MIN_PLAUSIBLE_MS = 3;
/** Above this the tab was throttled or the thread stalled; the sample is noise. */
const MAX_PLAUSIBLE_MS = 100;

/** Panels cluster at these rates; snapping avoids reporting "58Hz" for a 60Hz screen. */
const KNOWN_RATES = [24, 30, 48, 50, 60, 72, 90, 100, 120, 144, 165, 240];

/** How close a measurement has to be to a known rate to be snapped onto it. */
const SNAP_TOLERANCE = 0.08;

function snap(hz: number): number {
  for (const known of KNOWN_RATES) {
    if (Math.abs(hz - known) / known <= SNAP_TOLERANCE) return known;
  }
  return Math.round(hz);
}

/**
 * Measure the display's refresh rate from `requestAnimationFrame` cadence.
 *
 * The median is used rather than the mean: a single GC pause or layout in the
 * middle of the sample would drag a mean down by tens of hertz, and reporting a
 * 120Hz panel as 70Hz would cost the user half their throughput.
 */
export async function measureRefreshHz(samples = 24): Promise<number> {
  if (typeof requestAnimationFrame !== 'function') return 60;

  const deltas: number[] = [];
  await new Promise<void>((resolve) => {
    let last = -1;
    let seen = 0;
    const step = (now: number): void => {
      if (last >= 0) {
        const dt = now - last;
        if (dt >= MIN_PLAUSIBLE_MS && dt <= MAX_PLAUSIBLE_MS) deltas.push(dt);
      }
      last = now;
      // One extra iteration because the first callback yields no delta.
      if (++seen > samples) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

  if (deltas.length < 4) return 60;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return snap(1000 / median);
}

export interface RateAdvice {
  /** Measured panel refresh, in hertz. */
  refreshHz: number;
  /** Rates worth offering on this display. */
  options: number[];
  /** The one to select by default. */
  recommended: number;
}

/**
 * Which playback rates are worth offering, and which to pick.
 *
 * A rate above the refresh rate cannot be shown: the compositor would drop
 * every other symbol, which the receiver sees as a stream running at the
 * refresh rate with half its frames missing — strictly worse than asking for
 * the refresh rate in the first place.
 *
 * The recommendation is the fastest *offered* rate, because the receiver's
 * fountain coding makes a missed frame cost one frame rather than a restart:
 * over-driving degrades gracefully while under-driving simply wastes capacity.
 * The receive screen reports the reading device's own ceiling, which is the
 * other half of this decision and the half no sender can measure.
 */
export function adviseRates(refreshHz: number, all: readonly number[]): RateAdvice {
  // A hair of tolerance: a panel measured at 59.9Hz should still offer 60.
  const ceiling = refreshHz * 1.02;
  const options = all.filter((fps) => fps <= ceiling);
  if (options.length === 0) options.push(Math.min(...all));
  return { refreshHz, options, recommended: Math.max(...options) };
}

/**
 * Frames per second a decoder can sustain, from its own instrumentation.
 *
 * `concurrency / latency` rather than `1 / latency`: the pool decodes several
 * frames at once, so a 200ms decode across 8 workers is 40 frames per second,
 * not 5. The camera's own delivery rate caps the result — a decoder that could
 * handle 90fps still only ever sees what the sensor hands it.
 */
export function decodeCeilingFps(
  concurrency: number,
  latencyMs: number,
  cameraFps: number,
): number {
  if (latencyMs <= 0 || concurrency <= 0) return 0;
  const decode = (concurrency / latencyMs) * 1000;
  return cameraFps > 0 ? Math.min(decode, cameraFps) : decode;
}
