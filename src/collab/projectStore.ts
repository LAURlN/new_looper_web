/**
 * The shared project document.
 *
 * This is the "metadata in a CRDT" half of the design: a Yjs document holding
 * the project header and the list of clips. It is deliberately generic —
 * `features` and `events` are reserved namespaces — so a future collaborative
 * feature (shared settings, a lyric sheet, an arrangement) is a new key here
 * and inherits syncing, offline handling, conflict resolution and persistence
 * with **no new networking code**.
 *
 * Audio never goes in this document. A clip carries only a content hash; the
 * bytes live in `BlobStore` and travel over the data channel.
 *
 * `y-indexeddb` persists the document locally, so the project survives reloads
 * and works offline. On reconnect Yjs merges with peers automatically.
 */
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { Observable } from '../util/observable';
import {
  SCHEMA_VERSION,
  type CanonicalResult,
  type ClipMeta,
  type ClipRecord,
  type ProjectHeader,
  type RecordLock,
} from './types';

const CLIP_FIELD_DEFAULTS = {
  authorId: '',
  authorName: '',
  createdAt: 0,
  sampleRate: 0,
  cycleFrames: 0,
  blobHash: '',
  blobBytes: 0,
  slot: 0,
} as const;

export const PROJECT_MAP = 'project';
export const CLIPS_ARRAY = 'clips';
/** Reserved extension points — unused today, but present so the shape is stable. */
export const FEATURES_MAP = 'features';
export const EVENTS_ARRAY = 'events';
/**
 * The recording lease. Deliberately a top-level map of its own rather than part of the
 * project header: it is ephemeral session state ("who is recording *right now*"), and
 * mixing it into the header would make it look like project metadata — and would make
 * every claim and refresh look like a project edit to anyone reading the document.
 *
 * It is also additive, so an older client that never reads this map simply ignores it.
 */
export const RECORD_LOCK_MAP = 'recordLock';

/**
 * How old a claim may be before it reads as no claim at all.
 *
 * This is the whole point of a lease: a phone that dies, backgrounds or loses its
 * connection mid-take stops being reported after a minute without anyone sending
 * anything. A peer that is still recording keeps its claim alive by refreshing it.
 */
export const RECORD_LOCK_TTL_MS = 60000;

export const DEFAULT_PROJECT_NAME = 'Untitled loop';

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toRecord(map: Y.Map<unknown>): ClipRecord | null {
  const id = map.get('id');
  if (typeof id !== 'string') return null;
  return {
    id,
    authorId: asString(map.get('authorId'), CLIP_FIELD_DEFAULTS.authorId),
    authorName: asString(map.get('authorName'), CLIP_FIELD_DEFAULTS.authorName),
    createdAt: asNumber(map.get('createdAt')),
    sampleRate: asNumber(map.get('sampleRate')),
    cycleFrames: asNumber(map.get('cycleFrames')),
    codec: 'wav16',
    blobHash: asString(map.get('blobHash')),
    blobBytes: asNumber(map.get('blobBytes')),
    slot: asNumber(map.get('slot')),
    deleted: map.get('deleted') === true,
  };
}

export class ProjectStore {
  readonly doc: Y.Doc;
  readonly clips: Observable<ClipRecord[]>;
  readonly header: Observable<ProjectHeader>;
  /**
   * The recording lease as of its last change, or `null` when nobody holds it.
   *
   * This is the *change signal*: a remote claim arrives as an ordinary document update, so
   * subscribing here is what surfaces it. Reads that need a claim to be current go through
   * `getRecordLock()`, which re-evaluates expiry against the wall clock.
   */
  readonly recordLock: Observable<RecordLock | null>;

  private readonly projectMap: Y.Map<unknown>;
  private readonly clipsArray: Y.Array<Y.Map<unknown>>;
  private readonly recordLockMap: Y.Map<unknown>;
  private readonly persistence: IndexeddbPersistence | null;
  private readonly emitClips: () => void;
  private readonly emitHeader: () => void;
  private readonly emitRecordLock: () => void;

