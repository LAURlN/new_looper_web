/**
 * Peer-to-peer transport, built on Trystero.
 *
 * Trystero gives us serverless WebRTC signalling (by default over the public
 * Nostr relay network — no account, no infrastructure) plus data channels with
 * automatic serialization, chunking and throttling. Everything below rides on
 * four kinds of message:
 *
 * - **document sync** — Yjs incremental updates, plus a state-vector handshake
 *   so a peer that joins late only receives the difference it is missing.
 * - **presence** — who is here (name/colour), heartbeat-refreshed.
 * - **blob availability** — "I have audio for hash X" / "I need X".
 * - **blob bytes** — the encoded clip itself, sent as raw binary.
 *
 * Updates are *flooded*: a peer re-broadcasts an update it received (except back
 * to where it came from). Yjs updates are idempotent, so a duplicate application
 * is a no-op that emits no update event and therefore causes no further
 * re-broadcast — the flood terminates on its own. This is what lets a partially
 * connected mesh still converge.
 */
import { joinRoom } from 'trystero';
import type { MessageAction, Room } from 'trystero';
import type { ConnectionState } from './types';

export type JsonRecord = Record<string, string | number | boolean>;

/** Namespaces every peer of this app into the same signalling space. */
export const TRYSTERO_APP_ID = 'loop-recorder-v1';

const HEARTBEAT_MS = 5000;

