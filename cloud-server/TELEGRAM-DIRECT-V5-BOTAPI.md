# BeatGaler Direct — persistent membership and temporary MTProto

The filename is retained for existing links. Productive Desktop and Web use temporary MTProto authorization: **user device ↔ Telegram**. Cloud authorizes sessions/operations and stores control metadata. INDEX JSON and large media bytes travel directly between the client and Telegram.

## PostgreSQL ownership and lazy rollout

PostgreSQL owns `vaults.transport_bot_id`. Migration `0010_persistent_transport_assignment.sql` keeps it nullable and performs no bulk assignment. First access assigns only that vault, choosing the fewest persistent vaults per bot with a deterministic bot-ID tie. Active leases never determine ownership; there is no four-session/vault cap.

Existing ownership never changes automatically, including when its bot is missing, quarantined or rotating. Those cases fail on the assigned bot without fallback. Quarantined/rotating bots are excluded from new assignments. `transport_bots` stores public identity/state, never permanent tokens or authorization secrets. Direct requires PostgreSQL enabled and configured.

The session wrapper resolves PostgreSQL ownership and prepares/reuses a lease for that exact bot before entering the runtime. Two installations can have distinct leases for one vault and bot. Mismatched legacy leases/operations are retired locally without membership mutation. The base runtime rejects an unprepared startup; it has no FIFO/load allocator fallback.

## Membership lifecycle

- `pending`: assignment exists but provisioning has not completed. MASTER invites/promotes that same bot and verifies participant/admin state before marking `ready`.
- `ready`: startup/reentry uses the assigned bot and locally activates its lease without MASTER lookup, InviteToChannel, EditAdmin or GetParticipant.
- `repair`: explicit repair provisions the same assigned bot and returns to `ready` only after successful verification.

Provisioning/repair holds a PostgreSQL session advisory lock per vault, not an open SQL transaction around Telegram network calls. Concurrent calls coalesce. USER_ALREADY_PARTICIPANT allows promotion to continue; other failures are not silently swallowed.

Repair is authenticated `POST /transport/session/activate` with `repairMembership: true`. It never reassigns or internally retries. A failed explicit attempt, including FLOOD_WAIT/network failure, keeps `repair` and the same bot. Ordinary transient errors do not prove lost membership or justify automatic repair/reassignment.

Close, logout, heartbeat expiry and crash recovery clean ephemeral operations, runtime, leases and temporary authorization; membership remains. Optional token rotation does not change ownership. `DIRECT_TOKEN_ROTATION_ENABLED=false` remains the default; heartbeat defaults remain 60 seconds with five-minute expiry.

`kickAndUnban` belongs to explicit `decommissionVaultMembership`, separate from session cleanup. MASTER retains necessary vault creation/admin and exceptional internal resolver setup duties. 001BeatGaler remains manager-only, outside user vaults and the data plane.

A persisted internal resolver is reused after process restart without constructing MASTER. Initial resolver setup is exceptional infrastructure provisioning. READY tests use a persisted resolver and deliberately unavailable MASTER; they do not claim unconfigured infrastructure can bootstrap without MASTER.

## INDEX and historical authors

The single library index is the pinned `BEATGALER_LIBRARY_INDEX_V1` document in General; no INDEX topic is required. The Desktop helper and Web worker read the pin/message and download/parse JSON directly from Telegram.

The assigned bot's temporary Telegram session creates new messages. Replacement performs read previous → upload new → pin new → verify authoritative pin → attempt previous INDEX deletion. Existing safety checks protect referenced media. Failed pin verification must not delete the previous valid INDEX or its media.

Deletion targets vault/message IDs, without filtering by the previous sender. An INDEX created by another transport bot follows the same path. The current bot needs administrator `pin_messages` and `delete_messages`, which remain in provisioning. Telegram documents deletion of other administrators' messages in [chatAdminRights](https://core.telegram.org/constructor/chatAdminRights); bots may call [channels.deleteMessages](https://core.telegram.org/method/channels.deleteMessages) subject to its permissions/errors. Access is not inferred from an old bot-specific Bot API file ID.