  constructor(roomId: string, projectName = DEFAULT_PROJECT_NAME) {
    this.doc = new Y.Doc();
    this.projectMap = this.doc.getMap(PROJECT_MAP);
    this.clipsArray = this.doc.getArray<Y.Map<unknown>>(CLIPS_ARRAY);
    this.recordLockMap = this.doc.getMap(RECORD_LOCK_MAP);

    this.clips = new Observable<ClipRecord[]>([]);
    this.recordLock = new Observable<RecordLock | null>(null);
    this.header = new Observable<ProjectHeader>({
      id: roomId,
      name: projectName,
      schemaVersion: SCHEMA_VERSION,
      sampleRate: null,
      cycleFrames: null,
      createdAt: 0,
    });

    // Seed the header. Done in one transaction so the first peer to arrive
    // defines the project identity that everyone else merges onto.
    this.doc.transact(() => {
      if (!this.projectMap.has('schemaVersion')) this.projectMap.set('schemaVersion', SCHEMA_VERSION);
      if (!this.projectMap.has('id')) this.projectMap.set('id', roomId);
      if (!this.projectMap.has('name')) this.projectMap.set('name', projectName);
      if (!this.projectMap.has('createdAt')) this.projectMap.set('createdAt', Date.now());
    });

    this.emitClips = () => this.clips.set(this.snapshotClips());
    this.emitHeader = () => this.header.set(this.snapshotHeader());
    this.emitRecordLock = () => this.recordLock.set(this.getRecordLock());
    this.clipsArray.observeDeep(this.emitClips);
    this.projectMap.observe(this.emitHeader);
    this.recordLockMap.observe(this.emitRecordLock);

    if (typeof indexedDB !== 'undefined') {
      let persistence: IndexeddbPersistence | null = null;
      try {
        persistence = new IndexeddbPersistence(`looprecorder-${roomId}`, this.doc);
      } catch {
        persistence = null;
      }
      this.persistence = persistence;
    } else {
      this.persistence = null;
    }

    // Reflect anything already stored before the observers were attached.
    this.emitClips();
    this.emitHeader();
    this.emitRecordLock();
  }

  /** Resolves once the local IndexedDB copy has been loaded. */
  async whenSynced(): Promise<void> {
    if (!this.persistence) return;
    try {
      await this.persistence.whenSynced;
    } catch {
      /* offline / evicted storage — the in-memory doc is still valid */
    }
    this.emitClips();
    this.emitHeader();
    this.emitRecordLock();
  }

  private snapshotClips(): ClipRecord[] {
    const out: ClipRecord[] = [];
    for (const item of this.clipsArray) {
      if (item instanceof Y.Map) {
        const record = toRecord(item);
        if (record) out.push(record);
      }
    }
    return out;
  }

  private snapshotHeader(): ProjectHeader {
    const id = asString(this.projectMap.get('id'), '');
    const name = asString(this.projectMap.get('name'), DEFAULT_PROJECT_NAME);
    const schemaVersion = asNumber(this.projectMap.get('schemaVersion'), SCHEMA_VERSION);
    const sampleRateRaw = this.projectMap.get('sampleRate');
    const cycleFramesRaw = this.projectMap.get('cycleFrames');
    return {
      id,
      name,
      schemaVersion,
      sampleRate: typeof sampleRateRaw === 'number' ? sampleRateRaw : null,
      cycleFrames: typeof cycleFramesRaw === 'number' ? cycleFramesRaw : null,
      createdAt: asNumber(this.projectMap.get('createdAt')),
    };
  }

  getClips(): ClipRecord[] {
    return this.clips.get();
  }

  getHeader(): ProjectHeader {
    return this.header.get();
  }

