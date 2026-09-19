/**
 * Content-addressed local storage for clip audio.
 *
 * Blobs are keyed by their SHA-256 hash, which buys three things at once:
 *
 * 1. **Deduplication.** Identical audio has identical bytes, so it has one address.
 * 2. **Verification.** A receiver hashes what it got and rejects anything that
 *    does not match, so a corrupted or malicious transfer cannot poison a project.
 * 3. **Source independence.** The same bytes can come from any peer, so the
 *    uploader is never a single point of failure while it is online.
 *
 * If IndexedDB is unavailable (private windows, some embedded webviews) this
 * degrades to an in-memory map so the app still works for the current session —
 * it simply cannot re-seed blobs after a reload.
 */
import type { ClipCodec } from './types';

export interface StoredBlob {
  /** SHA-256 hex of `bytes` — also the IndexedDB key. */
  hash: string;
  bytes: ArrayBuffer;
  codec: ClipCodec;
  sampleRate: number;
  cycleFrames: number;
  createdAt: number;
}

const DB_NAME = 'looprecorder';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'hash' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export class BlobStore {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase | null> | null = null;
  /** Fallback when IndexedDB is unavailable. */
  private readonly memory = new Map<string, StoredBlob>();

  private async database(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    if (!this.opening) this.opening = openDatabase();
    const db = await this.opening;
    if (db) this.db = db;
    return db;
  }

  async has(hash: string): Promise<boolean> {
    return (await this.get(hash)) !== null;
  }

  async put(blob: StoredBlob): Promise<void> {
    const db = await this.database();
    if (!db) {
      this.memory.set(blob.hash, blob);
      return;
    }
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(blob);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
    if (!ok) this.memory.set(blob.hash, blob);
  }

  async get(hash: string): Promise<StoredBlob | null> {
    const db = await this.database();
    if (db) {
      const record = await new Promise<StoredBlob | null>((resolve) => {
        try {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const request = tx.objectStore(STORE_NAME).get(hash);
          request.onsuccess = () => resolve((request.result as StoredBlob | undefined) ?? null);
          request.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
      if (record) return record;
    }
    return this.memory.get(hash) ?? null;
  }

  async delete(hash: string): Promise<void> {
    this.memory.delete(hash);
    const db = await this.database();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(hash);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  async list(): Promise<string[]> {
    const db = await this.database();
    if (!db) return [...this.memory.keys()];
    const keys = await new Promise<string[]>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).getAllKeys();
        request.onsuccess = () => resolve((request.result as IDBValidKey[]).map(String));
        request.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
    return keys;
  }
}
