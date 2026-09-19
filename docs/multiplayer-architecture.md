# Multiplayer / multi-user collaboration architecture — research and recommendation

Status: **Planning artifact (research + design only). No application code was changed.**
Scope: how to let multiple people collaborate on one shared `loop-recorder` project when the app is
served as a static site from GitHub Pages, with a **zero budget** and **Android / Windows / iOS**
as first-class clients.

> **Verification caveat.** This document was produced without live network access. Every public
> free-tier limit quoted below is marked with a confidence tag:
> - **[stable]** = long-standing, widely documented behaviour unlikely to change soon.
> - **[verify]** = a number or plan detail that has changed before and **must be re-checked against
>   the provider's current pricing page before implementation**.
> - **[assumption]** = engineering judgement, not a provider-published fact.

---

## 1. Executive summary

**Recommendation: a "metadata-in-a-CRDT, bytes-out-of-band" hybrid.**

- **Shared project metadata** (the list of clips, loop parameters, project settings, and every future
  collaborative feature) lives in a **Yjs** document. Yjs is the CRDT; it is small, mature, works in
  WebKit without `SharedArrayBuffer`, and has ready-made providers for every transport we care about.
- **The metadata is synchronized over a WebSocket relay on a free tier**, because a
  client-to-server WebSocket is an **outbound** connection and therefore **entirely sidesteps the
  NAT/CGNAT/TURN problem**. This is the single most important reliability decision for an
  iOS/Android-first app on carrier networks.
- **Audio bytes never enter the CRDT.** Each recorded clip is encoded, content-addressed by
  SHA-256, stored locally in IndexedDB/OPFS, and moved **out of band** — peer-to-peer over a WebRTC
  data channel when a direct path exists, otherwise via free-tier object storage or re-seeding from
  any peer that already has the blob. The CRDT only carries the small `blobRef` handle.
- **Offline** works because the Yjs doc is persisted with `y-indexeddb` and blobs live in a local
  store; on reconnect Yjs merges updates and missing blobs are fetched on demand.
- **Playback is never synchronized**, by design. Because every clip is published already *folded
  into exactly one loop cycle* (the existing engine invariant), a receiving peer just drops it into
  its layer list and plays it on its **own** `AudioContext` clock. There is no clock sync, no RTP,
  no jitter buffer.

**Fallback (if you refuse to run any backend at all):** pure P2P — Yjs over WebRTC data channels via
**Trystero** signalling (BitTorrent trackers / Nostr / MQTT) with **Metered Open Relay** as a
best-effort free TURN, plus `y-indexeddb` for local durability. This is achievable at literally zero
infrastructure, but it is **not durable across sessions** (state survives only while at least one
peer is online) and a meaningful minority of mobile-to-mobile connections will need TURN that we
cannot guarantee for free.

---

## 2. What the existing app actually gives us

Understanding the current data model is what makes the rest of this design cheap, so the key facts:

| Fact | Where | Why it matters for collaboration |
|---|---|---|
| A layer is **mono float32, exactly one loop cycle long** | [`Layer`](src/audio/engine.ts:38), [`MonoBuffer`](src/audio/dsp.ts:16) | A published clip needs **no offset/frame metadata** to play remotely. Playback is "start at cycle boundary". |
| Loop cycle length is **defined by the first take** | [`commitFirstTake()`](src/audio/engine.ts:399) sets `loopLengthFrames = take.samples.length` | The loop length must become **shared project state** (set-once) or peers will disagree. |
| Overdubs are **folded into the cycle locally** before being stored | [`foldIntoCicle()`](src/audio/engine.ts:469) | Latency compensation is already applied by the recording device. **Remote peers must NOT re-fold** — they consume the finished one-cycle buffer. |
| Layer ids are a **local integer counter** | [`nextLayerId`](src/audio/engine.ts:111) | Must become **globally unique string ids** for replication. |
| Engine keeps `layers[]` in memory only — **no persistence at all** | [`LoopEngine`](src/audio/engine.ts:92) | Collaboration introduces the first persistence requirement in the app. |
| UI state flows through a tiny observable | [`Observable`](src/util/observable.ts:4), wired in [`main.ts`](src/main.ts:44) | The shared doc can project into these observables without rewriting the UI. |
| Playback scheduling uses only the local `AudioContext` clock | [`scheduleHorizon()`](src/audio/engine.ts:554) | Confirms the "no playback sync" requirement is natural, not a compromise. |
| iOS backgrounding already drops in-flight takes | [`handleBackgrounded()`](src/audio/engine.ts:278), [`visibilitychange`](src/main.ts:101) | The app already models "connection can die at any moment"; the network layer must do the same. |
| Calibration is **per device** in `localStorage` | [`CALIBRATION_KEY`](src/audio/calibration.ts:18) | Must stay local; never replicate it. Each peer compensates its own latency. |
| Deploy is **static, no headers** | [`deploy.yml`](.github/workflows/deploy.yml:1), [`base: './'`](vite.config.ts:7) | GitHub Pages cannot set `COOP`/`COEP`/`CSP`/`Permissions-Policy`. **Anything needing cross-origin isolation (`SharedArrayBuffer`) is disqualified.** |
| Zero runtime dependencies | [`package.json`](package.json:1) | Adds a real constraint: prefer one small, tree-shakeable sync dependency. |

### 2.1 Consequence: define clip = "one finished cycle"

A replicated clip is therefore:

```
{ id, authorId, createdAt,
  sampleRate,            // the author's AudioContext rate, e.g. 48000
  cycleFrames,           // length of the folded buffer == shared loop length
  codec: 'wav16' | 'opus',
  blobHash,              // SHA-256 of the encoded bytes
  blobBytes,             // byte length
  slot }                 // ordering / layer index, 0..4
```

Everything else the engine tracks (`originFrame`, `shiftFrames`) is **local-clock bookkeeping** and
is deliberately not replicated. If a peer's `sampleRate` differs from the clip's, the receiving peer
resamples once on ingest (via `OfflineAudioContext`) and caches the result.

---

## 3. Requirements and hard constraints

| # | Constraint | Architectural consequence |
|---|---|---|
| C1 | Zero budget | Every server dependency must have a genuinely free + sustainable tier, or be P2P/self-hosted on an always-free VM. Free tiers can and do change. |
| C2 | Served from `github.io`, static only | Frontend bundled by Vite with `base: './'`. Any backend is third-party/serverless. **No custom HTTP response headers** → no cross-origin isolation. |
| C3 | Android + Windows + iOS | WebRTC + WebSocket + IndexedDB all supported; iOS WebKit lifecycle and storage eviction dominate the design. |
| C4 | Extensible to future features | The sync unit must be a **generic document**, not an audio-specific pipeline. |
| C5 | No playback synchronization needed | Removes clocks, RTP, media streaming, and jitter buffers. This is a huge simplification and should be treated as a hard design invariant. |

