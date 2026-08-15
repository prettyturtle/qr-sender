/**
 * Throw away the cached copy of the app and start again from the network.
 *
 * This app installs a service worker so it can run with no connection at all,
 * which is the right default for something used in an air-gapped setting. The
 * cost is that a worker holding a bad or stale build keeps serving it: it
 * answers from cache before the network is consulted, so a normal reload — even
 * a hard one — can hand back exactly the same broken files. There is no way for
 * a user to get out of that from inside the page, which is why this exists as an
 * explicit action rather than something the app decides on their behalf.
 *
 * Stored data is deliberately untouched. Caches hold the program; IndexedDB
 * holds what the user received. Clearing the program to fix the program should
 * not also delete their transfers.
 */

export interface ResetResult {
  /** Cache Storage buckets removed. */
  caches: number;
  /** Service worker registrations removed. */
  workers: number;
}

export async function clearAppCache(): Promise<ResetResult> {
  let removedCaches = 0;
  let removedWorkers = 0;

  if (typeof caches !== 'undefined') {
    try {
      const keys = await caches.keys();
      const results = await Promise.all(keys.map((key) => caches.delete(key)));
      removedCaches = results.filter(Boolean).length;
    } catch {
      // Private mode, or storage denied. Unregistering below still helps.
    }
  }

  if (typeof navigator !== 'undefined' && navigator.serviceWorker !== undefined) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      const results = await Promise.all(registrations.map((r) => r.unregister()));
      removedWorkers = results.filter(Boolean).length;
    } catch {
      /* nothing further to try */
    }
  }

  return { caches: removedCaches, workers: removedWorkers };
}

/**
 * Clear, then reload from the network rather than from history.
 *
 * `location.reload()` may still be answered out of the back/forward cache, and
 * a page restored from there would be the very build that was just discarded.
 * Replacing the URL with a one-off query forces a real navigation; the marker is
 * dropped again on the next load so it never accumulates or gets shared.
 */
export async function clearAppCacheAndReload(): Promise<void> {
  await clearAppCache();
  const url = new URL(globalThis.location.href);
  url.searchParams.set('reset', Date.now().toString(36));
  globalThis.location.replace(url.toString());
}
