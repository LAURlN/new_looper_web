# Live-session acceptance checklist

This is the manual acceptance checklist for the peer-to-peer collaboration layer. It is
the **interim** replacement for the regression suite that the previous native
implementation shipped — there is no test runner in this project yet, so a human follows
the two-device script at the end.

It pairs with [`collaboration-implementation.md`](collaboration-implementation.md:1),
which explains how each guarantee is built. Read that when the "how it is covered" line
here is too terse.

**How to read the marks**

- **`covered by design`** — the code implements the guarantee and it can be traced by
  reading; it has *not* been exercised on real hardware by the author of this document.
- **`covered + verified by hand`** — the code implements it *and* someone has actually run
  a check and seen it pass.
- **`not yet verified`** — the code intends to cover it, but code inspection alone cannot
  establish the claim (it needs real devices, real timing, or an injected failure), so it
  is unproven as of writing.

**Honest summary as of this rewrite: nothing in this document is marked
`covered + verified by hand`.** The three recent changes (the convergence pulse, the
canonical-loop adoption, and the recording lease) landed after the last hand-run of the
basic flow, so every item below is either `covered by design` or `not yet verified`.

---

## Scenarios carried over from the previous implementation

### 1. Out-of-order delivery

- **Situation.** A change for a clip arrives *after* that clip was deleted.
- **Why it matters.** If changes were applied by position, a late edit could resurrect the
  deleted clip or, worse, land on a different clip that now occupies the same slot.
- **How the current implementation covers it.** Clips have stable string ids
  ([`Layer.id`](src/audio/engine.ts:58), [`newLayerId()`](src/audio/engine.ts:45)), never
  positional indices. Deletes are tombstones written onto the clip's own `Y.Map`
  ([`tombstoneClip()`](src/collab/projectStore.ts:263)); the pump reads the live document
  ([`store.getClips()`](src/collab/controller.ts:540)) and removes any layer whose record
  says `deleted`. A late update merges into the same clip object, so it cannot be applied
  elsewhere.
- **Manual check.** Delete a clip on device A while device B is briefly offline; bring B
  back. The clip must stay gone on both, and no other clip may change.
- **Status:** `covered by design`.

### 2. Duplicate delivery

- **Situation.** The same Yjs update is applied twice, or the same blob arrives twice.
- **Why it matters.** A naive handler would append a second layer or re-broadcast forever.
- **How the current implementation covers it.** Yjs updates are idempotent — re-applying
  one changes nothing and emits no `update` event, which also stops the flood
  (§2 of the implementation doc). Blobs are content-addressed and put by hash, so a second
  copy overwrites the same key; `blobs.has()` short-circuits before a re-request
  ([`handleBlobHave()`](src/collab/controller.ts:733)), and the engine's
  [`hasLayer()`](src/audio/engine.ts:510) guard makes a second add a no-op. A duplicate
  `blob-data` is verified by hash and stored again harmlessly.
- **Manual check.** Let a take sync, then force a reconnect (leave and re-join the room on
  one device). The layer count must not double and the audio must not layer onto itself.
- **Status:** `covered by design`.

### 3. Lost message recovery

- **Situation.** A single update is dropped.
- **Why it matters.** Without repair, two peers stay divergent until the *next* edit —
  and if there is no next edit, for the rest of the session.
- **How the current implementation covers it.** The 2 s anti-entropy pulse
  ([`pulse()`](src/collab/controller.ts:649)) sends this device's state vector to every
  peer; each peer responds with the difference. Missing audio is likewise re-asked by the
  blob audit in the same pulse, throttled (not terminated) to one ask per 5 s per hash.
- **Manual check.** Watch two connected devices after a recording: the other side must
  receive it within a couple of seconds even if the first `y-sv`/`blob-have` was missed.
  (True loss injection is hard to do by hand; this is the weak point of a manual check.)
- **Status:** `covered by design` — the repair path exists and is periodic; deliberately
  dropped-message recovery has not been reproduced by hand.

### 4. Concurrent creation is not deletion

- **Situation.** One peer creates a clip while another peer's state is merging.
- **Why it matters.** A sync loop that treats "absent in the incoming state" as "deleted"
  would wipe a peer's fresh recording.