---

## 4. Option space evaluation

### 4.1 Pure peer-to-peer, no backend

**WebRTC data channels** give us ordered/unordered, reliable/unreliable binary transport between
browsers. What they lack is *signalling* (peers must first find each other) and often *relaying*
(see §5).

| Approach | How signalling works | Cost | Notes |
|---|---|---|---|
| **Trystero** | Serverless: BitTorrent/WebTorrent trackers, **Nostr** relays, **MQTT** brokers, IPFS, or Firebase/Supabase | Free [stable] | Rooms derived from a room id + app id. Data channels + optional media. Actively maintained. Small dependency. Well suited to "no backend at all". |
| **y-webrtc** | Public signalling servers (historically Heroku-hosted) | Free [verify] | Availability of the community signalling servers has been flaky; you can self-host or pair it with Trystero-style signalling. |
| **PeerJS** | Public PeerServer cloud broker | Free [verify] | No SLA, no TURN included; broker outages are a known risk. |
| **Raw RTCPeerConnection + copy-paste/QR offer-answer** | Manual | Free | Zero infra, terrible UX; only viable as a debugging tool. |

**Fundamental limits of pure P2P for this app**
1. **NAT/CGNAT** — see §5. Some fraction of mobile↔mobile pairs cannot connect without TURN.
2. **No durable storage** — a Yjs doc only exists where a peer holds it. When the last peer leaves,
   the project is gone (unless someone has it cached locally and returns).
3. **Mesh scaling** — full mesh is O(n²); fine for 2–6 musicians in a jam, not for 30.
4. **Signalling = dependency on someone else's free infrastructure**, which can (and has) changed
   terms without notice.
5. **iOS backgrounding** tears down PeerConnections; reconnect logic is mandatory.

### 4.2 Free-tier BaaS / realtime backends

| Service | Free tier headline limits | Blobs? | Fit |
|---|---|---|---|
| **Supabase** | 500 MB Postgres, 1 GB file storage, ~5 GB egress, 2M realtime messages/mo, 200 concurrent realtime connections; **projects pause after ~7 days of inactivity** [verify] | Yes, Storage (S3-style) | **Strong.** Realtime *Broadcast* is a viable Yjs transport; Storage covers blobs; anon auth covers identity. Pause-on-inactivity is the main risk for a hobby project. |
| **Firebase** (Spark) | Realtime DB 1 GB stored + 10 GB/mo download; Firestore 1 GiB + 50k reads / 20k writes / day; **Cloud Storage requires upgrade to Blaze (pay-as-you-go)** for new projects [verify — changed in 2024] | RTDB/Firestore: no. Storage: Blaze-gated | **Good for tiny metadata only** (RTDB has excellent offline persistence). Blob storage is the blocker. |
| **Appwrite Cloud** | ~1 GB storage and a small monthly bandwidth allowance; limited projects [verify] | Yes | Reasonable alternative, smaller ecosystem for Yjs providers. |
| **Nhost** | Postgres + Hasura + storage free tier; may pause/restrict [verify] | Yes | Fewer Yjs integrations; more moving parts. |
| **PocketBase** | Open source single binary — *not* hosted. You must run it | Via S3 or local disk | **Only free if you self-host.** No first-party realtime CRDT provider; you'd use its SSE/WebSocket manually. |
| **Firebase Realtime DB** (specifically) | 1 GB, 10 GB/mo [verify] | No | Interesting as a *tiny, ultra-cheap metadata* store with built-in offline cache. |

### 4.3 Free-tier serverless compute for signalling/relay

| Service | Free allowance | Fit for a Yjs relay |
|---|---|---|
| **Cloudflare Workers** | ~100,000 requests/day, small CPU budget per request [verify] | Yes, as the front door. |
| **Cloudflare Durable Objects** | A free-plan tier now exists (SQLite-backed), reportedly ~100k requests/day with modest storage [**verify — this is recent and is the linchpin of the primary recommendation**] | **Best fit:** one DO per room = a stateful WebSocket relay with hibernation. This is exactly the `y-websocket`/`partyserver` shape. |
| **Deno Deploy** | Generous free tier historically; terms have shifted [verify] | Usable as a plain WebSocket relay, but no built-in per-room state as clean as DOs. |
| **PartyKit** | Now part of Cloudflare; free dev tier; production pricing [verify] | Developer-friendly superset of the DO pattern. |

**Key point:** for *metadata* (a few KB per clip), a WebSocket relay on any of these is effectively
free forever at hobby scale. The relay is also the thing that makes CGNAT irrelevant (§5).

### 4.4 CRDT / sync libraries

| Library | Bundle | WebKit/mobile | Offline | Binary blobs | Verdict |
|---|---|---|---|---|---|
| **Yjs** | Core ~30–40 KB min+gz [assumption] | Good; **no `SharedArrayBuffer` required** | `y-indexeddb` | `Uint8Array` in a `Y.Map` — but do not store big blobs in the doc (see §7) | **Chosen.** Small, proven, transports for every option above. |
| **Automerge 2.x** | WASM, hundreds of KB [verify] | Works in WebKit; heavier parse/init cost on low-end phones | Local-first by design | `Uint8Array` similarly | Powerful history model, but heavier init/bundle for a vanilla TS app that cares about mobile. Rejected on weight. |
| Others (Loro, Diamond Types, json-joy) | Varies | Varies | Varies | Varies | Watch-list. Not enough ecosystem maturity for transports to beat Yjs today. |

**Hard disqualifier to remember:** GitHub Pages cannot send `Cross-Origin-Opener-Policy` /
`Cross-Origin-Embedder-Policy`, so **`SharedArrayBuffer` is unavailable**. Any sync design that
requires cross-origin isolation is out. Yjs and Automerge 2 both work without it — but this kills
some "fast WASM CRDT" approaches before they start.

---

## 5. The NAT / TURN problem (the crux for iOS/Android)

### 5.1 The mechanics

WebRTC tries, in order: **host candidates** → **STUN reflexive candidates** (server-reflexive
IP:port discovered via a public STUN server, free) → **TURN relay candidates**. Carriers
frequently put phones behind **CGNAT** and/or **symmetric NAT**, where a STUN-reflexive address is
not reachable from the other party. When both peers are behind symmetric NAT/CGNAT, **only TURN
works**.

Industry rule of thumb [assumption, but well established]: **~10–20 % of consumer pairs fail without
TURN**; with a TURN relay, connection success approaches ~100 %. On **mobile carrier networks
specifically**, the failure rate without TURN is at the high end of that range.

