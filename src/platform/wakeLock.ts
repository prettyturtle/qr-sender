/**
 * Screen wake lock for the sending device.
 *
 * A transfer can run for tens of minutes with no user input, which is exactly
 * the condition every OS treats as "idle, dim the screen". A dimmed screen
 * drops decode rate; a locked one stops the transfer outright. Not all browsers
 * expose the API, so the caller must still be able to warn the user.
 */

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', cb: () => void): void;
}

export interface WakeLockHandle {
  supported: boolean;
  active: boolean;
  release(): void;
}

export function isWakeLockSupported(): boolean {
  return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

/**
 * Acquires the lock and silently re-acquires it when the tab returns to the
 * foreground — browsers drop the sentinel on visibility change.
 */
export async function acquireWakeLock(): Promise<WakeLockHandle> {
  const handle: WakeLockHandle = { supported: isWakeLockSupported(), active: false, release: () => {} };
  if (!handle.supported) return handle;

  let sentinel: WakeLockSentinelLike | null = null;
  let disposed = false;

  const request = async (): Promise<void> => {
    if (disposed || document.visibilityState !== 'visible') return;
    try {
      sentinel = (await (
        navigator as Navigator & { wakeLock: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }
      ).wakeLock.request('screen')) as WakeLockSentinelLike;
      handle.active = true;
      sentinel.addEventListener('release', () => {
        handle.active = false;
      });
    } catch {
      handle.active = false;
    }
  };

  const onVisibility = (): void => {
    if (!disposed && document.visibilityState === 'visible' && !handle.active) void request();
  };

  document.addEventListener('visibilitychange', onVisibility);
  await request();

  handle.release = () => {
    disposed = true;
    document.removeEventListener('visibilitychange', onVisibility);
    void sentinel?.release().catch(() => {});
    handle.active = false;
  };

  return handle;
}