- **How the current implementation covers it.** The clip list is append-only
  ([`appendClip()`](src/collab/projectStore.ts:244) only pushes). Nothing is removed by
  inference: the only way a clip disappears is an explicit `deleted: true` tombstone. The
  pump only removes a layer when its record is explicitly marked deleted.
- **Manual check.** Have both devices record at nearly the same time while connected. Both
  takes must survive.
- **Status:** `covered by design`.

### 5. No peer is dropped for being behind

- **Situation.** Two peers record; one has a higher "take count" than the other.
- **Why it matters.** The previous native version used a **single per-loop take counter**,
  so a second player's *first* take was thrown away because the first player was already
  at take 3. That is the exact bug this checklist exists to prevent from coming back.
- **How the current implementation covers it.** There is no shared take counter anywhere.
  A clip is identified by its own unique id and by `authorId`; takes are per clip and per
  author. The document is append-only, so a "later" take never supersedes an earlier one —
  the layer list grows. Undo only ever removes the last layer *this device* recorded
  ([`lastLocalLayerIndex()`](src/audio/engine.ts:565)).
- **Manual check.** Device A records three takes; device B then records its first. B's take
  must be kept and must play, on both devices.
- **Status:** `covered by design`.

### 6. Per-author audio partition

- **Situation.** One peer removes or undoes a layer.
- **Why it matters.** Removing "a layer" must mean that peer's layer, never another peer's.
- **How the current implementation covers it.** [`undo()`](src/audio/engine.ts:302) removes
  the last layer whose `authorId` matches this device's identity, and a remote removal
  targets one clip id ([`removeLayer()`](src/audio/engine.ts:556)). Because a tombstone is
  written only for the removed id, every other peer's layers are untouched.
- **Manual check.** Have A and B each record a layer, then undo on A. Only A's layer goes;
  B's keeps playing on both devices.
- **Status:** `covered by design`.

### 7. Late add on a deleted clip is rejected

- **Situation.** A clip id that has already been tombstoned is offered again.
- **Why it matters.** A delete that can be undone by a late arrival is not a delete.
- **How the current implementation covers it.** A clip id may be appended **once**:
  [`appendClip()`](src/collab/projectStore.ts:244) refuses an id that is already present in
  the clip list and reports the refusal instead of writing. A tombstone keeps its array entry
  with `deleted: true`, so "already present" includes "present and deleted" — the store itself
  now makes a deleted clip impossible to re-append, instead of relying on no caller happening
  to try. A refusal is not treated as a share either:
  [`publishClip()`](src/collab/controller.ts:346) does not announce the blob and says so on the
  status line. On the read side the pump skips any record with `deleted`
  ([`pumpOnce()`](src/collab/controller.ts:534)), removes the layer if it exists, and the
  engine refuses to add a layer it already holds.
- **Stated plainly.** The guard sits on the append path — the only way a clip enters the
  document in this codebase — and answers "is this id already here?" against this device's
  replica. It is not a merge-level rule: Yjs still merges two peers' documents, and a peer that
  never saw the tombstone cannot be stopped by it.
- **Manual check.** Delete a clip, then reload the deleting device and reconnect. The clip
  must not come back.
- **Status:** `covered by design` — the refusal is now a property of the store rather than a
  convention its callers follow, but it has not been exercised on real devices.

### 8. Bounds and mismatch handling

- **Situation.** A clip's duration does not match the canonical loop; a clip cannot be
  decoded; a clip carries an absurd duration.
- **Why it matters.** A length mismatch is transient (the canonical length can still
  change) and must not be permanent; genuinely corrupt bytes should not be retried forever;
  a nonsensical duration must not disturb anything else.