### 5.2 What "zero-cost TURN" actually exists

| Option | Reality | Reliability |
|---|---|---|
| **Metered Open Relay** (`openrelay.metered.ca`) | A free, community/demo TURN service on ports 80/443/TCP+TLS | **Best-effort, no SLA, rate-limited, shared capacity.** Fine as a fallback, not as a guarantee. [verify current terms] |
| **Cloudflare TURN** | Part of Cloudflare's realtime offering; priced per GB of relayed traffic [verify — free allowance, if any, is not something to rely on] | Reliable *if paid*; treat as the paid escape hatch you cannot use under C1. |
| **Self-hosted `coturn` on Oracle Cloud Always Free** | Oracle's Always Free tier includes ARM Ampere A1 compute and a very large monthly egress allowance [verify]; `coturn` is the reference open-source TURN server | **Most credible free TURN**, but: credit card required, ARM capacity is frequently unavailable in popular regions, idle instances can be reclaimed, and you are now the operator with an uptime problem. |
| **Self-hosted `coturn` on Google Cloud free `e2-micro`** | One always-free `e2-micro` in select US regions; ~1 GB/mo egress free, then ~$0.12/GB [verify] | Free tier is enough for signalling, **not** for relaying audio — a few relayed sessions blow through 1 GB. |
| **Fly.io / Railway free tiers** | Free allowances were removed/restructured for new organisations [verify] | Not dependable as a free TURN host any more. |

**Blunt conclusion:** there is **no reliable, guaranteed, permanently-free TURN** service. Any
architecture whose *core* depends on TURN is one free-tier change away from breaking. Therefore the
design must make TURN **optional**, and must have a relay path that does not need NAT traversal at
all.

### 5.3 How this shapes the recommendation

- **Metadata path = client → server WebSocket.** Outbound only. CGNAT, symmetric NAT, and carrier
  firewalls are all irrelevant. This is why the metadata sync does **not** use WebRTC.
- **Audio path = try P2P, fall back.** WebRTC data channel when a direct path is found (fast, free,
  no quota); otherwise the bytes go through the same free-tier backend/storage. Free TURN (Metered
  Open Relay) is configured as a best-effort accelerator, never as a correctness requirement.
- **Never block the user on connectivity.** A peer must be able to record offline and publish later.

---

## 6. Audio payload strategy and size math

### 6.1 Sizes per loop cycle (mono)

All figures are bytes; `≈` values are KiB/MiB.

| Cycle | float32 @48 kHz (current in-memory form) | PCM16 WAV @48 kHz | Opus 96 kbps | Opus 64 kbps |
|---|---|---|---|---|
| 2 s | 384,000 B ≈ 375 KiB | 192,000 B ≈ 188 KiB | 24,000 B ≈ 23 KiB | 16,000 B ≈ 16 KiB |
| 4 s | 768,000 B ≈ 750 KiB | 384,000 B ≈ 375 KiB | 48,000 B ≈ 47 KiB | 32,000 B ≈ 31 KiB |
| 8 s | 1,536,000 B ≈ 1.46 MiB | 768,000 B ≈ 750 KiB | 96,000 B ≈ 94 KiB | 64,000 B ≈ 62 KiB |
| 5 layers × 8 s | 7,680,000 B ≈ 7.3 MiB | 3,840,000 B ≈ 3.66 MiB | 480,000 B ≈ 469 KiB | 320,000 B ≈ 312 KiB |

Takeaways:
- **Storing the raw `Float32Array` is the most expensive possible choice** — 8× the Opus 96 kbps
  payload and 2× the WAV payload. Never ship raw floats over the wire.
- **Opus is roughly 8–16× smaller than WAV.** A 5-layer 8-second project is ~0.5 MB in Opus versus
  ~7.3 MB raw — this is the difference between "instant" and "watch a progress bar" on mobile.
- **Base64 in JSON adds ~33 %** and forces the whole payload through a string. Any transfer must use
  **binary framing** (WebRTC data channel binary, `ArrayBuffer` in IndexedDB, `application/octet-stream`
  uploads).

### 6.2 (a) Object storage vs (b) WebRTC data channel vs (c) encoding

