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
import type {
  ClipRecord,
  CollabSnapshot,
  CommittedClip,
  ConnectionState,
  PresencePeer,
  RemoteRecording,
} from './types';

/** A peer that has not been heard from for this long is considered gone. */
const PRESENCE_TTL_MS = 15000;

/**
 * How often a device that is still recording pushes its claim's `at` forward.
 *
 * A refresh is a single key in a single map, so it is cheap enough to run blind while a take
 * lasts — and it is what separates "still recording" from "gone" for everyone else.
 */
const RECORD_LOCK_REFRESH_MS = 15000;

/**
 * A cheap fingerprint of a snapshot, used to suppress no-op updates. Subscribers
 * re-render UI, and a rebuild that lands between `pointerdown` and `click` eats
 * the press — so "nothing changed" must mean "nothing is published".
 */
function snapshotKey(snapshot: CollabSnapshot): string {
  const peers = snapshot.peers.map((peer) => `${peer.peerId}:${peer.name}:${peer.color}`).join(',');
  // `since` is part of the key on purpose: a holder refreshes every 15 s, and the Session
  // tab shows how long ago that was, so the rendering has to follow the claim.
  const remote = snapshot.remoteRecording;
  return [
    snapshot.active ? 'y' : 'n',
    snapshot.roomId ?? '',
    snapshot.connection,
    snapshot.status ?? '',
    snapshot.pendingClips,
    remote ? `${remote.name}:${remote.color}:${remote.since}` : '',
    peers,
  ].join('|');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How many transports this page has created.
 *
 * One per session is correct. More than one means the page joined twice — and because Trystero
 * hands back the same room object for a repeated join, the second join would overwrite the
 * first one's message handlers, which looks exactly like "the document never arrives".
 */
let transportStarts = 0;

/**
 * Minimum gap between two `blob-want` asks for the same hash.
 *
 * This is a throttle, not a deadline: hammering the room is pointless, but an
 * outstanding request must never turn into a permanent failure.
 */
const BLOB_REQUEST_INTERVAL_MS = 5000;
const PRESENCE_SWEEP_MS = 5000;
/**
 * How often the anti-entropy pulse runs: state vectors out, missing audio re-asked.
 *
 * The join handshake fires exactly once from `onPeerJoin`, so one lost exchange
 * would otherwise leave two peers divergent until the next edit.
 */
const PULSE_INTERVAL_MS = 2000;

export class CollaborationController {
  readonly snapshot: Observable<CollabSnapshot>;

  private readonly identity: PeerIdentity;
  private readonly blobs = new BlobStore();
  private readonly presencePeers = new Map<string, PresencePeer>();
  /** Blob hashes this device cannot decode. Deterministic, so worth remembering. */
  private readonly undecodable = new Set<string>();
  /** Hashes we have asked for, mapped to when we last asked — a throttle, not a deadline. */
  private readonly pending = new Map<string, number>();

  private store: ProjectStore | null = null;
  private transport: P2PTransport | null = null;
  private engine: LoopEngine | null = null;
  private roomId: string | null = null;
  private detachDocUpdate: (() => void) | null = null;
  private detachClips: (() => void) | null = null;
  private detachHeader: (() => void) | null = null;
  private detachRecordLock: (() => void) | null = null;
  private pruneTimer: number | null = null;
  private pulseTimer: number | null = null;
  /** Exists only while a local take is running, and only while there is a room to tell. */
  private recordLockTimer: number | null = null;
  /** The non-fatal "recording too" line, kept so it can be retired without clobbering a warning. */
  private remoteRecordNote: string | null = null;
  private connection: ConnectionState = 'idle';
  private statusMessage: string | null = null;
  private lastSnapshotKey: string | null = null;
  private pumping = false;
  private repump = false;
  private destroyed = false;
  /** Last clip count written to the console, so a document change is announced once. */
  private lastLoggedClipCount = -1;

  /**
   * Counters for the diagnostics report. Nothing here changes behaviour: the point is to be
   * able to tell "the peer never got it" apart from "we never sent it" from two phones.
   */
  private readonly diag = {
    published: 0,
    publishErrors: 0,
    applied: 0,
    applyErrors: 0,
    encodeErrors: 0,
    lastError: null as string | null,
  };

  constructor() {
    this.identity = loadIdentity();
    this.snapshot = new Observable<CollabSnapshot>({
      active: false,
      roomId: null,
      connection: 'idle',
      peers: [],
      status: null,
      pendingClips: 0,
      remoteRecording: null,
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

  /**
   * A paste-ready description of what this device believes and what it has actually sent.
   *
   * "Nothing syncs" is otherwise indistinguishable from "nothing was sent": every send in the
   * transport sits behind a `catch {}` and every handler call is fire-and-forget, so a failure
   * leaves no trace. `doc:` is the ground truth (what the shared document holds *here*), and
   * the wire lines name both directions, so two of these reports pin the failure to a link.
   */
  diagnosticsReport(): string {
    const engine = this.engine;
    const store = this.store;
    const wire = this.transport ? this.transport.wireStats : null;
    const header = store ? store.getHeader() : null;
    const clips = store ? store.getClips() : [];
    const deleted = clips.filter((clip) => clip.deleted).length;
    // The document read directly, as well as through the Observable the UI displays: an id
    // present in `clipsArray` but absent from `clips` means the write arrived and was
    // filtered out, which is a different bug from the write never arriving at all.
    const facts = store ? store.debugFacts() : null;

    let canonical = 'none';
    if (header && header.sampleRate && header.cycleFrames) {
      canonical = `${header.cycleFrames} frames @ ${header.sampleRate} Hz (${(
        header.cycleFrames / header.sampleRate
      ).toFixed(2)} s)`;
    }

    const loopFrames = engine ? engine.getLoopLengthFrames() : 0;
    const sampleRate = engine ? engine.getSampleRate() : null;
    let loop = 'none';
    if (loopFrames > 0 && sampleRate) {
      loop = `${loopFrames} frames @ ${sampleRate} Hz (${(loopFrames / sampleRate).toFixed(2)} s)`;
    }

    let context = 'none';
    if (engine && engine.hasAudioContext()) context = engine.audioContext().state;

    return [
      'loop-recorder session diagnostics',
      `when: ${new Date().toISOString()}`,
      `agent: ${navigator.userAgent}`,
      `secure context: ${window.isSecureContext ? 'yes' : 'NO'}`,
      `room: ${this.roomId ?? '-'}   me: ${this.identity.id} (${this.identity.name})`,
      `connection: ${this.connection}   known peers: ${
        this.transport ? this.transport.peerIds.length : 0
      }   presence peers: ${this.presencePeers.size}`,
      `doc: clips ${clips.length} (deleted ${deleted})   canonical loop: ${canonical}`,
      `doc raw: ${facts ? facts.rawClips : '-'} in the array, ${facts ? facts.filteredClips : '-'} after filtering, ${facts ? facts.bytes : '-'} bytes, clientID ${facts ? facts.clientID : '-'}, pending structs: ${facts ? (facts.pendingStructs ? 'YES' : 'no') : '-'}`,
      `header raw: sampleRate ${facts ? String(facts.header.sampleRate) : '-'}, cycleFrames ${facts ? String(facts.header.cycleFrames) : '-'}, project id ${facts ? facts.header.id : '-'}`,
      `doc clip ids: ${facts && facts.clipIds.length > 0 ? facts.clipIds.join(', ') : 'none'}`,
      `doc blob hashes: ${facts && facts.blobHashes.length > 0 ? facts.blobHashes.join(', ') : 'none'}`,
      `doc first clip: ${facts ? facts.firstClip : '-'}`,
      `transports started this page: ${transportStarts}`,
      `engine: loop ${loop}   shared loop: ${
        engine && engine.hasSharedLoop() ? 'yes' : 'no'
      }   state: ${engine ? engine.state.get().state : 'n/a'}   context: ${context}`,
      `published: ${this.diag.published} clip(s), ${this.diag.publishErrors} error(s)`,
      `applied: ${this.diag.applied} update(s), ${this.diag.applyErrors} apply error(s), ${
        this.diag.encodeErrors
      } encode error(s)`,
      `y-upd: out ${wire ? wire.updOut : '-'} (${wire ? wire.updOutBytes : '-'} b, ${
        wire ? wire.updOutErrors : '-'
      } err)   in ${wire ? wire.updIn : '-'}`,
      `y-sv: out ${wire ? wire.svOut : '-'} (${wire ? wire.svOutErrors : '-'} err)   in ${
        wire ? wire.svIn : '-'
      }`,
      `blobs: out ${wire ? wire.blobOut : '-'}   in ${wire ? wire.blobIn : '-'}   pending wants: ${
        this.pending.size
      }   undecodable: ${this.undecodable.size}`,
      `last error: ${this.diag.lastError ?? (wire ? wire.lastError : null) ?? 'none'}`,
    ].join('\n');
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
    // The engine's take edges are the only honest trigger for the lease. Both handlers do
    // nothing without a room (see `claimRecordLock`), which is what keeps solo use free of
    // lock writes and timers.
    engine.onTakeStarted(() => this.claimRecordLock());
    engine.onTakeEnded(() => this.releaseRecordLock());
  }

  // ------------------------------------------------------------ recording lease

  /**
   * Publishes "this device is recording right now" into the shared document.
   *
   * Nothing here can refuse a take: the claim is an indication, not a guard. The clip this
   * device is recording is merged by the document exactly as it would be otherwise, and a
   * peer that happens to be recording at the same moment simply says so.
   */
  private claimRecordLock(): void {
    const store = this.store;
    if (!store) return; // solo: no room, so no claim write and no timer
    // Read the other device's claim *before* writing ours, so the sentence describes the
    // room as the user found it.
    const other = this.remoteRecording();
    if (other) {
      this.remoteRecordNote = `${other.name} is recording too — your take will be added alongside.`;
      this.statusMessage = this.remoteRecordNote;
    }
    store.claimRecordLock({
      identityId: this.identity.id,
      name: this.identity.name,
      color: this.identity.color,
    });
    this.startRecordLockRefresh(store);
    this.emit();
  }

  /**
   * Drops the claim. Every way a take can end lands here — commit, discard, abort — and so
   * do `stop()` and `destroy()`, because leaving a session must never leave the indicator
   * lit on the other phone.
   */
  private releaseRecordLock(): void {
    if (this.recordLockTimer !== null) {
      window.clearInterval(this.recordLockTimer);
      this.recordLockTimer = null;
    }
    // The store only honours a release from the holder, so a late or duplicated release can
    // never clear a claim that has meanwhile been taken over by somebody else.
    this.store?.releaseRecordLock(this.identity.id);
    // Retire the "recording too" line, but only while it is still the message on screen: a
    // real warning written during the take has to survive.
    if (this.remoteRecordNote !== null && this.statusMessage === this.remoteRecordNote) {
      this.statusMessage = null;
    }
    this.remoteRecordNote = null;
    this.emit();
  }

  /**
   * Keeps the claim unexpired for as long as the take lasts.
   *
   * One refresh is a single key write, so it is cheap enough to run blind — and it is the
   * only thing that tells "still recording" apart from "gone", so a five-minute take stays
   * visible while a phone that died quietly stops being after a minute.
   */
  private startRecordLockRefresh(store: ProjectStore): void {
    if (this.recordLockTimer !== null) return;
    this.recordLockTimer = window.setInterval(
      () => store.refreshRecordLock(this.identity.id),
      RECORD_LOCK_REFRESH_MS,
    );
  }

  /**
   * Another peer's unexpired claim, or `null`.
   *
   * Expiry is applied on read, so a holder that vanishes needs no cleanup message from
   * anyone. A claim of our own is filtered out here: this device must never report its own
   * take as "someone else is recording".
   */
  private remoteRecording(): RemoteRecording | null {
    const lock = this.store?.getRecordLock() ?? null;
    if (!lock || lock.identityId === this.identity.id) return null;
    return { name: lock.name, color: lock.color, since: lock.at };
  }

  async start(roomId: string): Promise<void> {
    if (this.destroyed) return;
    if (this.store) await this.stop();

    this.roomId = roomId;
    setRoomId(roomId);
    this.presencePeers.clear();
    this.undecodable.clear();
    this.pending.clear();
    this.connection = 'searching';
    this.statusMessage = null;
    this.emit();

    const store = new ProjectStore(roomId);
    this.store = store;
    await store.whenSynced();
    if (this.destroyed || this.store !== store) return;

    this.detachClips = store.clips.subscribe(() => {
      this.logClipCount();
      void this.pump();
      this.emit();
    });

    // The set-once loop length lives in the header, and until now nothing ever read it
    // back — a device that joined without a loop of its own never learned the session's
    // cycle. Subscribing fires once immediately (so a length already persisted in
    // IndexedDB is picked up too), and on every later header change the engine adopts the
    // canonical length before the clips that depend on it are re-evaluated.
    this.detachHeader = store.header.subscribe(() => {
      this.adoptCanonicalLoop();
      void this.pump();
    });

    // The lease is an ordinary document write, so a remote claim arrives through the same
    // update path as everything else — this subscription is what turns it into UI.
    this.detachRecordLock = store.recordLock.subscribe(() => this.emit());

    this.detachDocUpdate = store.onDocUpdate((update, origin) => {
      // Flood each update onward, except back to the peer it came from. Yjs
      // updates are idempotent, so duplicates are no-ops and the flood settles.
      const fromPeer = typeof origin === 'string' && origin.startsWith('peer:') ? origin.slice(5) : undefined;
      void this.transport?.sendUpdate(update, fromPeer);
    });

    const transport = new P2PTransport(roomId, this.identity, this.buildHandlers());
    this.transport = transport;
    transportStarts++;
    transport.start();

    this.pruneTimer = window.setInterval(() => this.prunePresence(), PRESENCE_SWEEP_MS);
    // Anti-entropy, not a heartbeat: cheap enough to run blind, and it is the only
    // thing that heals a handshake or a transfer that was lost on the first try.
    this.pulseTimer = window.setInterval(() => this.pulse(), PULSE_INTERVAL_MS);

    // If this device already had a solo loop, claim it as the shared loop now.
    this.claimLocalLoopIfNeeded();
    void this.pump();
  }

  async stop(): Promise<void> {
    // Release first, while the transport is still up, so the other phone hears about it
    // immediately instead of waiting out the TTL.
    this.releaseRecordLock();
    if (this.pruneTimer !== null) {
      window.clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.pulseTimer !== null) {
      window.clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
    this.detachDocUpdate?.();
    this.detachDocUpdate = null;
    this.detachClips?.();
    this.detachClips = null;
    this.detachHeader?.();
    this.detachHeader = null;
    this.detachRecordLock?.();
    this.detachRecordLock = null;

    this.transport?.stop();
    this.transport = null;

    // Request times only; nothing is left behind by clearing them.
    this.pending.clear();

    this.store?.destroy();
    this.store = null;
    this.roomId = null;
    clearRoomId();
    this.presencePeers.clear();
    this.undecodable.clear();
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
      const appended = store.appendClip({
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
      // A refusal means this id is already in the shared document: either a duplicate publish,
      // or a clip this device (or a peer) tombstoned — the store keeps a deleted clip's entry,
      // which is what makes the guard cover deletion at all. Either way the take is not part of
      // the project, so it must not be announced: a `blob-have` for a clip no record references
      // would only make peers ask for audio they can never use. Report it the same way the
      // catch below does, so the user sees that the take was kept locally but not shared.
      if (!appended) {
        this.statusMessage = 'That take is already in the session, so it was not shared again.';
        this.emit();
        return;
      }
      this.diag.published++;
      // One line per take: this is the proof that this device's audio reached the document.
      console.info(
        `[collab] published clip ${clip.id.slice(0, 8)} (${clip.cycleFrames} frames, ${
          bytes.byteLength
        } b, first=${clip.isFirst})`,
      );
      // Tell the room we can serve these bytes (the room is its own CDN).
      await this.transport?.sendBlobHave({
        hash,
        bytes: bytes.byteLength,
        sampleRate: clip.sampleRate,
        cycleFrames: clip.cycleFrames,
        codec: DEFAULT_CODEC,
      });
    } catch (error) {
      this.diag.publishErrors++;
      this.diag.lastError = `publish: ${errorText(error)}`;
      console.warn(`[collab] ${this.diag.lastError}`);
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
    if (store.ensureCanonical(sampleRate, cycleFrames) !== 'conflict') return;
    // The header already owns a different length. Say which two lengths are in play and
    // what the way out is — the same wording the read side uses, so the user reads one
    // story about the conflict rather than two differently worded ones.
    const header = store.getHeader();
    const headerRate = header.sampleRate;
    const headerFrames = header.cycleFrames;
    const hasCanonical =
      headerRate !== null && headerRate > 0 && headerFrames !== null && headerFrames > 0;
    this.statusMessage =
      hasCanonical && sampleRate > 0
        ? this.conflictMessage(headerFrames / headerRate, cycleFrames / sampleRate)
        : 'This device has a loop of a different length than the session. Undo your layers to join the session loop.';
    this.emit();
  }

  /** One wording for the "two loop lengths" conflict, shared by the writer and the reader side. */
  private conflictMessage(sessionSeconds: number, deviceSeconds: number): string {
    return `This device has a loop of a different length (${deviceSeconds.toFixed(1)} s) than the session (${sessionSeconds.toFixed(1)} s). Undo your layers to join the session loop.`;
  }

  // ----------------------------------------------------------- canonical loop

  /**
   * The read side of the set-once loop length.
   *
   * `ensureCanonical()` has always written `sampleRate`/`cycleFrames` into the header and
   * those values replicate and merge correctly — but nothing ever consulted them, so a
   * device that joined a room without a loop of its own never learned the session's cycle.
   * This turns that stored value into a loop the engine can actually play.
   *
   * The header holds the *writing* device's hardware rate, while a loop on this device is
   * always expressed in this context's frames, so the length is converted by the ratio of
   * the two rates: a 3.4 s cycle is `3.4 * localRate` frames here, whatever the two
   * contexts happen to run at. (`decodeClip()` already puts arriving audio at the local
   * rate, so the rates themselves never have to be reconciled anywhere else.)
   */
  private adoptCanonicalLoop(): void {
    const store = this.store;
    const engine = this.engine;
    // Without a context there is nowhere to anchor a cycle; the next pump after the
    // context exists adopts it instead — which is why `pumpOnce()` calls this too.
    if (!store || !engine || !engine.hasAudioContext()) return;
    const header = store.getHeader();
    const headerRate = header.sampleRate;
    const headerFrames = header.cycleFrames;
    if (headerRate === null || headerRate <= 0) return;
    if (headerFrames === null || headerFrames <= 0) return;
    const localRate = engine.getSampleRate();
    if (localRate === null) return;

    const canonicalSeconds = headerFrames / headerRate;
    const localFrames = Math.round((headerFrames * localRate) / headerRate);
    if (engine.adoptSharedLoop(localFrames)) {
      // Announce only a real adoption: the header re-emits on every project edit and this
      // also runs on every pump, so an unconditional message would be constant noise.
      this.statusMessage = `Joined the shared loop: ${canonicalSeconds.toFixed(1)} s`;
      return;
    }

    const localLoopFrames = engine.getLoopLengthFrames();
    if (localLoopFrames <= 0) return;
    // A cycle that already came from the shared state is the same loop — any difference is
    // just the rounding of the rate conversion above.
    if (engine.hasSharedLoop()) return;
    const localSeconds = localLoopFrames / localRate;
    if (Math.abs(localSeconds - canonicalSeconds) <= Math.max(0.002, canonicalSeconds * 0.01)) {
      return;
    }
    // This device is holding a loop it defined before the session's length was known. The
    // canonical value wins, but the engine deliberately refuses to clobber audible work,
    // so the way out is to undo the layers that defined the local loop. Clips skipped for
    // this reason stay non-sticky: every later pass re-evaluates them once it is resolved.
    this.statusMessage = this.conflictMessage(canonicalSeconds, localSeconds);
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

  /**
   * Applies the shared document. The store/network half always runs; only the
   * audio half needs an AudioContext.
   *
   * That split is the whole point: an AudioContext is created with the microphone,
   * on a gesture — so a device that joins a session and never records would
   * otherwise never fetch, decode or play anything.
   */
  private async pumpOnce(): Promise<void> {
    const store = this.store;
    const engine = this.engine;
    if (!store || !engine) return;

    // Read the canonical length back before anything is compared against it: this is what
    // turns "the header says 3.4 s" into "this engine is cycling 3.4 s". Running it on
    // every pass is what lets a context created *after* the header still adopt the loop,
    // and it is cheap: it never throws and never clobbers a loop this device owns.
    this.adoptCanonicalLoop();

    // Share anything recorded before the session existed. Needs a sample rate,
    // which only exists with a context; it returns early on its own and must not
    // stop the rest of the pass.
    await this.publishExistingLayers();

    const audioReady = engine.hasAudioContext();
    const clips = store.getClips();

    // Removals first, so a tombstone is honoured even if the blob never arrives.
    // Actually dropping the audio touches the scheduler, so this half is the one
    // that needs a context; the document is already correct either way.
    if (audioReady) {
      for (const clip of clips) {
        if (clip.deleted && engine.hasLayer(clip.id)) engine.removeLayer(clip.id);
      }
    }

    for (const clip of clips) {
      if (clip.deleted || engine.hasLayer(clip.id)) continue;
      // A payload this device already failed to decode will fail again, identically:
      // the bytes are content-addressed, so the memory is keyed by hash (two clips
      // can share one). A length mismatch is not like that — the canonical loop can
      // still change — so a mismatch only ever skips this pass.
      if (this.undecodable.has(clip.blobHash)) continue;

      // Compatibility asks about *this* device's loop, so it only means anything
      // once a context exists.
      if (audioReady && !this.isCompatible(engine, clip)) {
        this.statusMessage = 'A clip has a different loop length — retrying.';
        continue;
      }

      // Bytes are fetched even without a context: a device that joins but never
      // records must be able to hold the audio, or it can never hear the loop.
      const stored = await this.blobs.get(clip.blobHash);
      if (!stored) {
        this.requestBlob(clip.blobHash);
        continue;
      }
      if (!audioReady) continue; // hold the bytes; the audio half runs once a context exists

      try {
        const samples = await decodeClip(stored.bytes, engine.audioContext());
        if (samples.length === 0) {
          this.undecodable.add(clip.blobHash);
          continue;
        }
        engine.addRemoteLayer({ id: clip.id, authorId: clip.authorId, samples });
      } catch {
        this.undecodable.add(clip.blobHash);
        this.statusMessage = 'A clip could not be decoded on this device and was skipped.';
      }
    }
  }

  /**
   * A clip only joins the live loop if its duration matches the shared loop.
   *
   * The reference is the header's set-once `sampleRate`/`cycleFrames`, not this device's
   * own engine: a joiner that has not adopted the canonical length yet must still accept
   * the session's clips, and a device that recorded a first take of its own must not
   * reject every clip recorded at the session's length for the rest of the session. The
   * local loop is only a fallback for the moment before a canonical length exists.
   *
   * After `decodeClip()` a clip is already at this context's sample rate, so only the
   * *duration* can differ between peers — never the rate.
   */
  private isCompatible(engine: LoopEngine, clip: ClipRecord): boolean {
    if (clip.sampleRate <= 0 || clip.cycleFrames <= 0) return false;
    const header = this.store ? this.store.getHeader() : null;
    const headerRate = header ? header.sampleRate : null;
    const headerFrames = header ? header.cycleFrames : null;
    const canonicalSeconds =
      headerRate !== null && headerRate > 0 && headerFrames !== null && headerFrames > 0
        ? headerFrames / headerRate
        : null;
    const clipSeconds = clip.cycleFrames / clip.sampleRate;

    if (canonicalSeconds === null) {
      // Nothing canonical yet, so this clip is a candidate to define the loop.
      if (engine.getLoopLengthFrames() <= 0) return true;
      const rate = engine.getSampleRate();
      if (rate === null) return false;
      const localSeconds = engine.getLoopLengthFrames() / rate;
      return Math.abs(clipSeconds - localSeconds) <= Math.max(0.002, localSeconds * 0.01);
    }

    return Math.abs(clipSeconds - canonicalSeconds) <= Math.max(0.002, canonicalSeconds * 0.01);
  }

  /**
   * Asks the room for a hash, at most once every `BLOB_REQUEST_INTERVAL_MS`.
   *
   * This used to be one-shot with a 20 s give-up timer, which made a single lost
   * transfer permanent for the whole session. Asking again is nearly free (the
   * answer is a few dozen bytes or the audio itself), so we simply keep asking.
   */
  private requestBlob(hash: string): void {
    const transport = this.transport;
    if (!transport) return;
    const askedAt = this.pending.get(hash);
    const now = Date.now();
    if (askedAt !== undefined && now - askedAt < BLOB_REQUEST_INTERVAL_MS) return;
    this.pending.set(hash, now);
    void transport.sendBlobWant(hash);
  }

  /**
   * Anti-entropy pulse: push our state vector at every peer and re-ask for any
   * referenced audio we still do not hold.
   *
   * The peer's own pulse covers the other direction, so both sides converge even
   * when a handshake or a transfer was lost. It emits nothing: the pulse changes
   * no state by itself, and `emit()` already de-duplicates identical snapshots.
   */
  private pulse(): void {
    const store = this.store;
    const transport = this.transport;
    if (!store || !transport) return;
    const peers = transport.peerIds;
    if (peers.length === 0) return; // nobody to converge with
    let vector: Uint8Array;
    try {
      vector = store.encodeStateVector();
    } catch (error) {
      // A state vector that cannot be built means no handshake can ever be sent, so this is
      // worth surfacing rather than letting the pulse fail silently every two seconds.
      this.diag.encodeErrors++;
      this.diag.lastError = `encode state vector: ${errorText(error)}`;
      console.warn(`[collab] ${this.diag.lastError}`);
      return;
    }
    for (const peerId of peers) void transport.sendStateVector(peerId, vector);
    void this.auditMissingBlobs();
  }

  /**
   * Re-asks for the bytes behind every live clip we do not have.
   *
   * This is the other half of removing the give-up timer: the pump only retries
   * when the document changes or a gesture arrives, so a transfer that failed
   * quietly would otherwise sit unfetched until something else happened.
   */
  private async auditMissingBlobs(): Promise<void> {
    const store = this.store;
    if (!store || !this.transport) return;
    for (const clip of store.getClips()) {
      if (clip.deleted) continue;
      if (await this.blobs.has(clip.blobHash)) continue;
      this.requestBlob(clip.blobHash);
    }
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
        try {
          this.store?.applyUpdate(update, `peer:${fromPeer}`);
          this.diag.applied++;
        } catch (error) {
          // A throw in here used to escape into Trystero's dispatcher and leave no trace
          // anywhere the user could see, which is exactly how "nothing syncs" stayed
          // unexplained. Record it and keep the session alive.
          this.diag.applyErrors++;
          this.diag.lastError = `apply update: ${errorText(error)}`;
          console.warn(`[collab] ${this.diag.lastError}`);
          this.emit();
        }
      },
      onStateVector: (peerId, vector) => {
        const store = this.store;
        const transport = this.transport;
        if (!store || !transport) return;
        try {
          // `encodeDiff()` decodes the peer's state vector, so a truncated or corrupted
          // vector throws right here — the one place a broken handshake would otherwise
          // look like "the peer simply never sends anything".
          void transport.sendUpdate(store.encodeDiff(vector), peerId);
        } catch (error) {
          this.diag.encodeErrors++;
          this.diag.lastError = `encode diff: ${errorText(error)}`;
          console.warn(`[collab] ${this.diag.lastError}`);
          this.emit();
        }
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
      // The bytes are here, so this hash is no longer outstanding.
      this.pending.delete(hash);
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
    // This sweep is the only clock that runs while a session is otherwise idle, so it is
    // also what retires a recording lease nobody released: once the claim is older than its
    // TTL it reads as no claim, and re-publishing is what makes that visible. `emit()`
    // de-duplicates, so re-running it while somebody is legitimately recording changes
    // nothing.
    if (changed || this.snapshot.get().remoteRecording !== null) this.emit();
  }

  /** One console line per change in the document's clip count — the "did it cross?" signal. */
  private logClipCount(): void {
    const count = this.store ? this.store.getClips().length : 0;
    if (count === this.lastLoggedClipCount) return;
    this.lastLoggedClipCount = count;
    console.info(`[collab] document now holds ${count} clip(s)`);
  }

  private emit(): void {
    const engine = this.engine;
    const peers = [...this.presencePeers.values()].sort((a, b) => a.name.localeCompare(b.name));
    // Clips still expected to join the loop. One this device has proven it cannot decode
    // never will, so counting it would leave the sheet saying "fetching audio…" forever;
    // a clip skipped for a length mismatch still counts, because a later pass re-evaluates
    // it once the canonical length has been adopted.
    const pendingClips = engine
      ? (this.store
          ?.getClips()
          .filter(
            (clip) => !clip.deleted && !this.undecodable.has(clip.blobHash) && !engine.hasLayer(clip.id),
          ).length ?? 0)
      : 0;
    const next: CollabSnapshot = {
      active: this.store !== null,
      roomId: this.roomId,
      connection: this.store ? this.connection : 'idle',
      peers,
      status: this.statusMessage,
      pendingClips,
      remoteRecording: this.remoteRecording(),
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