Old INDEX deletion is best effort in both clients. If denied, the verified new pin remains authoritative and the old document may remain, without fallback or reassignment. After failed pin verification, Web attempts to delete its new candidate; Desktop can leave an unpinned candidate. Desktop's `deleted_indexes` reflects attempted cleanup, not a verified delete receipt. These are existing cleanup limits.

For an empty Web vault, `ensureLibraryIndex` acquires the existing `replace_index` operation gate, re-reads inside it and creates only if still absent (`expectedMessageId: 0`). Another installation's winner is preserved. Missing pin is distinct from network failure, corrupt JSON or foreign pin; those errors fail closed. Cloud's legacy `/transport/index/ensure` returns `410 DIRECT_INDEX_REQUIRED` and cannot create/return INDEX bytes.

Cloud receives pointer metadata and a routing snapshot (`beatId → messageId`). Web bootstrap and routing reconciliation never send the full manifest. Existing operation/capability coordination remains in place.

## Media and authorization

Desktop's bundled helper and Web's worker transfer MP3, WAV, artwork and PROJECT through their temporary Telegram client. Playback reads Telegram ranges into client buffers; export/download writes on the user's device. Cloud requests carry authorization/object metadata, not file payloads.

The productive HTTP boundary strips permanent bot token, permanent session, API credential and legacy credential-envelope fields. Temporary authorization is bound to the expected bot identity and existing session/capability controls. Permanent credentials stay server-side; this migration does not redesign capabilities, encryption or rotation.

## Executable evidence and limits

`tests/direct-persistent-data-plane.test.mjs` loads actual Desktop helper and Web worker functions with deterministic Telegram adapters. It covers INDEX get/ensure/upload/replace/pin/verify/delete, previous author from another bot, stale writes, failed verification, exact MP3/WAV/artwork/PROJECT bytes, download/export, playback ranges and warm prefix reads. Unexpected proxy fetch calls fail. These are application call/byte-boundary tests, not live Telegram account/permission tests or latency measurements.

`tests/integration/webPersistentDirectDataPlane.test.ts` checks real bootstrap/routing HTTP bodies. `tests/component-dom/webPersistentIndexBootstrap.test.ts` checks concurrent first creation and preservation of existing data. `cloud-server/tests/atomic-library-index.test.cjs` proves the retired HTTP route cannot invoke a provider/MASTER. The standalone coordinator's existing concurrency/failure tests remain; its production provider wiring has been removed.

Cloud tests cover READY reentry and cleanup with MASTER unavailable, explicit same-bot repair, lazy first access, five active leases and rejected unprepared startup. The dedicated workflow runs Cloud, real PostgreSQL assignment/lazy/live/capability tests, actual Direct implementations, TypeScript unit/component/integration suites, full regression scripts, Web build and browser smoke. Architecture guards also reject unsafe in-memory mutations.

Tasks 8 and 9 passed before cleanup: `1255ae2` ([run 34635141604](https://github.com/magosouljah/BeatGaler/actions/runs/34635141604)) and `151551b` ([run 34637075199](https://github.com/magosouljah/BeatGaler/actions/runs/34637075199)). Cleanup requires the same workflow green on its own exact remote HEAD.

## Diagnostics and cleanup compatibility

Desktop diagnostics: `%LOCALAPPDATA%/BeatGaler/diagnostics/telegram-direct-client.txt`. Control diagnostics: `cloud-server/diagnostics/telegram-direct-control.txt`. Neither should record tokens, API hashes, passwords or authorization secrets.

Cleanup logs use `remaining_leases`. The public compatibility field `active_vaults` counts ephemeral leases, not persistent ownership; deprecated `queue` is empty. Neither controls assignment. The obsolete FIFO module, session-load fallback and unused Cloud INDEX creator were removed after their callers were checked. PostgreSQL rollout remains lazy.