| Dimension | Free-tier object storage | WebRTC data channel (P2P) | Encoding choice |
|---|---|---|---|
| Cost | Counts against storage + egress quotas (Supabase ~1 GB / ~5 GB, Firebase Storage Blaze-gated) [verify] | Free; no quota (relayed bytes are between peers) | Smaller codecs multiply every quota's effective capacity |
| Speed | HTTP round trip via CDN; needs a server fetch | Direct; often faster on LAN/good mobile | N/A |
| Reliability on CGNAT | **Always works** (it's just HTTPS) | Needs a direct path; may require TURN | N/A |
| Works when peers never overlap | **Yes** | No | N/A |
| Complexity | Low–medium (upload/download + auth/RLS) | Medium–high (chunking, backpressure, retries, hashing) | Medium (encode/decode + capability detection) |
| iOS risk | Low | Backgrounding kills the channel mid-transfer → must resume | Codec/decoder support varies |

**Design:** content-address the blob (`SHA-256`). Try peers first (they re-seed anything they have —
a de-facto CDN made of the room), then fall back to free-tier storage. This gives **3 independent
sources** for the same bytes and makes each of them optional.

### 6.3 Codec reality check on iOS Safari

- **PCM16 WAV** is decode-able everywhere via `decodeAudioData` with the simplest possible encoder
  (hand-written header + interleave). It is the **conservative v1**; a short loop is still only
  ~374 KiB at 4 s.
- **Opus** (`audio/webm;codecs=opus` or Opus in an MP4/Ogg container) is dramatically smaller, but
  **iOS Safari's container/codec support has historically lagged and is version-dependent**
  [verify]. Use **capability detection with a WAV fallback**, never a hard dependency:
  1. `WebCodecs` `AudioEncoder` if present (Chrome/Edge strong; Safari partial [verify]),
  2. else attempt an Opus/WebM round-trip through `decodeAudioData`,
  3. else PCM16 WAV.
- Store the codec in `blobRef.codec` so mixed-codec rooms stay coherent ([§2.1](#21-consequence-define-clip--one-finished-cycle)).
- **Do not** use `MediaRecorder` for this: the app deliberately captures through an AudioWorklet to
  stay on the AudioContext clock ([`mic.ts`](src/audio/mic.ts:1)); `MediaRecorder`'s independent
  timeline is exactly the problem that comment describes. Encode from the already-folded
  `Float32Array`.

---

## 7. Persistence vs live-only

### 7.1 The question

"Do we need the shared project to survive when **no two peers are online at the same time**?"

| Model | Durability | Cost | Complexity | When it is the right answer |
|---|---|---|---|---|
| **Live-only, pure P2P** | None beyond a peer's local cache | **$0, no infra at all** | Low network complexity, high UX caveats | Casual jam sessions where everyone is present. |
| **Local-first + P2P** (`y-indexeddb`) | Per-device. Survives *your* offline time; reconciles when you meet again | $0 | Medium (blob eviction handling) | A "band that jams together often" — each member's device is a replica. |
| **Relay + free storage (hybrid)** | Real durability, independent of who is online | $0 within free tiers [verify] | Highest | If "come back tomorrow and it's still there" is a real requirement. |

### 7.2 Recommendation: **hybrid, with live-only as the graceful degradation**

Build the **hybrid** (relay + content-addressed blobs) as the primary, because C1/C3 are satisfied by
free tiers at hobby scale, and because the same codebase degrades cleanly to **live-only** if the
backend is unreachable: the Yjs doc still works locally, updates queue, and blobs still move P2P.
Concretely:

- **Source of truth:** the Yjs document (metadata). It is *small* (well under 1 KB per clip), so a
  1 GB free database holds an enormous number of clips — effectively unlimited at this scale.
- **Blob durability:** blobs are **content-addressed**, so the *same* bytes are found whether they
  come from storage, a peer, or the local cache. Storage is a **cache of last resort**, not the
  authoritative copy.
- **Replication policy:** keep blobs for the current project; opportunistically cache blobs from
  peers you have connected to (making the room its own CDN). Evict oldest-first under storage
  pressure, never evicting blobs this device authored.
- **Explicitly document** to the user which mode they are in: *"Saved to cloud"* vs *"This session is
  live-only — it disappears when everyone leaves."*

---

## 8. Identity, rooms, and invites (zero cost)

| Concern | Approach |
|---|---|
| **Room id** | A random 128-bit id encoded as base32/base64url, e.g. `?room=K3F9-QX2M-7T4A`. Placed in a **shareable URL** (the app already has a single-page entry point at [`index.html`](index.html:14)). Usable as a QR code for in-person jams. |
| **Invite** | Just the URL — no accounts, no emails, no backend invite table. This is the whole point of zero-cost. |
| **Identity** | A **random anonymous device keypair** generated on first launch and kept in `localStorage`: `{ peerId, name, color }`. No sign-up. Optional "set a display name". |
| **Authentication to the backend** | Use the provider's **anonymous auth** (Supabase anon auth, Firebase anonymous auth) so RLS/permissions are enforceable *without* collecting PII. |
| **Authorization** | If a project ever needs to be private, put a **shared secret in the URL fragment** and derive the room key from it. Note: metadata is only as private as the link — treat it as "unlisted", not "secure", unless you add end-to-end encryption. |
| **Presence** | Yjs **Awareness** (ephemeral, not persisted): who is online, display name, colour. Drives the "3 people in this session" UI. |
| **Anti-abuse** | Free tiers are the limit: anonymous room creation must be cheap to ignore and cheap to clean up. Add a "delete project" action and a TTL sweeper for abandoned rooms [assumption]. |

**Security note:** a room id in a query string is visible in server logs/referrers; a fragment
(`#room=…`) is not sent to the server. Prefer the **fragment** and pass it to the client-side router.

---

## 9. Data model and sync semantics

### 9.1 Shared Yjs document

```
Y.Doc
├─ Y.Map  "project"
│    ├─ schemaVersion : number          // bump when the shape changes
│    ├─ id             : string         // == room id
│    ├─ name           : string
│    ├─ sampleRate     : number         // canonical rate for resampling, set-once
│    ├─ cycleFrames    : number | null  // set-once by the FIRST clip; the shared loop length
│    ├─ createdAt      : number
│    └─ settings       : Y.Map          // ext. point: metronome, tempo guess, future knobs
│
├─ Y.Array "clips"                      // append-mostly, ordered
│    └─ Y.Map                           // one per clip (see the shape in section 2.1)
│         ├─ id, authorId, authorName, createdAt
│         ├─ cycleFrames, sampleRate, codec
│         ├─ blobHash, blobBytes
│         ├─ slot        : number
│         └─ deleted     : boolean      // tombstone; keeps deletes commutative
│
├─ Y.Array "events"                     // ext. point: future feature timeline / audit log
└─ Y.Map   "features"                   // ext. point: per-feature namespaced sub-state
```

**Why this shape is extensible (C4):** the replication unit is *the document*, not audio. A future
"shared mixer settings", "shared lyrics", "shared MIDI notes" or "arrangement sections" feature is a
new key in `features` or a new `Y.Array` — it inherits transport, offline, conflict resolution, and
persistence for free. No new networking code.

### 9.2 Conflict resolution

| Conflict | Resolution |
|---|---|
| Two clips appended simultaneously | `Y.Array` insert is commutative; both survive, deterministic order by (createdAt, id). |
| Two peers record the **first** clip at the same time (both define `cycleFrames`) | `cycleFrames` is **set-once**: the first write wins (Y.Map LWW). The losing clip's cycle length differs, so it is either dropped or kept **muted** and flagged to the user. **This must be surfaced in the UI**, not silently swallowed. |
| Clip deleted while a peer is offline | `deleted: true` tombstone; on reconnect the delete wins regardless of arrival order. Undo/redo stays deterministic. |
| Two people edit the same future scalar (e.g. project name) | Yjs LWW per key — acceptable, standard. For counters use `Y.Map` numeric types carefully or an add-only event log. |
| Duplicate audio for the same musical content | Content addressing dedupes automatically. |

### 9.3 Undo semantics change

Today `undo()` pops the **last local layer** ([`undo()`](src/audio/engine.ts:252)). In a shared
project that is ill-defined — you must not delete someone else's clip. Recommendation: **"undo"
removes the last clip *authored by this device*** (and discards an in-flight take as it does today).
This is a small, honest semantic change that must be decided explicitly.

### 9.4 Integrating with `LoopEngine` without forcing playback sync

The engine already has the perfect seam: `layers: Layer[]` and a projection onto
[`Observable`](src/util/observable.ts:4) snapshots consumed by the UI. The integration is:

1. **`Layer.id` becomes a string** (UUID/ULID). Internal-only change.
2. **A `ProjectStore` (new) wraps the `Y.Doc`** and exposes `clips` as a stream.
3. **`LoopEngine` subscribes to the store**: `clips` in → `layers` in (dedupe by id).
4. **On commit, the engine publishes**: `commitFirstTake` / `commitOverdub` already produce a folded
   `Float32Array`; it is encoded, hashed, stored locally, and a `blobRef` is appended to `clips`.
5. **`cycleFrames`** is published on the first commit; incoming clips with a different value are
   resampled/rejected as described above.
6. **`sampleRate` mismatch** → resample once via `OfflineAudioContext`, cache the resampled buffer.
7. **Playback untouched.** Each peer's scheduler keeps running on its own clock. A remote clip simply
   becomes another `AudioBufferSourceNode` at the next cycle boundary — exactly
   [how `scheduleCycle()` already works](src/audio/engine.ts:577). **No clocks are ever compared.**
8. **`bufferCache`** must be invalidated/dropped when a blob arrives (the layer object identity
   changes), so the resampled/decoded `AudioBuffer` is built once per peer.

### 9.5 Offline behaviour

| Situation | Behaviour |
|---|---|
| Peer records while offline | Clip is committed locally, encoded, stored in IndexedDB; `clips` update is queued in the Yjs doc. |
| Peer reopens the app offline | `y-indexeddb` loads the doc; blobs load from the local blob store; project is fully usable solo. |
| Peer reconnects | Yjs exchanges state vectors and merges; missing blob hashes are fetched from peers/storage on demand. |
| Blob evicted by the browser (iOS is aggressive here) | Clip metadata remains, audio shows as "unavailable — fetching from peers"; a peer that still has it re-seeds, or it is fetched from storage. **Never lose the metadata because the bytes were evicted.** |
| Two peers were offline independently, then meet | Standard CRDT merge; the set-once `cycleFrames` rule decides which loop survives. |

---

## 10. Comparison table

| Option | Cost | Backend required | Durability when peers not online | Mobile / CGNAT reliability | Complexity | Extensibility |
|---|---|---|---|---|---|---|
| **A. Pure P2P — Trystero + Yjs + y-indexeddb (+ best-effort free TURN)** | $0, no infra | **No** (uses public signalling) | ❌ Only if a peer returns with a local cache | ⚠️ Medium–low: needs a direct path; TURN not guaranteed | Medium | ✅ High (any Yjs type) |
| **B. y-webrtc / PeerJS public brokers** | $0 | No first-party | ❌ | ⚠️ Low: public broker availability is the weak point | Low–medium | ✅ High |
| **C. Relay on free serverless — Cloudflare Workers + Durable Objects [verify free tier]** | $0 within free quota | Yes (deployable, serverless) | ✅ While the DO/storage holds state | ✅ **High** — WebSocket is outbound-only, NAT irrelevant | Medium | ✅ High |
| **D. Supabase free — Realtime Broadcast + Postgres + Storage + anon auth** | $0 within free tier [verify]; pauses after inactivity | Yes (managed) | ✅ | ✅ High (HTTPS/WSS outbound-only) | Low–medium | ✅ High |
| **E. Firebase Spark — RTDB/Firestore metadata + blobs elsewhere** | $0 for metadata; **Storage needs Blaze** [verify] | Yes (managed) | ✅ | ✅ High | Low–medium | ✅ High |
| **F. Appwrite / Nhost free tiers** | $0 within free tier [verify] | Yes (managed) | ✅ | ✅ High | Medium | ✅ Medium–high |
| **G. PocketBase / coturn on Oracle Always Free VM** | $0 hardware cost; you operate it | Yes (self-hosted) | ✅ | ✅ High for relay; TURN works but upkeep/uptime is yours | **High** (ops) | ✅ High |
| **H. Automerge anywhere above** | Same as transport | Same | Same | Same | Medium–high, heavier mobile payload | ✅ High (rich history) |

Legend: ✅ good, ⚠️ caveated, ❌ not provided.

### 10.1 Rejected alternatives and why

1. **Pure P2P as the primary (option A/B).** Rejected as *primary* because the requirement is
   explicitly iOS/Android-first on carrier networks. There is **no reliable permanent free TURN**,
   and without TURN a double-CGNAT pair simply cannot connect. Choosing it as primary means choosing
   a feature that sometimes silently does not work. It remains the recommended **fallback** because
   it is the only truly infra-free option.
2. **Firebase as the storage backbone (option E as primary).** Rejected because Cloud Storage now
   requires the paid Blaze plan for new projects [verify], which breaks C1 for the *large binary*
   half of the problem. RTDB remains attractive for tiny metadata, so it is a fallback candidate.
3. **Automerge as the CRDT.** Rejected on weight for a dependency-light vanilla TS app on low-end
   phones. Yjs's small core + `y-indexeddb` + multiple transport providers wins on fit.
4. **Synchronizing playback timing.** Rejected because the task explicitly does not require it, and
   because it would force clock synchronization, jitter buffering, and RTP-style media transport —
   all of which conflict with C1 and C3. The existing "one folded cycle per layer" model means
   **content replication is sufficient**.
5. **Sending raw `Float32Array` audio over the wire / into the CRDT.** Rejected on size math (§6.1)
   and because large values in a CRDT cause unbounded memory and history growth.

---

## 11. Recommended architecture — data flow

```
┌─────────────────────────── Browser A (Android) ───────────────────────────┐
│  Mic ──AudioWorklet──► MicRecorder ──► LoopEngine.foldIntoCicle()         │
│                                            │ already folded, one cycle    │
│                                            ▼                             │
│                                   encode (Opus | WAV16)                  │
│                                            │                             │
│                              ┌─────────────┴─────────────┐               │
│                              ▼                           ▼               │
│                    Local blob store              Y.Doc "clips"           │
│                    IndexedDB / OPFS              (blobRef only)          │
│                    key = SHA-256                          │              │
│                              │                            │              │
│                              │                    y-indexeddb            │
│                              │                    (offline copy)         │
└──────────────────────────────┼────────────────────────────┘              │
                               │                                            │
          ┌────────────────────┴────────────────────┐                       │
          ▼                                         ▼                       │
   (1) WebSocket relay                       (2) WebRTC data channel        │
   metadata + awareness                      blob fast path, if a direct    │
   outbound only, NAT irrelevant             path exists (Trystero sign.)   │
          │                                         │                       │
          │                        ┌────────────────┴──────────┐            │
          ▼                        ▼                            ▼           │
  ┌─────────────────┐      Peer B / Peer C              Metered Open Relay │
  │ Free-tier relay │      re-seed blobs by hash        best effort TURN    │
  │ Cloudflare DO   │      (mesh, 2 to 6 peers)         free, no SLA        │
  │ or Supabase RT  │                                              │       │
  │ + blob storage  │◄── (3) fallback: HTTPS blob fetch/upload ────┘       │
  └─────────────────┘      always works even when nobody is online          │
          │                                                                 │
          ▼                                                                 │
┌─────────────────────────── Browser B (iOS) ───────────────────────────┐   │
│  Y.Doc merge ──► ProjectStore ──► LoopEngine.layers (dedupe by id)    │   │
│       │                                │                              │   │
│       └─ blobHash missing? fetch ──────┘                              │   │
│  blob ──► decode ──► resample if needed ──► AudioBuffer               │   │
│  each peer plays on its OWN AudioContext clock (no playback sync)     │   │
└───────────────────────────────────────────────────────────────────────┘
```

Textual summary of the three paths:

1. **Metadata + presence — always the relay.** Yjs updates and Awareness messages over one WebSocket
   to a free-tier serverless relay. Outbound-only, so CGNAT is irrelevant. Small, cheap, durable.
2. **Blobs — P2P first.** When a direct WebRTC path exists (signalled via Trystero), the encoded clip
   is chunked and sent directly. Any peer holding the blob will re-seed it.
3. **Blobs — HTTPS fallback.** If no direct path exists (double CGNAT, backgrounded peer, nobody
   online), the bytes go to/from free-tier object storage. This is the durability guarantee.

### 11.1 Transport abstraction (the anti-lock-in move)

Define one interface — `SyncTransport` (connect, send, receive, presence) — and one
`BlobTransport` (has, get, put, peers). Implement the relay and the P2P path behind them. This means:

- swapping **Supabase ↔ Cloudflare Durable Objects ↔ Deno Deploy** is a configuration change;
- a future paid tier is a new provider, not a rewrite;
- **free-tier churn cannot kill the app.** Given that every free tier here is "likely to change",
  this abstraction is not optional — it is the primary risk mitigation.

---

## 12. Phased implementation plan

Planning only. Ordered so each phase is independently shippable and the simplest working version
comes first.

### Phase 0 — Local groundwork (no network, no behaviour change)
- Widen `Layer.id` to a globally unique string; introduce a `Clip` type with the §2.1 shape.
- Add a `BlobStore` interface (IndexedDB + OPFS backend) with content-addressed put/get and eviction.
- Add encode/decode with **WAV16 as the guaranteed path** and a codec capability probe.
- Add project serialise/deserialise so a solo project can be saved and reloaded locally.
- **Exit criterion:** the app behaves identically but can save/load a project and store blobs.

### Phase 1 — Extensible shared document (metadata only, live session)
- Introduce Yjs + the §9.1 document schema + a `ProjectStore` that projects into the engine's
  observables.
- Add `y-indexeddb` so the doc is durable locally from day one.
- Wire **one** relay transport (Cloudflare Durable Object [verify free tier] or Supabase Realtime
  Broadcast) behind `SyncTransport`.
- Room id in the URL fragment + shareable link + anonymous identity.
- **Exit criterion:** two browsers see each other's clip *entries* appear live; playback stays
  independent; reload keeps the project.

### Phase 2 — Blob transfer and real audio collaboration
- Content-addressed blob exchange over the relay/storage fallback first (simplest correct path).
- Resample-on-ingest for differing `sampleRate`; refuse/report differing `cycleFrames`.
- Presence UI via Awareness; per-author undo.
- **Exit criterion:** a second device hears the first device's clip on its own clock.

### Phase 3 — P2P acceleration and TURN
- Integrate Trystero signalling + WebRTC data channels for blobs only; chunk with backpressure and
  hash verification.
- Configure Metered Open Relay TURN as a best-effort accelerator; measure and log direct vs relayed.
- Peer re-seeding and opportunistic blob caching.
- **Exit criterion:** blob transfer succeeds with the relay's blob path disabled, on at least one
  CGNAT-to-CGNAT pair, or falls back gracefully when it cannot.

### Phase 4 — Extensibility and multi-peer scale
- `features` namespace + `schemaVersion` migrations; prove it by adding one non-audio collaborative
  feature (e.g. shared project name/settings or a simple event log) using **zero** new networking.
- Room size guidance (mesh practical to ~6); define the behaviour beyond that.
- Explicit conflict UI for the double-first-take case.

### Phase 5 — Hardening and operations
- Free-tier quota telemetry (storage, egress, messages) with visible warnings before limits.
- Graceful degradation to live-only when the backend is unreachable or paused.
- TTL/cleanup for abandoned rooms; user-initiated project deletion.
- iOS lifecycle audit: reconnect on foreground, resume interrupted transfers, handle storage eviction.

---

## 13. Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **No reliable free TURN exists** | A minority of mobile↔mobile pairs cannot do P2P | Metadata never needs TURN (WebSocket relay). Blobs always have the HTTPS fallback. TURN is an accelerator only. |
| R2 | **Free tiers change or get paused** (Supabase pause-on-inactivity, Firebase Storage → Blaze, Cloudflare DO free tier is new [verify]) | Backend silently disappears | `SyncTransport`/`BlobTransport` abstraction; local-first via `y-indexeddb` so the app still works solo; visible "live-only" mode; monitor quotas. |
| R3 | **iOS WebKit lifecycle** — backgrounding suspends audio and tears down sockets/PeerConnections | Transfers and synchronisation die mid-flight | The app already models this ([`handleBackgrounded()`](src/audio/engine.ts:278)); treat every connection as ephemeral, reconnect on `visibilitychange`, resume by hash, idempotent blob puts. |
| R4 | **Storage eviction / quota on iOS** (IndexedDB can be cleared; `navigator.storage.persist()` is not reliably granted [verify]) | Local blobs vanish | Never store authoritative data only locally. Metadata is tiny and replicated; blobs are content-addressed and re-fetchable from peers or storage. |
| R5 | **Blob size / cost cliff at scale** | Egress or storage quota blown; costs appear | Opus 96 kbps default (~94 KiB per 8 s clip); content-addressed dedupe; keep blobs out of the CRDT; device-side quota telemetry; evict non-authored blobs first. |
| R6 | **Codec support drift on Safari** | A clip records but cannot be played back | WAV16 default/fallback, codec recorded in `blobRef`, capability probe, never a hard Opus dependency. |
| R7 | **Two simultaneous first takes** define different loop lengths | Half the project is unplayable together | `cycleFrames` is set-once with explicit, visible conflict handling; the losing clip is muted, not silently deleted. |
| R8 | **Signalling infrastructure is itself someone's free tier** (Trystero trackers/Nostr relays) | Peers cannot find each other | The relay path is the primary for metadata, so P2P signalling loss degrades rather than breaks. Configure multiple Trystero signalling strategies. |
| R9 | **Privacy: "unlisted" is not "private"** | Anyone with the link can read clips | Put the room id in the **fragment**, offer a share-secret-derived key, and state plainly that unlisted ≠ encrypted. Consider E2E encryption as a later phase if data becomes sensitive. |
| R10 | **No custom headers on GitHub Pages** (no COOP/COEP/CSP) | No `SharedArrayBuffer`; no hardened CSP | Already assumed. Rules out cross-origin-isolated CRDT variants; revisit only if hosting moves. |
| R11 | **O(n²) mesh growth** | Performance collapse in larger rooms | Cap practical room size (~6), make the relay authoritative if rooms must grow, or move blobs to a star topology. |

---

## 14. Items to verify before implementation

Because the numbers below drive the recommendation and are the ones most likely to have changed:

1. **Cloudflare Durable Objects free plan** — request/day, storage, hibernation WebSocket support.
   *(This is the linchpin of the primary relay choice.)*
2. **Supabase free tier** — current storage/egress/realtime-message limits and the inactivity-pause
   policy.
3. **Firebase Cloud Storage** — whether Blaze is still required for new projects on Spark.
4. **Metered Open Relay** — current terms, rate limits, and whether it is still operated.
5. **Cloudflare TURN** — whether any free allowance exists.
6. **Oracle Cloud Always Free** — current compute/egress terms and idle-reclamation policy
   (for the self-hosted `coturn` fallback).
7. **iOS Safari** — Opus container/codec support and `WebCodecs` `AudioEncoder` availability on the
   minimum supported iOS version.
8. **Yjs / Trystero** — current bundle sizes and maintained provider packages.

---

## 15. Decision summary

- **Chosen:** Yjs (shared project document) + free-tier WebSocket relay for metadata and awareness +
  content-addressed audio blobs moved P2P when possible and over free-tier object storage otherwise +
  `y-indexeddb` for offline. Playback deliberately unsynchronised.
- **Fallback:** pure P2P — Trystero signalling + WebRTC data channels + best-effort free TURN +
  `y-indexeddb`; live-session durability only.
- **Non-negotiables discovered during research:** no `SharedArrayBuffer` (GitHub Pages cannot send
  COOP/COEP); never put audio bytes in the CRDT; never make TURN a correctness requirement; keep the
  transport swappable so free-tier churn is a config change, not a rewrite.

---

## 16. Evaluation: proposed P2P version-control design

Status: **Planning artifact (analysis only). No application code was changed.**

This section evaluates a specific counter-proposal from the app owner, quoted in full:

> "How about P2P using WebRTC. STUN servers from Google are free, right? So my idea would be a form of
> version control via the STUN server. Like every loop has a version number for every player. If player 1
> records something on loop 1, their local version number goes up. Then the host of the session regularly
> polls everyone for all their local version numbers. If someone has a higher local version number than
> everyone else, the track that version number belongs to gets requested and copied onto all other
> players' projects. Through this version control it should be pretty easy to implement pretty much any
> other feature."

### 16.1 The STUN misconception (the crux)

**What STUN is.** STUN (Session Traversal Utilities for NAT) is a *discovery* protocol. A client sends a
single Binding Request to a STUN server; the server replies with the **public IP address and port that
the outside world sees the client as** (the "reflexive transport address"). This is used during **ICE
candidate gathering** in WebRTC, so a peer can advertise an address that another peer might be able to
reach. It is a short-lived, stateless request/response.

**What the owner got right.** Google's public STUN servers genuinely are **free** and widely used, e.g.
`stun.l.google.com:19302`. This is correct, and it is the same mechanism already assumed in
[§5.1](#51-the-mechanics).

**What STUN is not — stated unambiguously:**

- STUN **does not relay or carry application data.** It never sees the loop versions, clip bytes, or any
  project content.
- It is **not a message bus or mailbox.** It stores nothing and has no notion of other peers in a room.
  There is nothing to "poll" through it.
- It is **not a signalling service.** It cannot deliver an offer/answer or ICE candidate *to another
  peer*; it only reflects your own address *back to you*.
- You **cannot "poll everyone through the STUN server"** or exchange version numbers through it. A STUN
  server does not know who "everyone" is, does not authenticate a room, and keeps no state between
  requests.

Therefore **"version control *via* the STUN server" is not achievable as described.** STUN is the
wrong tool for coordination; it only helps two peers that are *already trying to talk* discover whether
a direct path is possible.

**The three roles, separated:**

| Role | Job | Who can provide it | Free? |
|---|---|---|---|
| **Signalling** | Peers exchange **Session Descriptions (SDP)** and **ICE candidates** so they can find each other. An **application-level** concern; works over any channel you can send a few small messages through. | Your own relay (WebSocket), or public infrastructure: Trystero (BitTorrent trackers / Nostr / MQTT), y-webrtc servers, PeerJS broker, or even manual copy-paste/QR | Yes in several forms, but it is **infrastructure you depend on**, not part of STUN |
| **STUN** | Discover **your own public IP:port** so you can advertise a candidate | Google public STUN (e.g. `stun.l.google.com:19302`) | **Yes, genuinely free** |
| **TURN** | **Relay** media/data when a direct path cannot be established (symmetric NAT / double CGNAT) | Paid providers or self-hosted `coturn` | **No reliable permanent free option** (see [§5.2](#52-what-zero-cost-turn-actually-exists)) — and **Google provides STUN only, not TURN** |

**What would actually be needed** to realise the owner's intent: a real **signalling/coordination
channel** (to exchange version metadata and, more fundamentally, to set up the peers' connections at
all), plus **WebRTC data channels** for moving the actual clip bytes. STUN sits *beside* those as a
NAT-discovery helper; it does not replace either.

**Respect where due:** the underlying instinct — *peer-to-peer transport plus versioning of loop
content* — is reasonable and is the same instinct behind the documented fallback in
[§15](#15-decision-summary). Only the **transport assumption** is wrong: STUN is discovery, not a channel.

### 16.2 Evaluating the version-control scheme on its merits

Assume, charitably, that a real signalling + data-channel channel exists (i.e. temporarily grant the
owner the thing §16.1 shows STUN cannot provide). The versioning logic itself still has a correctness
hole.

**Scalar counters do not establish a global order or causality.** A per-player integer says only "how
many times *this device* changed *this loop*". It is meaningless when compared to another device's
integer, because the two counters have different origins and no shared history. "Highest wins" assumes
the numbers are commensurable; they are not.

**Concrete failure case — two players record on the same loop independently:**

1. Both offline (or with an untracked partition), P1 and P2 each record a take on loop 1.
2. Each increments its own local version for loop 1: **P1 shows version 2, P2 shows version 2**.
3. The host polls, sees a tie at 2, and "higher wins" **cannot order them**. The tie is broken by
   arbitrary factors (poll order, arrival order, last-writer-wins on a timestamp).
4. Under overwrite semantics, the loser's take is **silently discarded** — one person's work vanishes
   with no UI signal. Under "keep both" semantics you have accidentally re-invented an append-only log,
   which is the *correct* model but is no longer what the scalar scheme described.

Even without a tie, divergence defeats scalar comparison: a peer with a **higher** counter may be
overwriting content the other peer based its edits on. The scalar conveys neither *what* changed nor
*whether the two lines of edits diverged*.

**The missing concept, in plain terms:** each edit needs (a) a **unique identity** and (b) **causal
history** — did this edit see the other edit or not? That is what **vector clocks / Lamport
timestamps / per-clip IDs** provide, and it is precisely what a **CRDT** gives you for free: every Yjs
item carries a unique client id + logical clock, so concurrent inserts merge commutatively instead of
racing on a number.

**The polling loop presupposes a channel that does not exist yet.** "The host regularly polls everyone
for all their local version numbers" already requires a **live bidirectional message path to every
peer**. That is exactly the signalling/data-channel problem from §16.1 — the part STUN cannot solve.
So the scheme is circular: it depends on the very thing it claims to obtain from the STUN server.

**Topology and SPOF.** Making the **host the coordinator** means the host is a single point of failure:
when the host backgrounds the app, closes the tab, or loses connectivity (iOS does this on a schedule —
see [R3](#13-risks-and-mitigations)), the **poll loop simply stops** and sync halts for everyone, even
though the other peers are still online. A CRDT transport has no such coordinator; any peer can relay
updates.

**Room-size limits are unchanged.** Full-mesh P2P is O(n²); the doc's practical guidance of **~2–6
peers** ([§4.1](#41-pure-peer-to-peer-no-backend), [R11](#13-risks-and-mitigations)) still applies. Any
blob distribution "to all other players" multiplies the same mesh fan-out.

**The NAT/TURN caveat still fully applies.** Even with a correct signalling channel, moving clip bytes
over WebRTC data channels is subject to symmetric NAT / double CGNAT, where **only TURN works**. This
proposal does **not** escape the doc's central finding: **there is no guaranteed free TURN**
([§5.2](#52-what-zero-cost-turn-actually-exists)). A fraction of mobile↔mobile transfers will fail
without it.

### 16.3 What is salvageable (and how it maps to the recommendation)

Credited explicitly, because these parts are right:

- **An append-only, versioned, replicated log of clips, each with a unique identity, is the correct
  mental model.** This is **essentially what Yjs already provides**: merging across peers, offline
  edits, deterministic conflict resolution, and a growing history. The owner's model and the doc's
  `Y.Array "clips"` ([§9.1](#91-shared-yjs-document)) are describing the same object; Yjs is simply the
  mature implementation of it.
- **"Version control makes any other feature easy" is correct.** Extensibility is real, and the
  recommended design already targets exactly that through the **`features` namespace and the `events`
  append-only timeline** ([§9.1](#91-shared-yjs-document)): a new collaborative feature is a new key or
  array in the shared document and inherits sync, offline, conflict resolution, and persistence with
  **zero new networking code**. The owner's instinct about extensibility matches the doc's plan.
- **The relation to the documented fallback.** The proposal is close in spirit to **option A (pure
  P2P)** in [§10](#10-comparison-table) and the fallback in [§15](#15-decision-summary). The concrete
  deviations:
  - the fallback uses **Trystero signalling over public infrastructure** — BitTorrent/WebTorrent
    trackers, **Nostr** relays, **MQTT** brokers — for peer discovery, **not STUN**;
  - it uses **Yjs CRDT semantics** for the metadata rather than scalar per-player counters;
  - it still adds **best-effort free TURN** (Metered Open Relay) and `y-indexeddb` for local durability.

  So the proposal is best understood as a **mis-specified variant of the already-documented fallback**,
  with the right goal and one wrong transport and one wrong ordering primitive.

### 16.4 Recommendation: reject as specified, adopt the instinct, adapt into a hybrid

**Verdict: reject the design as literally described** (STUN as the transport; scalar counters with
"highest wins"). Both parts are incorrect for the reasons above, and either one alone would cause
silent data loss or total non-function. **Adopt the underlying direction** — P2P transport + versioned,
replicated content.

**Suggested concrete hybrid:**

1. **Keep the owner's P2P data-channel approach for the bytes.** WebRTC data channels for clip blobs is
   exactly what [Phase 3](#phase-3--p2p-acceleration-and-turn) already plans. Chunk, apply
   back-pressure, verify the SHA-256 hash, resume after interruption.
2. **Replace STUN-as-transport with a proper signalling mechanism.** Use **Trystero's public
   infrastructure** (BitTorrent trackers / Nostr / MQTT) to establish peers — the doc's fallback
   signalling. STUN remains configured for **ICE candidate discovery only**; TURN (Metered Open Relay)
   remains a **best-effort accelerator**, never a correctness requirement.
3. **Replace scalar counters with a CRDT / append-only model.** Metadata — the clip list, ordering,
   tombstones, and future features — lives in the **Yjs document** with unique per-item identity and
   causal history. Concurrent edits on the same loop **merge as two clips in an append-only list**
   rather than racing on a number; deletes are tombstones; the `features`/`events` namespaces carry
   future features. If a full CRDT is deemed too heavy for a first cut, the **minimum correct
   substitute is an append-only clip list keyed by (authorId, per-clip unique id) with vector clocks or
   Lamport timestamps** — *not* per-loop scalar integers.

**When the free-tier relay still wins over P2P-only:**

- **Durability when peers are not online simultaneously** — P2P state survives only while at least one
  peer holds it; a relay + storage gives real "come back tomorrow" persistence
  ([§7.1](#71-the-question)).
- **Mobile reliability** — metadata over an **outbound WebSocket** sidesteps CGNAT entirely
  ([§5.3](#53-how-this-shapes-the-recommendation)), whereas P2P data channels do not.
- **No coordination SPOF and no O(n²) fan-out** for the metadata path.

**Honest concession — P2P-only can be a legitimate minimal first version for *live sessions*,** if the
owner explicitly accepts all three of:

- **(a)** every participant must be **online at the same time** (no durability once the room empties);
- **(b)** a **meaningful minority of mobile↔mobile pairs will fail to connect** without TURN, so some
  sessions will not work and the app must say so rather than hang;
- **(c)** a **signalling channel is still required** — Trystero/Nostr/MQTT or a relay — and it is
  someone else's free infrastructure that can change terms ([R8](#13-risks-and-mitigations)).

This concession is only viable with a **correct** metadata model (append-only / CRDT, not scalar
counters) and a **correct** signalling mechanism (Trystero, not STUN). With those two corrections, the
owner's proposal becomes a reasonable live-session fallback and a stepping stone to the recommended
hybrid — which is exactly where [§10.1](#101-rejected-alternatives-and-why) and
[§15](#15-decision-summary) already place pure P2P.