- **How the current implementation covers it.**
  - *Length mismatch:* [`isCompatible()`](src/collab/controller.ts:601) returns false for
    this pass only, the clip is skipped, and the reason is surfaced ("A clip has a
    different loop length — retrying."). The next pump re-evaluates it.
  - *Undecodable bytes:* added to the permanent set keyed by **blob hash**
    ([`undecodable`](src/collab/controller.ts:85)) — a deterministic failure, so retrying
    is pointless. Two clips sharing a hash share the memory.
  - *Non-positive or absurd duration:* `isCompatible()` returns false when
    `sampleRate <= 0` or `cycleFrames <= 0`, so such a clip is skipped like any other
    mismatch and never touches the loop.
- **Partial coverage — stated plainly.** The "absurd duration" case rides the same
  mismatch path as a normal mismatch; it is not separately clamped or rejected, it is just
  never compatible. That is safe, but it means there is no distinct "refused" status for it.
- **Manual check.** Publish a clip, then change the canonical loop by undoing everything on
  the other device and recording a different length; the first clip must be "retrying", not
  permanently skipped, and the app must keep working.
- **Status:** `covered by design` (partly — see the note above).

---

## Scenarios introduced by this rewrite

### 9. Loop adoption

- **Situation.** A device joins with no loop of its own.
- **Why it matters.** Without reading the header back, a joiner never learns the session's
  cycle; its first take would define a new loop and the two devices would disagree.
- **How the current implementation covers it.**
  [`adoptCanonicalLoop()`](src/collab/controller.ts:456) reads the header's set-once
  `sampleRate`/`cycleFrames`, converts them to local frames, and calls
  [`adoptSharedLoop()`](src/audio/engine.ts:495). The engine then cycles the canonical
  length, and a subsequent take goes down the **overdub** path, so it is published with
  `cycleFrames` equal to the canonical length in local frames — which the other side
  accepts.
- **Manual check.** Device A records first. Device B then opens the link and, without
  recording, must show the same loop length as A (disc sub-line, e.g. "3.4 s loop"). B then
  records; A must accept and play B's clip, and both must still show the same length.
- **Status:** `covered by design`.

### 10. Rate conversion

- **Situation.** Two devices run at different AudioContext rates (e.g. 44.1 kHz against
  48 kHz).
- **Why it matters.** The header stores the *writing* device's rate, so a naive comparison
  would make the two peers disagree about the loop duration.
- **How the current implementation covers it.** The engine's cycle is expressed in local
  frames, and the header length is converted by
  `round(headerFrames * localRate / headerRate)`
  ([`adoptCanonicalLoop()`](src/collab/controller.ts:470)). Arriving audio is resampled to
  the local rate once, on ingest, by
  [`decodeClip()`](src/collab/codec.ts:73) (via `decodeAudioData`). Only the *duration* can
  differ between peers — never the rate.
- **Manual check.** Join a laptop (often 48 kHz) and a phone (often 44.1 kHz); both must
  report the same loop length, and each must play the other's clip at the right duration.
- **Status:** `not yet verified` — the conversion and resampling are clear in the code, but
  the whole point is cross-hardware behaviour, which cannot be confirmed by reading alone.

### 11. Conflicting loops

- **Situation.** Each device recorded its own first take at a different length before they
  were connected.
- **Why it matters.** Someone's audible work must not be silently discarded.
- **How the current implementation covers it.** The header's length wins as canonical, but
  [`adoptSharedLoop()`](src/audio/engine.ts:495) **refuses to clobber** a locally defined
  loop. The device keeps playing its own loop and is told, with both lengths, to *undo its
  layers to join* ([`conflictMessage()`](src/collab/controller.ts:436)). Once its layers are
  gone, the local loop is released
  ([`releaseLoopIfUnowned()`](src/audio/engine.ts:819)) and a later adoption succeeds.
- **Manual check.** Record a first take on A alone (~3 s). Record a first take on B alone
  (~5 s). Connect them. B (the later adopter) must show the "different length … undo your
  layers to join" message and keep playing its own loop; undo B's layers and the message
  must clear and B must adopt A's length.
- **Status:** `covered by design`.

### 12. Record-lock lease

- **Situation.** Two peers start recording; or one dies/backgrounds mid-take; or one keeps
  recording for a long time; or one leaves.
- **Why it matters.** The indicator must converge on a single holder, must not hang after a
  device disappears, and must never block anyone.
- **How the current implementation covers it.** `recordLock` is a top-level `Y.Map`
  ([`RECORD_LOCK_MAP`](src/collab/projectStore.ts:53)) holding
  `{identityId, name, color, at}`. Concurrent claims write the same four keys, so Yjs's
  per-key rule (higher client id wins) resolves every key to the same holder — both devices
  agree on one claimant. Expiry is evaluated **on read**
  ([`getRecordLock()`](src/collab/projectStore.ts:282)) against
  [`RECORD_LOCK_TTL_MS = 60000`](src/collab/projectStore.ts:62), so a dead or backgrounded
  holder stops being reported after 60 s with no cleanup traffic; a live holder stays
  reported by refreshing every 15 s
  ([`refreshRecordLock()`](src/collab/projectStore.ts:312)). `stop()` releases immediately
  ([`releaseRecordLock()`](src/collab/projectStore.ts:324), called from
  [`stop()`](src/collab/controller.ts:295)). The claim is informational only: a local take
  is never refused, queued or delayed.
- **Manual check.** (a) Hold a take on A and watch B's Session tab show "Recording now"
  with an age that keeps resetting; stop on A and it must clear. (b) Force-quit A mid-take
  and confirm B stops reporting it within ~60 s with no other traffic. (c) Leave the
  session on A while it holds the claim and confirm B clears it immediately. (d) Start
  takes on both at once and confirm each is told it is recording too, and both takes are
  kept.
- **Status:** `not yet verified` — the two-claimant race and the 60 s wall-clock expiry are
  timing-dependent and were not exercised on hardware.

### 13. Join without a microphone

- **Situation.** A device joins a room and never taps the disc.
- **Why it matters.** Joining must not ask for microphone permission, and a silent joiner
  must still hear the shared loop.
- **How the current implementation covers it.** [`startSession()`](src/main.ts:77) calls
  [`ensureAudioContext()`](src/audio/engine.ts:181) — context and graph only, **never** the
  microphone ([`ensureReady()`](src/audio/engine.ts:220) is the only path that calls
  `getUserMedia`). The pump fetches and stores bytes without a context and decodes them once
  one exists, so a joiner holds and plays the loop without recording anything.
- **Manual check.** Open the invite link in a second browser that has never granted mic
  access. It must join, show the peer count, and play the loop with **no** permission
  prompt. (Tapping the disc afterwards is what should prompt.)
- **Status:** `covered by design`.

---

## Status summary

| # | Scenario | Mark |
|---|---|---|
| 1 | Out-of-order delivery | `covered by design` |
| 2 | Duplicate delivery | `covered by design` |
| 3 | Lost message recovery | `covered by design` |
| 4 | Concurrent creation is not deletion | `covered by design` |
| 5 | No peer is dropped for being behind | `covered by design` |
| 6 | Per-author audio partition | `covered by design` |
| 7 | Late add on a deleted clip is rejected | `covered by design` |
| 8 | Bounds and mismatch handling | `covered by design` (partly) |
| 9 | Loop adoption | `covered by design` |
| 10 | Rate conversion | `not yet verified` |
| 11 | Conflicting loops | `covered by design` |
| 12 | Record-lock lease | `not yet verified` |
| 13 | Join without a microphone | `covered by design` |

---

## Two-device manual test script

Do this with a **laptop and a phone** against the live site:
<https://laurln.github.io/new_looper_web/>. Keep both on the same Wi-Fi first (mobile
carrier networks may need a TURN relay, which this build does not configure — see step 9).

