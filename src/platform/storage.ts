/**
 * IndexedDB persistence for partial receives.
 *
 * A 10MB transfer to an iPhone takes over half an hour; losing all of it to an
 * accidental tab close would make the size policy dishonest. Snapshots are
 * plain structured-cloneable objects (typed arrays included), so no manual
 * serialisation is involved.
 */

import type { ReceiverSnapshot } from '../core/receiver.js';

const DB_NAME = 'qr-sender';
const DB_VERSION = 2;
const STORE = 'partials';
const HISTORY = 'history';

/**
 * Ceiling on what history may hold, in bytes.
 *
 * Browsers do not warn before evicting; when an origin exceeds its quota some
 * of them drop the *entire* database, which would take the in-progress partials
 * with it. Staying well under a plausible quota is what keeps resume reliable,
 * so history is capped and evicted rather than left to grow into that failure.
 */
export const HISTORY_MAX_BYTES = 200 * 1024 * 1024;

export interface StoredTransfer {
  streamId: number;
  updatedAt: number;
  snapshot: ReceiverSnapshot;
  ratio: number;
  name: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'streamId' });
      }
      if (!db.objectStoreNames.contains(HISTORY)) {
        // `receivedAt` is the key, not `streamId`: the same file received twice
        // is two history entries, and a sender that restarts reuses its id.
        db.createObjectStore(HISTORY, { keyPath: 'receivedAt' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  storeName: string = STORE,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const req = fn(t.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        // Close on every terminal outcome. In private mode these writes fail
        // every few seconds, and closing only on success leaks a connection
        // each time.
        t.oncomplete = () => db.close();
        t.onerror = () => db.close();
        t.onabort = () => db.close();
      }),
  );
}

export async function saveTransfer(entry: StoredTransfer): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(entry) as IDBRequest<IDBValidKey>);
  } catch {
    // Storage pressure or private mode: resume is a convenience, never a hard dependency.
  }
}

export async function listTransfers(): Promise<StoredTransfer[]> {
  try {
    const all = await tx('readonly', (s) => s.getAll() as IDBRequest<StoredTransfer[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export async function deleteTransfer(streamId: number): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(streamId) as unknown as IDBRequest<undefined>);
  } catch {
    /* ignore */
  }
}

/** Drop partials older than a week so the database cannot grow without bound. */
export async function pruneTransfers(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const now = Date.now();
  for (const t of await listTransfers()) {
    if (now - t.updatedAt > maxAgeMs) await deleteTransfer(t.streamId);
  }
}

/* ─── history ─────────────────────────────────────────────────────────────
 *
 * Completed receives, kept so a transfer can be reopened later rather than
 * being a one-shot that vanishes when the tab closes.
 *
 * This is the one place the app writes user content to disk, so it is bounded,
 * listable, and deletable — individually and wholesale. The payload sits beside
 * its own metadata rather than in a separate index: a list that could disagree
 * with what is actually stored would show entries that fail to open.
 */

export interface HistoryEntry {
  /** Milliseconds since epoch; also the primary key. */
  receivedAt: number;
  name: string;
  mime: string;
  size: number;
  integrity: 'verified' | 'mismatch' | 'unknown';
  data: Uint8Array;
}

/** Everything but the payload, for listing without reading megabytes back. */
export type HistoryMeta = Omit<HistoryEntry, 'data'>;

export async function listHistory(): Promise<HistoryMeta[]> {
  try {
    const all = await tx('readonly', (s) => s.getAll() as IDBRequest<HistoryEntry[]>, HISTORY);
    return all
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .map(({ data: _data, ...meta }) => meta);
  } catch {
    return [];
  }
}

export async function readHistory(receivedAt: number): Promise<HistoryEntry | null> {
  try {
    const entry = await tx(
      'readonly',
      (s) => s.get(receivedAt) as IDBRequest<HistoryEntry | undefined>,
      HISTORY,
    );
    return entry ?? null;
  } catch {
    return null;
  }
}

export async function deleteHistory(receivedAt: number): Promise<void> {
  try {
    await tx(
      'readwrite',
      (s) => s.delete(receivedAt) as unknown as IDBRequest<undefined>,
      HISTORY,
    );
  } catch {
    /* ignore */
  }
}

export async function clearHistory(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.clear() as unknown as IDBRequest<undefined>, HISTORY);
  } catch {
    /* ignore */
  }
}

/** Bytes currently held by history. */
export async function historyBytes(): Promise<number> {
  return (await listHistory()).reduce((sum, e) => sum + e.size, 0);
}

/**
 * Store a completed receive, evicting the oldest entries to stay under the cap.
 *
 * A payload larger than the whole budget is not stored at all rather than
 * emptying history to make room for it — deleting everything the user kept in
 * order to hold one file they did not ask to keep is the wrong trade.
 */
export async function saveHistory(entry: HistoryEntry): Promise<void> {
  if (entry.size > HISTORY_MAX_BYTES) return;
  try {
    const existing = await listHistory();
    let total = existing.reduce((sum, e) => sum + e.size, 0) + entry.size;
    // Oldest first, since `listHistory` returns newest first.
    for (let i = existing.length - 1; i >= 0 && total > HISTORY_MAX_BYTES; i--) {
      await deleteHistory(existing[i].receivedAt);
      total -= existing[i].size;
    }
    await tx('readwrite', (s) => s.put(entry) as IDBRequest<IDBValidKey>, HISTORY);
  } catch {
    // Storage pressure or private mode. History is a convenience; a receive
    // that just succeeded must not be reported as failed because of it.
  }
}