  /**
   * Facts about the document itself, for the diagnostics report. Read-only, no side effects.
   *
   * Two of these exist to separate failures that look identical from the outside. `rawClips`
   * and `filteredClips` tell "the clip never arrived" apart from "it arrived and `toRecord()`
   * discarded it" — the Observable the UI reads only ever holds the filtered value.
   * `pendingStructs` and `bytes` tell "the update was dropped on the wire" apart from "it
   * arrived and Yjs could not integrate it", which is what an update applied without error
   * and without effect actually is.
   */
  debugFacts(): {
    clientID: number;
    bytes: number;
    rawClips: number;
    filteredClips: number;
    clipIds: string[];
    blobHashes: string[];
    firstClip: string;
    pendingStructs: boolean;
    header: ProjectHeader;
  } {
    const filtered = this.snapshotClips();
    let firstClip = 'none';
    for (const item of this.clipsArray) {
      if (item instanceof Y.Map) {
        try {
          firstClip = JSON.stringify(item.toJSON());
        } catch {
          firstClip = '(unserialisable)';
        }
        break;
      }
    }
    return {
      clientID: this.doc.clientID,
      bytes: Y.encodeStateAsUpdate(this.doc).byteLength,
      rawClips: this.clipsArray.length,
      filteredClips: filtered.length,
      clipIds: filtered.map((clip) => clip.id),
      blobHashes: [...new Set(filtered.map((clip) => clip.blobHash))],
      firstClip,
      pendingStructs: Boolean(
        (this.doc.store as unknown as { pendingStructs?: unknown }).pendingStructs,
      ),
      header: this.snapshotHeader(),
    };
  }

  setProjectName(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.projectMap.set('name', trimmed);
  }

  /**
   * Claims the shared loop length, which is **set-once**: the first take defines
   * the cycle and everyone else adopts it. Two peers recording the first take
   * simultaneously is a genuine conflict; it is reported rather than silently
   * resolved so the UI can surface it (see the design doc §9.2).
   */
  ensureCanonical(sampleRate: number, cycleFrames: number): CanonicalResult {
    const existingFrames = this.projectMap.get('cycleFrames');
    const existingRate = this.projectMap.get('sampleRate');
    const hasFrames = typeof existingFrames === 'number' && existingFrames > 0;
    const hasRate = typeof existingRate === 'number' && existingRate > 0;

    if (!hasFrames || !hasRate) {
      this.doc.transact(() => {
        if (!hasRate) this.projectMap.set('sampleRate', sampleRate);
        if (!hasFrames) this.projectMap.set('cycleFrames', cycleFrames);
      });
      return 'set';
    }

    const existingSeconds = (existingFrames as number) / (existingRate as number);
    const incomingSeconds = cycleFrames / sampleRate;
    const tolerance = Math.max(0.002, existingSeconds * 0.01);
    return Math.abs(existingSeconds - incomingSeconds) <= tolerance ? 'agreed' : 'conflict';
  }

  appendClip(meta: ClipMeta): boolean {
    // An id may be appended **once**, and that single rule is the whole guard: a tombstone
    // keeps its array entry with `deleted: true`, so "this id is already in the list" already
    // covers "this id was deleted". A deleted clip therefore cannot be re-appended even if a
    // future code path tries to — resurrection is impossible by construction instead of by
    // every caller remembering to check first — and a duplicate publish of a live id is a
    // no-op for the same reason. Same lookup shape as `tombstoneClip()`: both ask the one
    // question "is this id in the clip list?", and neither should be able to answer it
    // differently.
    for (const item of this.clipsArray) {
      if (item instanceof Y.Map && item.get('id') === meta.id) return false;
    }
    this.doc.transact(() => {
      const map = new Y.Map<unknown>();
      map.set('id', meta.id);
      map.set('authorId', meta.authorId);
      map.set('authorName', meta.authorName);
      map.set('createdAt', meta.createdAt);
      map.set('sampleRate', meta.sampleRate);
      map.set('cycleFrames', meta.cycleFrames);
      map.set('codec', meta.codec);
      map.set('blobHash', meta.blobHash);
      map.set('blobBytes', meta.blobBytes);
      map.set('slot', meta.slot);
      map.set('deleted', false);
      this.clipsArray.push([map]);
    });
    // `true` is "the clip is in the project now"; `false` is "it already was (or was deleted),
    // and nothing was written" — the caller has to report that rather than announce a share.
    return true;
  }

