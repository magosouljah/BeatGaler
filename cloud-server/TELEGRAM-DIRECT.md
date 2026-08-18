# BeatGaler Direct V5 — Local Bot API data plane

## Test-mode rules

- Token revoke/rotation is disabled (`DIRECT_TOKEN_ROTATION_ENABLED=false`).
- Heartbeat remains 60 seconds; stale session cleanup remains 5 minutes.
- 001BeatGaler is manager-only and never enters user vaults.
- MASTER creates/administers vault membership/topics only. It does not upload beat bytes or normal INDEX bytes.
- Transport bot media and INDEX bytes travel Desktop -> local `telegram-bot-api` -> Telegram.
- The client helper no longer authenticates bots with GramJS / `auth.ImportBotAuthorization`.

## INDEX

No `INDEX` topic is necessary. The single library index is the pinned `BEATGALER_LIBRARY_INDEX_V1` document in General. Bot API `getChat` exposes the pinned message, so the assigned transport bot can load the index without scanning history.

If no pinned BeatGaler index exists, the transport bot creates one empty index exactly once and pins it. Every rewrite is: upload new -> pin new -> delete old.

The control plane stores only the current `message_id`/`file_id` pointer as recovery/diagnostic metadata. It never receives the JSON index bytes.

## Historical media with a different transport bot

Bot API file IDs are bot-specific. To let any pool bot access media uploaded by another bot, MASTER provisions one private internal `BeatGaler Transport Resolver` group containing only MASTER + transport bots. For a historical message ID, the active transport bot forwards the Telegram message server-side to this resolver, obtains a file ID valid for itself, immediately deletes the temporary resolver message, then downloads locally. Nothing is posted in the user's vault and media bytes do not transit BeatGaler Cloud.

## Token exposure

The token is never sent to React, localStorage, SQLite, logs, or diagnostic files. It moves over the authenticated control-plane connection into Rust and then through the helper's stdin, and is kept only in process memory. Diagnostics redact token/secret fields.

Cryptography can protect the token in transit and at rest, but cannot make a bot token truly invisible to the owner/admin of the PC that must use it. A locally controlled machine can inspect its own process memory/loopback traffic. True cryptographic vault-only capability would require Telegram to issue a vault-scoped credential (it currently does not), or a trusted remote proxy—which would conflict with the goal that beat bytes never pass through BeatGaler servers.

## Diagnostics

Desktop/client:
`%LOCALAPPDATA%\\BeatGaler\\diagnostics\\telegram-direct-client.txt`

Control plane:
`cloud-server/diagnostics/telegram-direct-control.txt`

Neither file records bot tokens, API hashes, passwords, or secrets.
