/**
 * Collaboration controller: the seam between the audio engine and the network.
 *
 * It owns the shared document, the blob store and the P2P transport, and it is
 * the only place that knows about both "audio" and "network". The engine stays
 * ignorant of transport, and the transport stays ignorant of audio.
 *
 * Responsibilities:
 * - publish a committed local take as a content-addressed clip + blob
 * - adopt the shared (set-once) loop length
 * - fetch and decode clips that arrive from peers, then hand them to the engine
 * - presence, connection status, and the user-facing session snapshot
 */
import { Observable } from '../util/observable';
import type { LoopEngine } from '../audio/engine';
import { BlobStore } from './blobStore';
import { DEFAULT_CODEC, decodeClip, encodeWav16, sha256Hex } from './codec';
import { loadIdentity, type PeerIdentity } from './identity';
import { ProjectStore } from './projectStore';
import { P2PTransport, type JsonRecord, type TransportHandlers } from './transport';
import { buildShareUrl, clearRoomId, setRoomId } from './room';
import type { ClipRecord, CollabSnapshot, CommittedClip, ConnectionState, PresencePeer } from './types';

/** A peer that has not been heard from for this long is considered gone. */
const PRESENCE_TTL_MS = 15000;

/**
 * A cheap fingerprint of a snapshot, used to suppress no-op updates. Subscribers
 * re-render UI, and a rebuild that lands between `pointerdown` and `click` eats
 * the press — so "nothing changed" must mean "nothing is published".
 */
function snapshotKey(snapshot: CollabSnapshot): string {
  const peers = snapshot.peers.map((peer) => `${peer.peerId}:${peer.name}:${peer.color}`).join(',');
  return [
    snapshot.active ? 'y' : 'n',
    snapshot.roomId ?? '',
    snapshot.connection,
    snapshot.status ?? '',
    snapshot.pendingClips,
    peers,
  ].join('|');
}
/** How long we keep re-asking for a blob before giving up (a peer may re-seed later). */
const BLOB_REQUEST_TIMEOUT_MS = 20000;
const PRESENCE_SWEEP_MS = 5000;

export class CollaborationController {
  readonly snapshot: Observable<CollabSnapshot>;

  private readonly identity: PeerIdentity;
  private readonly blobs = new BlobStore();
  private readonly presencePeers = new Map<string, PresencePeer>();
  private readonly rejected = new Set<string>();
  /** Hashes we are actively waiting for, mapped to their give-up timer. */
  private readonly pending = new Map<string, number>();

  private store: ProjectStore | null = null;
  private transport: P2PTransport | null = null;
  private engine: LoopEngine | null = null;
  private roomId: string | null = null;
  private detachDocUpdate: (() => void) | null = null;
  private detachClips: (() => void) | null = null;
  private pruneTimer: number | null = null;
  private connection: ConnectionState = 'idle';
  private statusMessage: string | null = null;
  private lastSnapshotKey: string | null = null;
  private pumping = false;
  private repump = false;
  private destroyed = false;

  constructor() {
    this.identity = loadIdentity();
    this.snapshot = new Observable<CollabSnapshot>({
      active: false,
      roomId: null,
      connection: 'idle',
      peers: [],
      status: null,
      pendingClips: 0,
    });
  }

  getIdentity(): PeerIdentity {
    return this.identity;
  }

  getRoomId(): string | null {
    return this.roomId;
  }

  isActive(): boolean {
    return this.store !== null;
  }

  shareUrl(): string | null {
    return this.roomId ? buildShareUrl(this.roomId) : null;
  }

  /** Called once at startup. In solo use nothing is published until a room is joined. */
  attachEngine(engine: LoopEngine): void {
    this.engine = engine;
    engine.setLocalAuthor(this.identity.id);
    engine.onClipCommitted((clip) => {
      void this.publishClip(clip);
    });
    engine.onClipRemoved((clipId) => {
      this.store?.tombstoneClip(clipId);
    });
  }

