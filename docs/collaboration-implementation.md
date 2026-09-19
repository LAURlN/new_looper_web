# Live P2P collaboration — implementation notes

Status: **implemented** (pure-P2P live-session track, option A of the research doc).
This documents what was actually built, how to use it, and what was deliberately left out.

The design rationale lives in [`multiplayer-architecture.md`](multiplayer-architecture.md:1);
this file is the "what exists in the code" companion.

---

## 1. What was built

Multiple people can open the same room and collaborate on one loop. A take recorded on
one device is replicated to the others, who play it on **their own** audio clock.

- **No server, no account, no infrastructure.** Signalling runs over Trystero's default
  **Nostr** strategy (public relays); audio flows over WebRTC data channels.
- **Clip metadata** (the list of what exists) lives in a **Yjs** document, persisted
  locally with **`y-indexeddb`**.
- **Audio bytes never enter the CRDT.** Each clip is encoded, SHA-256 content-addressed,
  stored locally, and transferred separately.
- **Playback is never synchronised.** A clip is already exactly one loop cycle, so a
  receiving peer just adds it and the existing scheduler plays it at the next boundary.

### Module map

| File | Role |
|---|---|
| [`src/collab/types.ts`](src/collab/types.ts:1) | Clip metadata, presence, snapshot types. |
| [`src/collab/identity.ts`](src/collab/identity.ts:1) | Anonymous stable id + display name/colour in `localStorage`. |
| [`src/collab/room.ts`](src/collab/room.ts:1) | Room code generation/parsing and the invite URL. |
| [`src/collab/codec.ts`](src/collab/codec.ts:1) | WAV16 encode, decode, SHA-256 content addressing. |
| [`src/collab/blobStore.ts`](src/collab/blobStore.ts:1) | Content-addressed local blob store (IndexedDB, memory fallback). |
| [`src/collab/projectStore.ts`](src/collab/projectStore.ts:1) | Yjs document schema + `y-indexeddb` persistence + observables. |
| [`src/collab/transport.ts`](src/collab/transport.ts:1) | Trystero room, document sync, presence, blob transfer. |
| [`src/collab/controller.ts`](src/collab/controller.ts:1) | Wires document ⇄ blobs ⇄ transport ⇄ engine; owns the session snapshot. |
| [`src/ui/session.ts`](src/ui/session.ts:1) | The "Session" tab (start/leave/share, peers, status). |

Changed files: [`src/audio/engine.ts`](src/audio/engine.ts:1) (string layer ids, authorship,
commit/remove hooks, `addRemoteLayer`, share-safe undo), [`src/ui/disc.ts`](src/ui/disc.ts:1)
(presence pill), [`src/ui/settings.ts`](src/ui/settings.ts:1) (extra tabs, `openTab`),
[`src/main.ts`](src/main.ts:1) (wiring, invite auto-join), [`src/styles.css`](src/styles.css:1).

## 2. The wire protocol

Six Trystero actions, all namespaced to `appId: 'loop-recorder-v1'`:

| Action | Payload | Purpose |
|---|---|---|
| `y-upd` | `ArrayBuffer` (Yjs update) | Incremental document change. **Flooded** onward, except back to the sender. |
| `y-sv` | `ArrayBuffer` (state vector) | Sent on peer join; the receiver replies with only the difference. |
| `presence` | JSON `{identityId, name, color}` | Who is here. Re-sent every 5 s as a heartbeat. |
| `blob-have` | JSON `{hash, bytes, …}` | "I can serve these bytes." |
| `blob-want` | JSON `{hash}` | "Send me these bytes." |
| `blob-data` | `ArrayBuffer` + `metadata.hash` | The encoded clip. Trystero chunks large payloads. |

**Why flooding terminates:** Yjs updates are idempotent. Applying an already-applied
update changes nothing and emits no `update` event, so no further re-broadcast happens.
That also means a partially connected mesh still converges, and a peer re-broadcasts on
behalf of others (no coordinator, no host).

**Integrity:** a received blob is hashed before being stored; a mismatch is discarded.
Content addressing also deduplicates identical audio for free.

## 3. How to use it

1. Open the app, tap the gear, choose **Session**.
2. **Start a session** — generates a room code, puts it in the URL fragment, and joins.
3. **Copy invite link** and send it. Anyone who opens it auto-joins that room.
4. Record as usual. Each take is shared; other devices fetch and play it.
5. **Undo** removes the last clip *that device* recorded (never someone else's work).

The top-bar pill shows the peer count and is grey while searching, green when connected.

## 4. Deliberate limitations (all documented in the research doc)

- **Live-only.** With no server there is no durable storage: the project is shared only
  while at least one peer keeps a copy. Local persistence means *your* device remembers
  it, and a returning device re-seeds, but it is not cloud storage.
- **WAV16, not Opus.** Guaranteed decoding everywhere, at the cost of size (~375 KiB for
  a 4 s clip). Opus is the obvious next optimisation behind a capability probe.
- **No TURN configured.** Direct connections fail for some mobile↔mobile pairs behind
  CGNAT. The UI surfaces this ("a TURN relay may be required") rather than failing
  silently; Trystero accepts a `turnConfig` when one is available.
- **Mesh scale.** Full mesh is O(n²); comfortable to roughly 6 people.
- **Presence is app-level.** A 15 s TTL plus a 5 s heartbeat, rather than Yjs Awareness.
- **"Unlisted", not "private".** Anyone with the room code can listen. Trystero encrypts
  the SDP handshake from the app/room id, but clip content is not end-to-end encrypted
  against a determined participant.
- **No leader/host.** There is intentionally no coordinator, so there is no single point
  of failure (and correspondingly no authority to resolve a genuine double-first-take
  conflict beyond "skip the incompatible clip and say so").

## 5. Verification

- `npm run typecheck` and `npm run build` pass; production bundle ≈ 199 kB (63 kB gzip).
- Manual check with two browser windows on `localhost:5173`: start a session in one,
  open the copied link in the other, confirm the peer pill shows 2, record on one and
  confirm it appears (and is audible) on the other.
- Solo behaviour is unchanged when no session is joined — the controller does nothing
  until `start()` is called.
