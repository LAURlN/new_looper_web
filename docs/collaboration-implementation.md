# Live P2P collaboration — implementation notes

Status: **implemented** (pure-P2P live-session track, option A of the research doc).
This documents what was actually built, how to use it, and what was deliberately left out.

The design rationale lives in [`multiplayer-architecture.md`](multiplayer-architecture.md:1);
this file is the "what exists in the code" companion. The scenarios this layer must keep
true — carried over from the previous native implementation's regression suite — are in
[`collaboration-acceptance-checklist.md`](collaboration-acceptance-checklist.md:1), which
also holds the **two-device manual test script** and the **future-work** note.

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
- **The loop length is set once and then obeyed.** The first take writes
  `sampleRate`/`cycleFrames` into the project header; every other device reads that value
  back and adopts it, so all peers cycle the same duration even on different hardware (§4).
- **Peers repair each other continuously.** A 2 s anti-entropy pulse re-sends state vectors
  and re-asks for missing audio, so a lost handshake or a lost transfer is not permanent
  (§3).
- **"Someone is recording" is a lease, not a lock.** It is purely informational: it never
  blocks, queues or disables a local take (§5).

### Module map

| File | Role |
|---|---|
| [`src/collab/types.ts`](src/collab/types.ts:1) | Clip metadata, presence, snapshot, and the record-lease types. |
| [`src/collab/identity.ts`](src/collab/identity.ts:1) | Anonymous stable id + display name/colour in `localStorage`. |
| [`src/collab/room.ts`](src/collab/room.ts:1) | Room code generation/parsing and the invite URL. |
| [`src/collab/codec.ts`](src/collab/codec.ts:1) | WAV16 encode, decode, SHA-256 content addressing. |
| [`src/collab/blobStore.ts`](src/collab/blobStore.ts:1) | Content-addressed local blob store (IndexedDB, memory fallback). |
| [`src/collab/projectStore.ts`](src/collab/projectStore.ts:1) | Yjs document schema (header, clips, `recordLock`) + `y-indexeddb` persistence + observables. |
| [`src/collab/transport.ts`](src/collab/transport.ts:1) | Trystero room, document sync, presence, blob transfer. |
| [`src/collab/controller.ts`](src/collab/controller.ts:1) | Wires document ⇄ blobs ⇄ transport ⇄ engine; owns the session snapshot. |
| [`src/ui/session.ts`](src/ui/session.ts:1) | The "Session" tab (start/leave/share, peers, who is recording, status). |

Changed files: [`src/audio/engine.ts`](src/audio/engine.ts:1) (string layer ids, authorship,
commit/remove hooks, take-start/end hooks, `addRemoteLayer`, `adoptSharedLoop`, share-safe
undo), [`src/ui/disc.ts`](src/ui/disc.ts:1) (presence pill), [`src/ui/settings.ts`](src/ui/settings.ts:1)
(extra tabs, `openTab`), [`src/main.ts`](src/main.ts:1) (wiring, invite auto-join, context
before session start), [`src/styles.css`](src/styles.css:1).

## 2. The wire protocol

Six Trystero actions, all namespaced to `appId: 'loop-recorder-v1'`:

| Action | Payload | Purpose |
|---|---|---|
| `y-upd` | `ArrayBuffer` (Yjs update) | Incremental document change. **Flooded** onward, except back to the sender. |
| `y-sv` | `ArrayBuffer` (state vector) | Sent on peer join; the receiver replies with only the difference. The 2 s pulse also sends it to every peer. |
| `presence` | JSON `{identityId, name, color}` | Who is here. Re-sent every 5 s as a heartbeat. |
| `blob-have` | JSON `{hash, bytes, …}` | "I can serve these bytes." |
| `blob-want` | JSON `{hash}` | "Send me these bytes." |
| `blob-data` | `ArrayBuffer` + `metadata.hash` | The encoded clip. Trystero chunks large payloads. |