  async start(roomId: string): Promise<void> {
    if (this.destroyed) return;
    if (this.store) await this.stop();

    this.roomId = roomId;
    setRoomId(roomId);
    this.presencePeers.clear();
    this.rejected.clear();
    this.pending.clear();
    this.connection = 'searching';
    this.statusMessage = null;
    this.emit();

    const store = new ProjectStore(roomId);
    this.store = store;
    await store.whenSynced();
    if (this.destroyed || this.store !== store) return;

    this.detachClips = store.clips.subscribe(() => {
      void this.pump();
      this.emit();
    });

    this.detachDocUpdate = store.onDocUpdate((update, origin) => {
      // Flood each update onward, except back to the peer it came from. Yjs
      // updates are idempotent, so duplicates are no-ops and the flood settles.
      const fromPeer = typeof origin === 'string' && origin.startsWith('peer:') ? origin.slice(5) : undefined;
      void this.transport?.sendUpdate(update, fromPeer);
    });

    const transport = new P2PTransport(roomId, this.identity, this.buildHandlers());
    this.transport = transport;
    transport.start();

    this.pruneTimer = window.setInterval(() => this.prunePresence(), PRESENCE_SWEEP_MS);

    // If this device already had a solo loop, claim it as the shared loop now.
    this.claimLocalLoopIfNeeded();
    void this.pump();
  }