  /** Deletes are tombstones, so they commute with concurrent edits and offline time. */
  tombstoneClip(clipId: string): void {
    for (const item of this.clipsArray) {
      if (item instanceof Y.Map && item.get('id') === clipId) {
        item.set('deleted', true);
        return;
      }
    }
  }

  // -------------------------------------------------------- recording lease

  /**
   * The lease, or `null` when there is none — or when the one stored has run out.
   *
   * Expiry is evaluated here, on read, rather than by deleting anything: a device that
   * crashes or is closed mid-take can never send a release, so a claim that outlived its
   * holder would make the room look busy forever. Reading the wall clock instead means the
   * lease retires itself for every peer, with no traffic and no timer on their side.
   */
  getRecordLock(): RecordLock | null {
    const lock = this.readRecordLock();
    if (!lock) return null;
    return Date.now() - lock.at >= RECORD_LOCK_TTL_MS ? null : lock;
  }

  /**
   * Claims (or re-claims) the lease for `identity`.
   *
   * The write is deliberately four plain `Y.Map` sets. Two peers claiming at the same
   * moment is a genuine race, and Yjs already has a deterministic answer for it: the
   * concurrent write to a key with the higher client id wins. Because both sides write the
   * same four keys, every key resolves to the same winner, so both devices agree on one
   * holder — we do not need (and must not invent) a second tie-break.
   */
  claimRecordLock(identity: Pick<RecordLock, 'identityId' | 'name' | 'color'>): void {
    this.doc.transact(() => {
      this.recordLockMap.set('identityId', identity.identityId);
      this.recordLockMap.set('name', identity.name);
      this.recordLockMap.set('color', identity.color);
      this.recordLockMap.set('at', Date.now());
    });
  }

  /**
   * Pushes `at` forward without changing who holds the claim.
   *
   * Only the holder may refresh — checked against the stored identity id, so a device that
   * lost a concurrent claim cannot hijack the lease from the winner later.
   */
  refreshRecordLock(identityId: string): void {
    if (this.recordLockMap.get('identityId') !== identityId) return;
    this.recordLockMap.set('at', Date.now());
  }

  /**
   * Releases the claim, but only for its holder.
   *
   * The same identity check guards the release as guards the refresh: a stale or duplicated
   * release (say, from a take that ended after the claimant already left) must never clear a
   * claim that has since moved on to someone else.
   */
  releaseRecordLock(identityId: string): void {
    if (this.recordLockMap.get('identityId') !== identityId) return;
    const keys = [...this.recordLockMap.keys()];
    this.doc.transact(() => {
      // Delete every key rather than leaving `at` behind: a partial claim would read as
      // no claim anyway, but an empty map is the honest representation of "nobody".
      for (const key of keys) this.recordLockMap.delete(key);
    });
  }

  private readRecordLock(): RecordLock | null {
    const identityId = this.recordLockMap.get('identityId');
    if (typeof identityId !== 'string' || !identityId) return null;
    return {
      identityId,
      name: asString(this.recordLockMap.get('name'), ''),
      color: asString(this.recordLockMap.get('color'), '#4da3ff'),
      // A missing `at` reads as 0, which is ancient — i.e. a half-written claim from an
      // unknown client expires immediately instead of looking like a live recording.
      at: asNumber(this.recordLockMap.get('at')),
    };
  }

  // ------------------------------------------------------------------ sync

  encodeState(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.doc);
  }

  encodeDiff(stateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc, stateVector);
  }

  applyUpdate(update: Uint8Array, origin: unknown): void {
    Y.applyUpdate(this.doc, update, origin);
  }

  onDocUpdate(callback: (update: Uint8Array, origin: unknown) => void): () => void {
    const handler = (update: Uint8Array, origin: unknown): void => callback(update, origin);
    this.doc.on('update', handler);
    return () => this.doc.off('update', handler);
  }

  destroy(): void {
    this.clipsArray.unobserveDeep(this.emitClips);
    this.projectMap.unobserve(this.emitHeader);
    this.recordLockMap.unobserve(this.emitRecordLock);
    void this.persistence?.destroy();
    this.doc.destroy();
  }
}
