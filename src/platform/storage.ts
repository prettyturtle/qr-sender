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
const DB_VERSION = 1;
const STORE = 'partials';

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
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
