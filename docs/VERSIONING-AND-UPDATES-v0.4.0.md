# BeatGaler v0.4.0 — Update + Schema Architecture

Status: architecture decision for v0.4.0. This intentionally defines the contract now without forcing the complete updater UI/release automation into this beta.

## 1. Application updater

Decision: use the official Tauri v2 updater for desktop releases.

Release source:
- GitHub Releases is the release origin.
- A signed updater manifest (`latest.json`) points to signed platform artifacts.
- Beta builds consume a beta channel; stable builds consume a stable channel.
- The desktop app never installs an unsigned update.

v0.4.0 behavior:
- Do not silently install updates.
- Keep updater activation gated until the production signing public key and release endpoint are configured.
- Once enabled: check after startup readiness, never before the library is usable; download in background; ask the user before restart/install.
- Schema compatibility is checked independently of app version. A newer cloud schema must never be downgraded by an older app.

Required before updater activation:
1. Generate and securely store the Tauri updater signing private key outside the repository.
2. Put only the public key in the Tauri updater config.
3. Publish signed updater artifacts + `latest.json` from the release workflow.
4. Add a regression test that rejects invalid signatures.

## 2. Galer T-Library Schema v2

Official name: **Galer T-Library Schema v2**

Internal compatibility identifier (private implementation detail): `beatgaler.telegram.library`

Current schema version: **2**

Rules:
- Every pinned library index must contain `schema` and `version`.
- BeatGaler v0.4.0 reads v1 and v2.
- v1 is migrated in memory to v2 (`trash: []` is added when absent).
- New writes always publish v2.
- Migration is lazy: opening an old library does not rewrite it just because the app started. The normalized v2 document is published on the next real library mutation.
- If the library version is newer than the app supports, the app must stop cloud mutations and require an app update. It must never attempt a downgrade.

Future migrations must be sequential: v2 -> v3 -> v4. Never write one giant "convert any version to latest" migration.

## 3. SQLite schema

Version authority: SQLite `PRAGMA user_version`.

Current SQLite schema version: **1**

Rules:
- Existing pre-versioning databases have `user_version = 0`.
- The existing idempotent CREATE/ALTER bootstrap upgrades that legacy layout; only after it succeeds is `user_version` committed to 1.
- A DB with a schema version newer than the running app is rejected instead of being rewritten.
- Future migrations run in ascending order and each migration must be transaction-safe.

## 4. Migration strategy

There are three independent versions:

1. `APP_VERSION` — release number (`0.4.0`).
2. `GALER_T_LIBRARY_SCHEMA_VERSION` — durable Galer T-Library source-of-truth format (`2`).
3. `SQLITE_SCHEMA_VERSION` — local cache/database format (`1`).

They do **not** need to increase together.

Migration policy:
- Galer T-Library migrations preserve durable user data and are lazy unless a mandatory migration is required.
- SQLite migrations may run automatically at startup because SQLite is local/cache state.
- Before a destructive future migration, create a backup/checkpoint first.
- Migrations must be idempotent where practical and tested from every supported previous version.
- Never infer schema version from the BeatGaler app version.

## v0.4.0 decision summary

- Updater architecture: **Tauri v2 updater + signed GitHub Release artifacts; activation deferred until keys/endpoint are configured.**
- Galer T-Library Schema: **Galer T-Library Schema v2, explicit constant + compatibility validation + v1 -> v2 migration.**
- SQLite schema: **v1 via `PRAGMA user_version`.**
- Migration strategy: **sequential, forward-only, no downgrade; cloud lazy, SQLite startup migration.**
