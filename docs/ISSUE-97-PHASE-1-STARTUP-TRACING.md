# Issue #97 — Phase 1: observe the three Web startups

Baseline: `integration-v0.8.0-alpha.1` at `a310dada5bc21a88d07cb3393ed9c43ae2a5c42e` (merged #111).

This change instruments startup. It does not optimize it. Real authenticated measurements on the instrumented build are still **UNVERIFIED**. Phase 2 will collect repeated runs; Phase 3 will choose the first optimization from that evidence.

## Independent facts, not assumptions

| Case | Navigation / local library evidence | Auth evidence | Server evidence |
| --- | --- | --- | --- |
| 1 — cold | `LIBRARY_CACHE_READ`: `miss` | restored session or interactive login | first `SESSION_START_BOOTSTRAP` reports `new` or `reused` |
| 2 — normal opening with cache (primary target) | normal navigation; `library_cache=hit`, including a valid empty array | `AUTH_RESTORE_DONE.auth_session=restored` | report actual lease state; do not infer it from cache |
| 3 — reload with active bot lease | navigation `reload` plus cache hit | restored | first bootstrap must report `server_lease=reused`, `lease_state=ACTIVE` |

`startup_type` is only a convenience classification of navigation and the existing library-cache read. A reload can have no cache or an expired lease. A quick normal reopening can still have an active lease. Preserve these as distinct subcases. Missing/invalid storage is not evidence of an empty authoritative library. Browser HTTP asset cache, artwork cache, library cache, auth cookie and live server lease are separate things.

The **first** `/session/start` decides whether a lease was already warm when the page opened. The second call normally reuses the lease just acquired by the first call; it is not proof that startup began with an active lease.

## Events and clocks

Existing `[startup-trace]` surface/card-count events and `[play-trace]` playback events remain available. New events use the same `[play-trace]` prefix.

| Bucket | Evidence |
| --- | --- |
| Entry/auth/cache | `APP_START`, remembered marker (not proof of auth), `AUTH_RESTORE_BEGIN/DONE/ERROR`, `AUTH_SESSION_CONFIRMED`, `LIBRARY_CACHE_READ` |
| Direct import | `DIRECT_CODE_IMPORT_BEGIN/DONE/ERROR`; constructor/connect still run only after the import resolves |
| Prepare | `DIRECT_PREPARE_*`, `SESSION_START_BOOTSTRAP_*`, `TEMP_AUTH_PREPARE_*`, `TEMP_AUTH_CRYPTO_INIT_*`, `TEMP_AUTH_SOCKET_OPEN_*`, `TEMP_AUTH_AUTHORIZATION_*`, `SESSION_START_BIND_*`, `TEMP_AUTH_BIND_*`, `TEMP_AUTH_DESTROY_*` |
| Worker boot | `WORKER_CREATE_BEGIN`, `WORKER_CREATED`, `WORKER_MODULE_READY`, `WORKER_REQUEST_POSTED/RECEIVED`, `WORKER_RESPONSE_RECEIVED`; request IDs link the two realms |
| Worker/session | `DIRECT_INITIALIZE_*`, existing `WORKER_INITIALIZE_*`, `WORKER_MTPROTO_CONNECT_*`, `WORKER_GET_ME_*` |
| Activation | `DIRECT_ACTIVATE_*`, `SESSION_ACTIVATE_HTTP_*`, `SERVER_SESSION_TRACE` with authoritative lease and server steps |
| Verify/readiness/play | `DIRECT_VERIFY_*`, `WORKER_VERIFY_*`, `CONTROLLER_SESSION_READY`, existing `CARD_PLAY_CLICK`, `WORKER_STREAM_FIRST_CHUNK`, `AUDIO_EVENT_PLAYING` |

Use **`ts_ms`** to align browser main-thread and Worker events: it is `performance.timeOrigin + performance.now()`. `context_id` identifies the JS realm for the current page/Worker; it is unrelated to account/lease identity. Span IDs are unique within that realm. Do not subtract main-thread `t_ms` from Worker `t_ms`.

For backward compatibility, startup surface events retain their old module-relative `t_ms`. They now also contain `nav_t_ms`, `time_origin_ms`, `context_id`, and the comparable `ts_ms`. Never subtract the old startup `t_ms` from Play `t_ms`.

`WORKER_MODULE_READY` executes **after static imports have evaluated**. Created → module-ready includes loading, parsing, evaluation and scheduling; it does not attribute those individually. Module-ready is not MTProto-ready. The socket measurement observes the existing `onUsable` boundary, not a new raw WebSocket event.

New step durations use a monotonic clock. Nested spans overlap: do not add a parent span to its children. Retry attempts have separate span IDs and `attempt` fields. A failed step emits `ERROR` and rethrows the original error without copying its contents into the new logs.

## Server correlation

The existing authenticated `/transport/session/start` and `/activate` routes add an optional `X-BeatGaler-Startup-Trace` response header. No request-body or credential contract changes. Web copies only whitelisted diagnostics into `SERVER_SESSION_TRACE`; missing/stripped/old-server headers become `server_trace_available=false`, without affecting the response.

The header includes a random request ID, route-control duration and at most 32 events, capped at 3,000 characters to leave room in proxy response-header buffers. `server_dropped_events > 0` means a partial trace, usually after repeated membership attempts. The server also logs the same request ID under `[direct-startup-trace]`.

Server steps cover lease selection/runtime hydration and activation's runtime hydration, `masterForVault`, `getEntity`, `inviteAndPromote`, `GetParticipant` attempts, cleanup and disconnect. `invite_promote_executed=true` means the existing function was invoked; it does not mean membership changed. Existing `USER_ALREADY_PARTICIPANT` handling remains intact.

Server event `t_ms` is relative to that HTTP handler. **Never align it with the browser clock.** Match the header/log by request ID and compare durations. The server duration excludes earlier auth middleware and later productive temporary-auth response transformation. Client HTTP duration includes those plus the response body/JSON/network time; any residual must not be labeled entirely as network latency.

New diagnostic fields exclude bot/vault/account/lease IDs, tokens, keys, MTProto session state, raw error messages and file names. No new browser persistence, backend state or external telemetry sink is added.

## Capture protocol for the next phase

Use the same frontend and backend source revision. A frontend-only deployment cannot reveal server activation internals. Keep the commit, browser version and network conditions with each run.

1. Open DevTools before the test. Enable **Preserve log** and show **Info** messages from all contexts (including the Worker). Keep Network **Disable cache** unchecked for normal opening and reload.
2. Start with case 2. Close/reopen the app normally using the same browser profile and same account; do not sign out or clear storage. Record whether the first bootstrap finds a new or reused lease. Repeat later after the server lease has expired if a fresh-lease opening is needed; use the configured timeout and the returned state, not a guessed delay.
3. For case 1, use a separate clean browser profile with the same account/library. Do not erase cloud data. Record whether auth restores or needs interactive login. Keep human login time separate: also measure from `AUTH_SESSION_CONFIRMED` for interactive-login runs.
4. For case 3, wait for Direct READY, then perform an ordinary reload within the existing lease lifetime. Verify cache hit **and** first bootstrap `reused/ACTIVE`. A hard reload with disabled HTTP cache is a separate test condition.
5. In each run, click one beat once as soon as usable cards appear. Save the Console log through `AUDIO_EVENT_PLAYING` or the explicit failure. Record click time relative to cards and READY; a deliberately late click is not evidence that early Play meets the target.
6. Filter the saved evidence to `[startup-trace]`, `[play-trace]`, and `[direct-startup-trace]` when sharing. These preserve Worker events; `beatgalerStartupTrace()` alone contains surface events only. Raw HAR files are unnecessary and can contain auth data.
7. Before comparing, check for stale markers, signed-out restore, retries, dropped server events, missing headers, background tabs, and bfcache/back-forward navigation. Label them separately instead of averaging incompatible runs.

Phase 2 should collect multiple runs per case and report sample count and medians; tail percentiles require enough samples. Main objective: case 2 card reveal and first one-click Play, with the practical target `click → playing < 1.5 s`. This instrumentation makes no performance claim.

## Guards retained

- `window.load + 250 ms` prewarm scheduling is intentionally unchanged, including its current reliance on a remembered-session marker.
- No eager Direct import for signed-out visitors without that marker; no Worker preload is added.
- `prepare → initialize → activate → verify` remains serial, and callers still join one connection.
- No ACTIVE-lease fast path, MTProto persistence, token revocation, additional vault creation or changed lease ownership.
- No Play/MSE, artwork/topic, authoritative library transaction or card-reveal behavior changes.

## Validation

Focused local validation covers type checking, Web compilation, startup/auth/Direct/Issue #97 regressions, a blocked-initialize concurrency test, clock correlation, diagnostic failure neutrality, and server-header redaction/bounds. Native Windows/macOS runtime and authenticated Telegram latency are not established by these tests. Integration/deployment and runtime acceptance remain separate steps; Issue #97 stays open.