**Why flooding terminates:** Yjs updates are idempotent. Applying an already-applied
update changes nothing and emits no `update` event, so no further re-broadcast happens.
That also means a partially connected mesh still converges, and a peer re-broadcasts on
behalf of others (no coordinator, no host).

**Integrity:** a received blob is hashed before being stored; a mismatch is discarded
([`handleBlobData()`](src/collab/controller.ts:754)). Content addressing also deduplicates
identical audio for free.

**The join handshake is a first attempt, not the only one.** [`onPeerJoin`](src/collab/controller.ts:681)
runs once per peer: state vector out, and "here are the blobs I can serve" in. Everything
that handshake can lose is repeated by the pulse in §3, so a peer that was not listening
at that exact moment still converges.

## 3. Convergence: how peers repair each other

### 3.1 The 2 s pulse

Every [`PULSE_INTERVAL_MS = 2000`](src/collab/controller.ts:76) ms, [`pulse()`](src/collab/controller.ts:649)
sends this device's state vector to **every** peer and then runs a blob audit. A peer
answers a state vector with the difference between its document and that vector
([`onStateVector`](src/collab/controller.ts:701)). Both ends pulse, so both directions
heal even when the initial handshake was lost. The pulse emits nothing itself: it changes
no state, and the snapshot publisher already de-duplicates identical snapshots.

### 3.2 Audio is fetched even without an AudioContext

[`pumpOnce()`](src/collab/controller.ts:523) is split in two halves. The store/network half
always runs; only the decode/apply half needs an AudioContext
([`engine.hasAudioContext()`](src/audio/engine.ts:458)). Concretely: bytes are fetched and
stored for every live clip, but a clip is only decoded and handed to the engine once a
context exists.

That split is the whole point. An AudioContext is created lazily, so a device that joins a
session and never taps the disc must still be able to receive and hold the shared audio —
otherwise it could never hear the loop at all. [`ensureAudioContext()`](src/audio/engine.ts:181)
creates and resumes the context **without** opening the microphone; the microphone is only
opened by [`ensureReady()`](src/audio/engine.ts:220) (tapping the disc, calibrating, or the
test tone). [`startSession()`](src/main.ts:77) calls `ensureAudioContext()` before joining,
so a joining device has a clock to play on and is never asked for microphone permission
just by joining.

### 3.3 What is retried, and what is permanent

Two different failures, two different policies:

- **Missing bytes** are retried **forever**. [`requestBlob()`](src/collab/controller.ts:631)
  throttles asks to one per [`BLOB_REQUEST_INTERVAL_MS = 5000`](src/collab/controller.ts:68)
  ms per hash, and the audit in [`auditMissingBlobs()`](src/collab/controller.ts:667)
  re-asks for the bytes behind every live clip this device does not hold. There is
  deliberately **no give-up timer**: a single lost transfer must not be permanent for the
  session.
- **Undecodable bytes** are remembered **permanently, keyed by content hash**
  ([`undecodable`](src/collab/controller.ts:85)). The bytes are content-addressed, so a
  payload that failed to decode will fail identically forever; two clips can even share one
  hash. This set is keyed by `blobHash`, never by clip id or position.
