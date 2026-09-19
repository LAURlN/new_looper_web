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
import { SCHEMA_VERSION, type CanonicalResult, type ClipMeta, type ClipRecord, type ProjectHeader } from './types';

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

  private readonly projectMap: Y.Map<unknown>;
  private readonly clipsArray: Y.Array<Y.Map<unknown>>;
  private readonly persistence: IndexeddbPersistence | null;
  private readonly emitClips: () => void;
  private readonly emitHeader: () => void;

  constructor(roomId: string, projectName = DEFAULT_PROJECT_NAME) {
    this.doc = new Y.Doc();
    this.projectMap = this.doc.getMap(PROJECT_MAP);
    this.clipsArray = this.doc.getArray<Y.Map<unknown>>(CLIPS_ARRAY);

    this.clips = new Observable<ClipRecord[]>([]);
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
    this.clipsArray.observeDeep(this.emitClips);
    this.projectMap.observe(this.emitHeader);

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

  appendClip(meta: ClipMeta): void {
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
    void this.persistence?.destroy();
    this.doc.destroy();
  }
}
