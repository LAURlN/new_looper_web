/**
 * Shared types for the live, peer-to-peer collaboration layer.
 *
 * Everything here is plain data that either round-trips through the Yjs
 * document (metadata) or through a WebRTC data channel (audio bytes). Note the
 * central invariant: **no audio ever lives inside the shared document**. A clip
 * only stores a content hash and a byte count; the bytes travel separately and
 * are fetched on demand. See `docs/multiplayer-architecture.md` for the why.
 */
import type { MonoBuffer } from '../audio/dsp';

/** Bump when the shared document shape changes in a non-additive way. */
export const SCHEMA_VERSION = 1;

/** Audio codecs a clip's bytes may use. WAV16 is the guaranteed-everywhere path. */
export type ClipCodec = 'wav16';

/**
 * Clip metadata replicated through the Yjs document.
 *
 * A clip is always *one finished loop cycle* — the recording device already
 * folded it and applied its own latency compensation — so a receiving peer
 * needs no offset, no phase and no frame bookkeeping to play it. That is why
 * playback never has to be synchronised between peers.
 */
export interface ClipMeta {
  id: string;
  authorId: string;
  authorName: string;
  /** `Date.now()` on the authoring device. Used for deterministic display order only. */
  createdAt: number;
  /** The AudioContext sample rate the author recorded at. */
  sampleRate: number;
  /** Length of the folded buffer in frames at `sampleRate` (== one loop cycle). */
  cycleFrames: number;
  codec: ClipCodec;
  /** SHA-256 (hex) of the encoded bytes — the blob's content address. */
  blobHash: string;
  /** Byte length of the encoded blob. */
  blobBytes: number;
  /** Layer slot at authoring time (informational; playback does not depend on it). */
  slot: number;
}

/** A clip as it appears in the shared document, including its delete tombstone. */
export interface ClipRecord extends ClipMeta {
  deleted: boolean;
}

/** What the engine hands to the collaboration layer when a take is committed. */
export interface CommittedClip {
  id: string;
  authorId: string;
  /** Folded, exactly one loop cycle long, at the recording AudioContext's rate. */
  samples: MonoBuffer;
  sampleRate: number;
  cycleFrames: number;
  slot: number;
  isFirst: boolean;
}

/** The shared project header. `sampleRate`/`cycleFrames` are set-once. */
export interface ProjectHeader {
  id: string;
  name: string;
  schemaVersion: number;
  sampleRate: number | null;
  cycleFrames: number | null;
  createdAt: number;
}

/** Ephemeral presence info. Never persisted — it only describes who is here now. */
export interface PresencePeer {
  peerId: string;
  identityId: string;
  name: string;
  color: string;
  lastSeen: number;
}

/**
 * The "someone is recording right now" claim, as it is stored in the shared document.
 *
 * A lease, not a lock: `at` is pushed forward while the take runs, and a claim older than
 * the read-side TTL reads as no claim at all. That is what makes a device which dies,
 * backgrounds or drops its connection mid-take harmless after a minute — with no delete
 * message and no cleanup traffic from anyone.
 */
export interface RecordLock {
  /** Identity id of the claimant — the only identity allowed to refresh or release it. */
  identityId: string;
  name: string;
  color: string;
  /** `Date.now()` on the claiming device, refreshed while its take runs. */
  at: number;
}

/**
 * An unexpired claim held by *another* peer, as the UI reads it.
 *
 * Purely informative: a local take is never refused, queued or delayed because of it.
 */
export interface RemoteRecording {
  name: string;
  color: string;
  /** `Date.now()` of the holder's most recent claim or refresh. */
  since: number;
}

/** Coarse connection state for the session UI. */
export type ConnectionState = 'idle' | 'searching' | 'live' | 'error';

/** The snapshot the UI renders. */
export interface CollabSnapshot {
  /** True once we have joined a room. */
  active: boolean;
  roomId: string | null;
  connection: ConnectionState;
  peers: PresencePeer[];
  /** Human-readable status / error line, or null. */
  status: string | null;
  /** How much is still arriving, so the UI can show "fetching audio…". */
  pendingClips: number;
  /** Another peer recording right now, or null. Never set for this device's own claim. */
  remoteRecording: RemoteRecording | null;
}

/** Result of trying to claim the set-once shared loop length. */
export type CanonicalResult = 'set' | 'agreed' | 'conflict';
