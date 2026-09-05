# Issue #97 — definitive Web startup + playback path

Baseline: `206bed0fb577ef7c2949390a0bd29e1a81c57aa3` (`integration-v0.8.0-alpha.1`).

This implementation optimizes the everyday Web case: remembered BeatGaler session, no live MTProto connection, local presentation/routing cache available, and the first visible beats should become playable as early as possible.

## Critical path

```text
OPEN
  ├─ local presentation cache -> cards
  ├─ local playback-routing cache -> startup14
  └─ Direct starts before React/account restore completes
       -> reserve/bind + activate
       -> MTProto connect
       -> one vector getMessages(startup message ids)
       -> playback data plane published
       -> getMe/getChat continue in background
       -> WARM startup14, seven 64 KiB lanes
       -> startup WARM settles (READY or FAILED per beat)
       -> INDEX allowed
       -> authoritative Telegram reconcile
```

Cloud is not a per-audio admission layer. Playback/WARM reuse the valid Direct session and go from the browser transport directly to Telegram. Capabilities remain mandatory for sensitive writes such as import/edit/trash operations.

## Local playback-routing cache

`beatgaler:web-playback-routing:v1` stores only playback routing information:

- all known beat routes: `beatId -> { messageId, mimeType, sizeBytes }`;
- at most 14 startup routes in the current local presentation order;
- the local sort mode (`rating`, `manual`, `bpm`, `name`).

It does not duplicate rich Beat metadata. Telegram INDEX remains authoritative. Every authoritative INDEX updates/removes playback routes before rich Beat objects are materialized.

## Scheduler

Strict priority is:

```text
PLAY > WARM > INDEX
```

The Worker owns seven data lanes.

- `IDLE`: up to 7 WARM lanes.
- `PLAY_CRITICAL`: 0 unrelated WARM lanes; foreground Play owns priority.
- `PLAY_STABLE`: up to 6 WARM lanes while one lane remains available to Play.

A same-beat WARM is adopted/promoted rather than cancelled. Other active WARM downloads use real `AbortController.abort()` through mtcute `AbortSignal`; preempted work is requeued, not failed and not put on cooldown.

`PLAY_STABLE` requires actual audio data plus either a complete stream or at least 2 seconds buffered ahead. A runtime `waiting=true` immediately returns the scheduler to `PLAY_CRITICAL`.

## Prefix and continuation

Startup WARM downloads exactly one physical 64 KiB prefix per candidate. If Play targets a ready prefix, MSE receives those bytes first and the foreground stream begins immediately at the exact `prefix.byteLength`; it does not wait for the prefix to be consumed.

Playback bytes remain session-only RAM with the existing bounded 100 MB cache. No IndexedDB/Service Worker MP3 persistence is introduced here.

## INDEX

The startup coordinator owns a real INDEX barrier. It opens only after every startup candidate has settled READY or FAILED, so a stale route cannot block the authoritative INDEX forever.

INDEX remains lower priority after startup. Its byte download has an `AbortController`; Play/WARM can abort it and the INDEX operation restarts later. An INDEX preemption is not an application error.

## Background verification and fail-closed behavior

MTProto/media setup is the playback readiness boundary. `getMe` and `getChat` run after the data plane is published.

Sensitive operations wait for that verification. If background identity/vault verification fails, the controller clears the session, shuts down the Worker (cancelling streams/warm work), and stops the transport session. Credential refresh remains fail-closed.

## Runtime traces

The key timeline events are:

```text
OPEN
STARTUP_LOCAL_ROUTING_READY
DIRECT_START_DISPATCHED
DIRECT_MTPROTO_READY
DIRECT_BACKGROUND_GET_ME_OK / FAILED
DIRECT_BACKGROUND_GET_CHAT_OK / FAILED
WARM_BATCH_BEGIN
WARM_PREFIX_READY
PLAY_FOCUS_BEGIN
PLAY_WARM_ADOPTED / PLAY_WARM_PROMOTED
PLAY_WARM_PREEMPT_ALL
PLAY_PREFIX_READY
PLAY_STREAM_BEGIN
PLAY_STREAM_FIRST_CHUNK
PLAY_BUFFER_STABLE
WARM_RESUME
INDEX_WAIT_STARTUP
INDEX_BEGIN
INDEX_PREEMPTED_PLAY / INDEX_PREEMPTED_WARM
INDEX_RESUMED
INDEX_DONE
```

## Required validation

Static/CI:

```bash
npm run test:typecheck
npm run test:integration
npm run test:regressions
npm run build:web
```

Real Web/Direct runtime still has to cover, at minimum:

1. remembered session + cache + 14 beats, no interaction;
2. Play before Direct is ready;
3. Play one of seven active WARM beats (`PLAY_WARM_ADOPTED`);
4. Play beat 10–14 while seven WARM lanes are active (preemption/promotion);
5. Play outside startup14 (global Play priority);
6. ready prefix continues at offset `65536`;
7. `waiting=true` returns WARM concurrency to zero until stable;
8. zero local cache still starts Direct before library load completes;
9. stale local route fails only that beat and later INDEX corrects routing;
10. a Telegram-deleted beat/route disappears after authoritative reconcile;
11. background getMe/getChat failure shuts down the session after playback was allowed to begin.

CI proves invariants/build correctness, not the real latency target. Final acceptance therefore requires actual browser traces against Direct/Telegram.