1. **Open the app on both devices.** Confirm the disc reads "Tap to record".
2. **On the laptop, open the gear → Session tab → "Start a session".**
   *Expected:* a room code appears, the URL gains `#room=…`, and the status reads
   "Looking for peers…". The top-bar pill appears as a hollow dot (`◌`).
3. **Tap "Copy invite link" and open that link on the phone.**
   *Expected:* the phone auto-joins. No microphone prompt appears (see scenario 13).
4. **Confirm the room is live.**
   *Expected on both:* the Session tab reads "Connected · 2 in session"; the top-bar pill
   becomes a filled green dot with the count — **`● 2`**.
5. **Record a take on the laptop.** Tap the disc, play or speak for a few seconds, tap to
   stop.
   *Expected on the laptop:* the disc shows "Looping — tap to overdub" and a loop length
   such as "3.4 s loop".
   *Expected on the phone, with no reload:* the Session tab briefly shows "Fetching 1 clip
   from peers…", then the shared layer appears and is audible at the next loop boundary.
6. **Confirm both devices agree on the length.**
   *Expected:* both disc sub-lines report the **same** loop length (this is scenario 9 —
   the phone adopted the canonical length; if the two devices run at different sample
   rates, scenario 10 is what makes the durations match).
7. **Check the record indicator.**
   *Expected:* while the laptop is recording (tap the disc to start again, and hold), the
   phone's Session tab shows a "Recording now" field with the laptop's name, colour and an
   age that keeps resetting, and the phone's pill gains a recording dot. The laptop's own
   Session tab must **not** show itself as "recording now". Stopping the take clears the
   phone's field. Neither device is blocked from recording at any point (scenario 12).