- **A loop-length mismatch is neither.** [`isCompatible()`](src/collab/controller.ts:601)
  simply skips the clip for *this* pass and says so ("A clip has a different loop length —
  retrying."); the next pump re-evaluates it, because the canonical length can still change.
  Nothing is blacklisted for a mismatch.

A clip that is still expected to join counts in `pendingClips` and shows as
"Fetching N clips from peers…" in the Session tab; a clip proven undecodable drops out of
that count ([`emit()`](src/collab/controller.ts:821)).

## 4. The canonical loop

The loop length is **set-once** state, and it is now both written *and read*.

### 4.1 Writing it

[`ensureCanonical()`](src/collab/projectStore.ts:224) writes `sampleRate`/`cycleFrames`
into the project header the first time a take is published
([`claimLoop()`](src/collab/controller.ts:418)). If the header already holds a different
length, it returns `'conflict'` and the controller says so, in one shared wording
([`conflictMessage()`](src/collab/controller.ts:436)).

### 4.2 Reading it back

[`adoptCanonicalLoop()`](src/collab/controller.ts:456) is the read side. It runs when the
header changes and on every pump pass, converts the header length into *this* context's
frames, and calls [`LoopEngine.adoptSharedLoop()`](src/audio/engine.ts:495). A device that
joined with no loop of its own therefore adopts the session's length and starts cycling it;
a clip that arrives before any context exists is adopted by the next pump after the context
appears.

`adoptSharedLoop()` is deliberately conservative: it does nothing if the length is already
exactly right, and it **refuses to clobber** a loop this device defined itself. A device
that recorded its own first take keeps it and is told why (§4.4). It returns `true` only on
a real adoption, which is when the "Joined the shared loop: N s" line is set — so a header
that merely re-emits does not create noise.

Once a device is cycling a shared loop, its next take is an **overdub**: tapping the disc
goes down [`beginOverdubPass()`](src/audio/engine.ts:655) rather than a fresh first take
([`tap()`](src/audio/engine.ts:268)), so the take folds into the canonical cycle instead of
redefining it. Compatibility and the canonical length are also why
[`isCompatible()`](src/collab/controller.ts:601) compares an incoming clip against the
**header's** duration, not against this device's own loop.

### 4.3 Rate conversion

The header stores the **writing device's** hardware rate. A loop on any device is always
expressed in *that* device's frames, so the length is converted by the ratio of the two
rates: `localFrames = round(headerFrames * localRate / headerRate)`. A 3.4 s cycle is
`3.4 * localRate` frames here, whatever either context runs at. `decodeClip()` already puts
arriving audio at the local rate (it uses `AudioContext.decodeAudioData`, which resamples
on ingest), so the rates themselves never have to be reconciled anywhere else.

### 4.4 The conflict case

Two devices that each recorded a first take at different lengths is a genuine conflict, and
there is no authority to resolve it. The behaviour is:

- the header's value wins as the canonical length;
- the device whose loop differs is **never clobbered** — its audible work is left alone,
  and it is told, with both lengths, to *undo its layers to join*;
- once its layers are gone, the locally defined loop is released
  ([`releaseLoopIfUnowned()`](src/audio/engine.ts:819)), so a later adoption succeeds.

Clips skipped while the lengths disagree stay re-evaluatable: they are not added to the
permanent-undecodable set.

## 5. The recording lease

A top-level `Y.Map` named **`recordLock`** holds `{identityId, name, color, at}`
([`RECORD_LOCK_MAP`](src/collab/projectStore.ts:53)). It answers "who is recording right
now" for everyone else; it never blocks, queues or disables recording.

- **TTL, evaluated on read.** A claim older than
  [`RECORD_LOCK_TTL_MS = 60000`](src/collab/projectStore.ts:62) reads as no claim at all
  ([`getRecordLock()`](src/collab/projectStore.ts:282)). A phone that dies, backgrounds or
  loses its connection mid-take therefore stops being reported after a minute **with no
  cleanup message and no traffic from anyone**.
- **Refreshed while recording.** A device that is still recording pushes `at` forward every
  [`RECORD_LOCK_REFRESH_MS = 15000`](src/collab/controller.ts:40) ms
  ([`refreshRecordLock()`](src/collab/projectStore.ts:312)), so a long take stays visible
  while a vanished one expires. Only the holder may refresh.
- **Claimed/released from real take edges.** The engine fires
  [`onTakeStarted`](src/audio/engine.ts:446)/[`onTakeEnded`](src/audio/engine.ts:454) on
  genuine transitions only, including a take that was discarded, aborted or dropped by
  backgrounding. `stop()` releases the claim while the transport is still up, so leaving a
  session clears the indicator immediately.
- **Claim, refresh and release are all identity-guarded**, so a late or duplicated release
  can never clear a claim that has since moved to someone else.
- **Concurrent claims.** Both devices write the same four keys, so Yjs's deterministic
  per-key conflict rule makes every key resolve to the same winner — both sides agree on
  one holder with no extra tie-break.
- **Carried to the UI.** [`CollabSnapshot.remoteRecording`](src/collab/types.ts:124)
  ([`remoteRecording()`](src/collab/controller.ts:228)) is shown in the Session tab as a
  "Recording now" field ([session.ts](src/ui/session.ts:64)) and as a dot on the top-bar
  pill ([disc.ts](src/ui/disc.ts:189)). A remote claim also produces the non-fatal line
  "<name> is recording too — your take will be added alongside."

## 6. How to use it

1. Open the app, tap the gear, choose **Session**.
2. **Start a session** — generates a room code, puts it in the URL fragment, and joins.
3. **Copy invite link** and send it. Anyone who opens it auto-joins that room.
4. Record as usual. Each take is shared; other devices fetch and play it.
5. **Undo** removes the last clip *that device* recorded (never someone else's work).

The top-bar pill shows the peer count and is grey while searching, green when connected;
it gains a recording dot when another peer is recording. Step-by-step expected
observations are in the manual test script in
[`collaboration-acceptance-checklist.md`](collaboration-acceptance-checklist.md:1).

## 7. Deliberate limitations

- **Live-only.** With no server there is no durable storage: the project is shared only
  while at least one peer keeps a copy. Local persistence means *your* device remembers
  it, and a returning device re-seeds, but it is not cloud storage.
- **Everyone plays on their own clock.** The *clip* is replicated, never the timing. Two
  devices are not sample-locked; each schedules the shared audio at its own loop boundary.
- **WAV16, not Opus.** Guaranteed decoding everywhere, at the cost of size (~375 KiB for
  a 4 s clip). Opus is the obvious next optimisation behind a capability probe.
- **No TURN configured.** Direct connections fail for some mobile↔mobile pairs behind
  CGNAT. The UI surfaces this ("a TURN relay may be required") rather than failing
  silently; this build passes no relay config to `joinRoom()`, so a TURN relay would have
  to be added when one becomes available.
- **Mesh scale.** Full mesh is O(n²); comfortable to roughly 6 people.
- **Presence is app-level.** A 15 s TTL plus a 5 s heartbeat, rather than Yjs Awareness.
- **"Unlisted", not "private".** Anyone with the room code can listen. Trystero encrypts
  the SDP handshake from the app/room id, but clip content is not end-to-end encrypted
  against a determined participant.
- **No leader/host.** There is intentionally no coordinator, so there is no single point
  of failure — and, correspondingly, no authority to resolve a genuine double-first-take
  conflict beyond the §4.4 behaviour: keep the local loop, tell the user, let undo join.
- **A loop-length mismatch is not an error, just a delay.** A clip published at a length
  this device has not adopted yet is retried on every pass rather than rejected.

## 8. Verification

- `npm run typecheck` and `npm run build` pass; the production bundle is ≈ 205.8 kB
  (65.1 kB gzip).
- The manual two-device script against the live site —
  <https://laurln.github.io/new_looper_web/> — is in
  [`collaboration-acceptance-checklist.md`](collaboration-acceptance-checklist.md:1). It
  lists the expected observations (pill live with count 2, both devices reporting the same
  loop length, a take appearing on the other device without a reload, the Session tab
  showing who is recording) and what each `status` string means.
- Solo behaviour is unchanged when no session is joined — the controller does nothing
  until `start()` is called, and the record lease writes nothing and starts no timer
  without a room.

## 9. Future work

There is no test runner in this project, so the checklist in
[`collaboration-acceptance-checklist.md`](collaboration-acceptance-checklist.md:1) is the
interim verification. See the "Future work" section there for what would be needed to
automate it.