  async stop(): Promise<void> {
    if (this.pruneTimer !== null) {
      window.clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.detachDocUpdate?.();
    this.detachDocUpdate = null;
    this.detachClips?.();
    this.detachClips = null;

    this.transport?.stop();
    this.transport = null;

    for (const timer of this.pending.values()) window.clearTimeout(timer);
    this.pending.clear();

    this.store?.destroy();
    this.store = null;
    this.roomId = null;
    clearRoomId();
    this.presencePeers.clear();
    this.rejected.clear();
    this.connection = 'idle';
    this.statusMessage = null;
    this.emit();
  }

  destroy(): void {
    this.destroyed = true;
    void this.stop();
  }

  setProjectName(name: string): void {
    this.store?.setProjectName(name);
  }

  /** Flush anything waiting on the AudioContext (called after a user gesture). */
  async pumpPublic(): Promise<void> {
    await this.pump();
  }

  // ------------------------------------------------------------- publishing

  private async publishClip(clip: CommittedClip): Promise<void> {
    const store = this.store;
    if (!store) return; // solo: nothing to share
    try {
      this.claimLoop(store, clip.sampleRate, clip.cycleFrames);
      const bytes = encodeWav16(clip.samples, clip.sampleRate);
      const hash = await sha256Hex(bytes);
      await this.blobs.put({
        hash,
        bytes,
        codec: DEFAULT_CODEC,
        sampleRate: clip.sampleRate,
        cycleFrames: clip.cycleFrames,
        createdAt: Date.now(),
      });
      store.appendClip({
        id: clip.id,
        authorId: clip.authorId,
        authorName: this.identity.name,
        createdAt: Date.now(),
        sampleRate: clip.sampleRate,
        cycleFrames: clip.cycleFrames,
        codec: DEFAULT_CODEC,
        blobHash: hash,
        blobBytes: bytes.byteLength,
        slot: clip.slot,
      });
      // Tell the room we can serve these bytes (the room is its own CDN).
      await this.transport?.sendBlobHave({
        hash,
        bytes: bytes.byteLength,
        sampleRate: clip.sampleRate,
        cycleFrames: clip.cycleFrames,
        codec: DEFAULT_CODEC,
      });
    } catch (error) {
      this.statusMessage = error instanceof Error ? error.message : 'Could not share the take';
      this.emit();
    }
  }

  /** Publishes layers that existed before the session started. */
  private async publishExistingLayers(): Promise<void> {
    const store = this.store;
    const engine = this.engine;
    if (!store || !engine) return;
    const sampleRate = engine.getSampleRate();
    if (sampleRate === null) return;
    const known = new Set(store.getClips().map((clip) => clip.id));
    for (const layer of engine.getLayersForSharing()) {
      if (known.has(layer.id)) continue;
      await this.publishClip({
        id: layer.id,
        authorId: layer.authorId,
        samples: layer.samples,
        sampleRate,
        cycleFrames: layer.samples.length,
        slot: layer.slot,
        isFirst: layer.slot === 0,
      });
    }
  }

  private claimLocalLoopIfNeeded(): void {
    const store = this.store;
    const engine = this.engine;
    if (!store || !engine) return;
    const frames = engine.getLoopLengthFrames();
    const rate = engine.getSampleRate();
    if (frames > 0 && rate !== null) this.claimLoop(store, rate, frames);
  }

  private claimLoop(store: ProjectStore, sampleRate: number, cycleFrames: number): void {
    if (store.ensureCanonical(sampleRate, cycleFrames) === 'conflict') {
      this.statusMessage =
        'Two different loop lengths were recorded at the same time. Clips for the other length will be skipped.';
      this.emit();
    }
  }

  // ------------------------------------------------------------ ingestion

  /** Applies the shared document to the engine: fetch, decode, add, remove. */
  private async pump(): Promise<void> {
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.repump = false;
        await this.pumpOnce();
      } while (this.repump && !this.destroyed);
    } finally {
      this.pumping = false;
    }
    this.emit();
  }

  private async pumpOnce(): Promise<void> {
    const store = this.store;
    const engine = this.engine;
    if (!store || !engine || !engine.hasAudioContext()) return;

    // Share anything recorded before the session existed.
    await this.publishExistingLayers();

    const clips = store.getClips();

    // Removals first, so a tombstone is honoured even if the blob never arrives.
    for (const clip of clips) {
      if (clip.deleted && engine.hasLayer(clip.id)) engine.removeLayer(clip.id);
    }

    for (const clip of clips) {
      if (clip.deleted || engine.hasLayer(clip.id) || this.rejected.has(clip.id)) continue;

      if (!this.isCompatible(engine, clip)) {
        this.rejected.add(clip.id);
        this.statusMessage = 'A clip was recorded against a different loop length, so it was not added.';
        continue;
      }

      const stored = await this.blobs.get(clip.blobHash);
      if (!stored) {
        this.requestBlob(clip.blobHash);
        continue;
      }

      try {
        const samples = await decodeClip(stored.bytes, engine.audioContext());
        if (samples.length === 0) {
          this.rejected.add(clip.id);
          continue;
        }
        engine.addRemoteLayer({ id: clip.id, authorId: clip.authorId, samples });
      } catch {
        this.rejected.add(clip.id);
        this.statusMessage = 'A clip could not be decoded on this device and was skipped.';
      }
    }
  }

  /** A clip only joins the live loop if its duration matches the shared loop. */
  private isCompatible(engine: LoopEngine, clip: ClipRecord): boolean {
    if (clip.sampleRate <= 0 || clip.cycleFrames <= 0) return false;
    if (engine.getLoopLengthFrames() <= 0) return true; // this clip defines the loop
    const rate = engine.getSampleRate();
    if (rate === null) return false;
    const localSeconds = engine.getLoopLengthFrames() / rate;
    const clipSeconds = clip.cycleFrames / clip.sampleRate;
    return Math.abs(clipSeconds - localSeconds) <= Math.max(0.002, localSeconds * 0.01);
  }

  private requestBlob(hash: string): void {
    if (this.pending.has(hash) || !this.transport) return;
    const timer = window.setTimeout(() => {
      this.pending.delete(hash);
      this.emit();
    }, BLOB_REQUEST_TIMEOUT_MS);
    this.pending.set(hash, timer);
    void this.transport.sendBlobWant(hash);
  }

  // ----------------------------------------------------------- transport in

  private buildHandlers(): TransportHandlers {
    return {
      onPeerJoin: (peerId) => {
        const store = this.store;
        const transport = this.transport;
        if (store && transport) {
          // Hand the newcomer only the difference between our doc and theirs.
          void transport.sendStateVector(peerId, store.encodeStateVector());
        }
        void this.announceBlobsTo(peerId);
        void this.pump();
        this.emit();
      },
      onPeerLeave: (peerId) => {
        this.presencePeers.delete(peerId);
        this.emit();
      },
      onPeersChanged: () => this.emit(),
      onUpdate: (update, fromPeer) => {
        // The origin is what stops an update echoing straight back to its sender.
        this.store?.applyUpdate(update, `peer:${fromPeer}`);
      },
      onStateVector: (peerId, vector) => {
        const store = this.store;
        const transport = this.transport;
        if (store && transport) void transport.sendUpdate(store.encodeDiff(vector), peerId);
      },
      onPresence: (peerId, payload) => {
        this.presencePeers.set(peerId, {
          peerId,
          identityId: typeof payload.identityId === 'string' ? payload.identityId : peerId,
          name: typeof payload.name === 'string' ? payload.name : peerId.slice(0, 6),
          color: typeof payload.color === 'string' ? payload.color : '#4da3ff',
          lastSeen: Date.now(),
        });
        this.emit();
      },
      onBlobHave: (peerId, payload) => {
        void this.handleBlobHave(peerId, payload);
      },
      onBlobWant: (peerId, payload) => {
        void this.handleBlobWant(peerId, payload);
      },
      onBlobData: (peerId, bytes, metadata) => {
        void this.handleBlobData(peerId, bytes, metadata);
      },
      onStatus: (connection, message) => {
        this.connection = connection;
        this.statusMessage = message;
        this.emit();
      },
    };
  }

  private async handleBlobHave(peerId: string, payload: JsonRecord): Promise<void> {
    const hash = typeof payload.hash === 'string' ? payload.hash : '';
    if (!hash) return;
    if (await this.blobs.has(hash)) return;
    // Only ask for bytes this project actually references.
    const wanted = this.store?.getClips().some((clip) => !clip.deleted && clip.blobHash === hash) ?? false;
    if (wanted || this.pending.has(hash)) await this.transport?.sendBlobWant(hash, peerId);
  }

  private async handleBlobWant(peerId: string, payload: JsonRecord): Promise<void> {
    const hash = typeof payload.hash === 'string' ? payload.hash : '';
    if (!hash) return;
    const stored = await this.blobs.get(hash);
    if (!stored) return;
    await this.transport?.sendBlobData(
      stored.bytes,
      { hash, sampleRate: stored.sampleRate, cycleFrames: stored.cycleFrames, codec: stored.codec },
      peerId,
    );
  }

  private async handleBlobData(_peerId: string, bytes: ArrayBuffer, metadata: JsonRecord | null): Promise<void> {
    const hash = metadata && typeof metadata.hash === 'string' ? metadata.hash : '';
    if (!hash) return;
    try {
      // Verify before storing: content addressing only helps if we check it.
      const actual = await sha256Hex(bytes);
      if (actual !== hash) {
        this.statusMessage = 'Received audio failed its integrity check and was discarded.';
        this.emit();
        return;
      }
      await this.blobs.put({
        hash,
        bytes,
        codec: DEFAULT_CODEC,
        sampleRate: metadata && typeof metadata.sampleRate === 'number' ? metadata.sampleRate : 0,
        cycleFrames: metadata && typeof metadata.cycleFrames === 'number' ? metadata.cycleFrames : 0,
        createdAt: Date.now(),
      });
      const timer = this.pending.get(hash);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        this.pending.delete(hash);
      }
      void this.pump();
    } catch {
      /* hashing unavailable — nothing we can safely store */
    }
  }

  /** Re-seed: tell a newly arrived peer which blobs we can serve. */
  private async announceBlobsTo(peerId: string): Promise<void> {
    const store = this.store;
    if (!store) return;
    for (const clip of store.getClips()) {
      if (clip.deleted) continue;
      if (await this.blobs.has(clip.blobHash)) {
        await this.transport?.sendBlobHave(
          {
            hash: clip.blobHash,
            bytes: clip.blobBytes,
            sampleRate: clip.sampleRate,
            cycleFrames: clip.cycleFrames,
            codec: clip.codec,
          },
          peerId,
        );
      }
    }
  }

  // ---------------------------------------------------------------- status

  private prunePresence(): void {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    let changed = false;
    for (const [peerId, peer] of this.presencePeers) {
      if (peer.lastSeen < cutoff) {
        this.presencePeers.delete(peerId);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private emit(): void {
    const engine = this.engine;
    const peers = [...this.presencePeers.values()].sort((a, b) => a.name.localeCompare(b.name));
    const pendingClips = engine
      ? (this.store?.getClips().filter((clip) => !clip.deleted && !engine.hasLayer(clip.id)).length ?? 0)
      : 0;
    const next: CollabSnapshot = {
      active: this.store !== null,
      roomId: this.roomId,
      connection: this.store ? this.connection : 'idle',
      peers,
      status: this.statusMessage,
      pendingClips,
    };
    // The pump emits on every pointerdown (it doubles as the retry trigger for
    // gestures), so publishing an identical snapshot would re-render the sheet
    // for no reason — and cancel whatever the user was in the middle of pressing.
    const key = snapshotKey(next);
    if (key === this.lastSnapshotKey) return;
    this.lastSnapshotKey = key;
    this.snapshot.set(next);
  }
}