8. **Join without a microphone (optional third window).** Open the invite link in a browser
   profile that has never granted mic access, and never tap its disc.
   *Expected:* it joins, shows a peer count of 3, plays the loop, and never prompts for the
   microphone.
9. **Watch for the connection failure case.**
   *Expected:* if the two devices cannot open a direct connection (common on some mobile
   networks), the Session tab shows *"Could not open a direct connection to a peer. Some
   mobile networks need a TURN relay — audio will stay local until a path is found."* Audio
   then stays local on each device. Moving both devices to the same Wi-Fi should restore it.

### What each status string means

| What you see | Where | What it means |
|---|---|---|
| "Not in a session" | Session tab, idle | No room joined. |
| "Looking for peers…" | Session tab, searching | Joined the room, no peer connected yet. |
| "Connected" | Session tab, live | At least one peer is connected. |
| "Connection problem" | Session tab, error | A join/signalling error is active (see the line below the status). |
| "Joined the shared loop: N s" | Session tab | This device adopted the canonical loop length. |
| "This device has a loop of a different length (D s) than the session (S s). Undo your layers to join the session loop." | Session tab | The conflict case (scenario 11): undo this device's layers to adopt the session length. |
| "‹Name› is recording too — your take will be added alongside." | Session tab | Another peer held the record lease when you started. Informational only; nothing is blocked. |
| "A clip has a different loop length — retrying." | Session tab | A clip does not match the canonical duration yet; it will be re-checked (scenario 8). |
| "A clip could not be decoded on this device and was skipped." | Session tab | That content hash is undecodable here and is skipped permanently (scenario 8). |
| "Received audio failed its integrity check and was discarded." | Session tab | A transfer did not match its SHA-256 hash; it is discarded and will be re-requested. |
| "Could not share the take" | Session tab | Encoding/storing/announcing a local take failed. |
| "Collaboration needs a secure context — open the app over https:// or localhost." | Session tab | The page is not a secure context, so WebRTC/crypto are unavailable. |
| "Could not open a direct connection to a peer. Some mobile networks need a TURN relay — audio will stay local until a path is found." | Session tab | ICE connected the peers but the data path failed — the CGNAT/TURN case. |
| "Could not join the signalling network" | Session tab | `joinRoom()` itself threw (signalling unavailable). |
| "Fetching N clips from peers…" | Session tab | Metadata is here but the audio bytes have not arrived yet. |

---

## Future work

The checklist is the interim verification because the project has **no test runner**. For
these scenarios to be automated, three things would need to exist:

1. **A test runner** wired into the toolchain (there is no `test` script in
   [`package.json`](package.json:1) today), so `npm test` can fail a build.
2. **A way to drive the collaboration layer without a browser.** The controller reaches
   directly for `AudioContext`, `IndexedDB`, `crypto.subtle`, `window.setInterval` and
   Trystero's `joinRoom`, so a headless run would need those seams injectable — a fake
   transport that can reorder, duplicate and drop messages, and a fake clock so the 2 s
   pulse, the 15 s refresh and the 60 s lease expiry can be advanced instantly instead of
   waited out.
3. **Fixtures for encoded clips** — at minimum a valid WAV16 blob, a deliberately corrupt
   blob for the integrity check, and clips at two different durations and two sample rates
   so the adoption, rate-conversion and mismatch paths can be asserted directly.

With those, scenarios 1–9, 11 and 13 are unit-testable (they are pure metadata/state
logic), while scenarios 10 and 12 — and the audible half of 9 — would still want a
real-device or browser-level test.