export interface TransportHandlers {
  /** A peer appeared/disappeared; transport already updated its peer set. */
  onPeerJoin(peerId: string): void;
  onPeerLeave(peerId: string): void;
  onPeersChanged(peers: string[]): void;
  /** A Yjs update arrived. `fromPeer` lets us avoid echoing it back. */
  onUpdate(update: Uint8Array, fromPeer: string): void;
  /** A peer asked for the difference between our doc and this vector. */
  onStateVector(peerId: string, vector: Uint8Array): void;
  onPresence(peerId: string, payload: JsonRecord): void;
  onBlobHave(peerId: string, payload: JsonRecord): void;
  onBlobWant(peerId: string, payload: JsonRecord): void;
  onBlobData(peerId: string, bytes: ArrayBuffer, metadata: JsonRecord | null): void;
  onStatus(connection: ConnectionState, message: string | null): void;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // copy() gives the view its own exactly-sized buffer; `.buffer` is then safe to send.
  return bytes.slice().buffer;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class P2PTransport {
  private room: Room | null = null;
  private heartbeat: number | null = null;
  private peers: string[] = [];
  private errorMessage: string | null = null;

  private updateAction: MessageAction<ArrayBuffer> | null = null;
  private stateVectorAction: MessageAction<ArrayBuffer> | null = null;
  private presenceAction: MessageAction<JsonRecord> | null = null;
  private blobHaveAction: MessageAction<JsonRecord> | null = null;
  private blobWantAction: MessageAction<JsonRecord> | null = null;
  private blobDataAction: MessageAction<ArrayBuffer> | null = null;

  private readonly identityPayload: JsonRecord;

  constructor(
    private readonly roomId: string,
    identity: { id: string; name: string; color: string },
    private readonly handlers: TransportHandlers,
  ) {
    this.identityPayload = { identityId: identity.id, name: identity.name, color: identity.color };
  }

  get peerIds(): string[] {
    return this.peers;
  }

  get active(): boolean {
    return this.room !== null;
  }

  start(): void {
    if (this.room) return;

    // WebRTC and crypto.subtle both require a secure context. GitHub Pages is
    // https, so this only guards LAN/http testing and odd webviews.
    if (!window.isSecureContext) {
      this.handlers.onStatus(
        'error',
        'Collaboration needs a secure context — open the app over https:// or localhost.',
      );
      return;
    }

    let room: Room;
    try {
      room = joinRoom({ appId: TRYSTERO_APP_ID }, this.roomId, {
        onJoinError: () => {
          // This fires when two peers exchange SDP but still cannot connect:
          // almost always a carrier-network NAT situation that needs TURN.
          this.errorMessage =
            'Could not open a direct connection to a peer. Some mobile networks need a TURN relay — audio will stay local until a path is found.';
          this.emitStatus();
        },
      });
    } catch (error) {
      this.errorMessage =
        error instanceof Error ? error.message : 'Could not join the signalling network';
      this.handlers.onStatus('error', this.errorMessage);
      return;
    }

    this.room = room;

    this.updateAction = room.makeAction<ArrayBuffer>('y-upd');
    this.updateAction.onMessage = (data, { peerId }) => {
      this.handlers.onUpdate(new Uint8Array(data), peerId);
    };

    this.stateVectorAction = room.makeAction<ArrayBuffer>('y-sv');
    this.stateVectorAction.onMessage = (data, { peerId }) => {
      this.handlers.onStateVector(peerId, new Uint8Array(data));
    };

    this.presenceAction = room.makeAction<JsonRecord>('presence');
    this.presenceAction.onMessage = (data, { peerId }) => {
      if (isJsonRecord(data)) this.handlers.onPresence(peerId, data);
    };

    this.blobHaveAction = room.makeAction<JsonRecord>('blob-have');
    this.blobHaveAction.onMessage = (data, { peerId }) => {
      if (isJsonRecord(data)) this.handlers.onBlobHave(peerId, data);
    };

    this.blobWantAction = room.makeAction<JsonRecord>('blob-want');
    this.blobWantAction.onMessage = (data, { peerId }) => {
      if (isJsonRecord(data)) this.handlers.onBlobWant(peerId, data);
    };

    this.blobDataAction = room.makeAction<ArrayBuffer>('blob-data');
    this.blobDataAction.onMessage = (data, { peerId, metadata }) => {
      this.handlers.onBlobData(peerId, data, isJsonRecord(metadata) ? metadata : null);
    };

    room.onPeerJoin = (peerId) => {
      this.peers = [...this.peers, peerId];
      this.handlers.onPeersChanged(this.peers);
      this.handlers.onPeerJoin(peerId);
      // Introduce ourselves straight away; the document handshake is the
      // controller's job (it owns the Yjs doc, not the transport).
      void this.presenceAction?.send(this.identityPayload, { target: peerId });
      this.emitStatus();
    };

    room.onPeerLeave = (peerId) => {
      this.peers = this.peers.filter((id) => id !== peerId);
      this.handlers.onPeersChanged(this.peers);
      this.handlers.onPeerLeave(peerId);
      this.emitStatus();
    };

    // Backup for a missed disconnect: a steady broadcast keeps `lastSeen` fresh
    // so the controller can prune a peer that vanished without a clean leave.
    this.heartbeat = window.setInterval(() => {
      void this.presenceAction?.send(this.identityPayload);
    }, HEARTBEAT_MS);

    this.emitStatus();
  }

  stop(): void {
    if (this.heartbeat !== null) {
      window.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    const room = this.room;
    this.room = null;
    this.peers = [];
    if (room) {
      room.onPeerJoin = null;
      room.onPeerLeave = null;
      void room.leave();
    }
    this.updateAction = null;
    this.stateVectorAction = null;
    this.presenceAction = null;
    this.blobHaveAction = null;
    this.blobWantAction = null;
    this.blobDataAction = null;
    this.handlers.onPeersChanged([]);
    this.handlers.onStatus('idle', null);
  }

  // --------------------------------------------------------------- document

  async sendUpdate(update: Uint8Array, exceptPeer?: string): Promise<void> {
    const action = this.updateAction;
    if (!action) return;
    const targets = exceptPeer ? this.peers.filter((id) => id !== exceptPeer) : null;
    try {
      await action.send(toArrayBuffer(update), targets ? { target: targets } : undefined);
    } catch {
      /* the peer went away mid-send — nothing to recover */
    }
  }

  async sendStateVector(target: string, vector: Uint8Array): Promise<void> {
    const action = this.stateVectorAction;
    if (!action) return;
    try {
      await action.send(toArrayBuffer(vector), { target });
    } catch {
      /* ignore */
    }
  }

  // --------------------------------------------------------------- presence

  async announcePresence(): Promise<void> {
    try {
      await this.presenceAction?.send(this.identityPayload);
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ blobs

  async sendBlobHave(metadata: JsonRecord, target?: string): Promise<void> {
    try {
      await this.blobHaveAction?.send(metadata, target ? { target } : undefined);
    } catch {
      /* ignore */
    }
  }

  async sendBlobWant(hash: string, target?: string): Promise<void> {
    try {
      await this.blobWantAction?.send({ hash }, target ? { target } : undefined);
    } catch {
      /* ignore */
    }
  }

  async sendBlobData(bytes: ArrayBuffer, metadata: JsonRecord, target: string): Promise<void> {
    try {
      // Trystero chunks and throttles large binary payloads for us.
      await this.blobDataAction?.send(bytes, { target, metadata });
    } catch {
      /* peer vanished; the requester will simply ask someone else */
    }
  }

  // ----------------------------------------------------------------- status

  private emitStatus(): void {
    if (this.peers.length > 0) {
      this.handlers.onStatus('live', this.errorMessage);
      return;
    }
    this.handlers.onStatus(this.errorMessage ? 'error' : 'searching', this.errorMessage);
  }
}
