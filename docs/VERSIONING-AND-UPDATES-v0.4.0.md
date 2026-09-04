# BeatGaler v0.4.0 — Update + Schema Architecture

Status: architecture decision for v0.4.0. This intentionally defines the contract now without forcing the complete updater UI/release automation into this beta.

## 1. Application updater

Decision: use the official Tauri v2 updater for desktop releases.

Release source:
- GitHub Releases is the release origin.
- A signed updater manifest (`latest.json`) points to signed platform artifacts.
- Stable desktop builds consume `https://github.com/magosouljah/galer/releases/latest/download/latest.json`.
- GitHub `latest` is a **stable-only** pointer. Tags with `-alpha.*`, `-beta.*`, or `-rc.*` are prereleases and must never become GitHub `latest`.
- Release-channel intent is derived from the tag and must match the requested policy channel: `alpha` -> alpha, `beta` -> beta, `rc` -> candidate, no prerelease suffix -> stable.
- Prerelease releases may contain their own tag-scoped `latest.json` asset for artifact parity, but the existing Tauri updater does not follow those tag URLs. A future opt-in prerelease updater channel requires a separately compiled/configured endpoint; that is outside F0/0.4.
- The desktop app never installs an unsigned update.

Immutable release publication:
1. Verify Windows and macOS selected build runs are successful and have the same source SHA.
2. Prepare every release asset, updater manifest, checksum, release note, SBOM, and `provenance.json` before publication.
3. Create the public release as a Draft in `magosouljah/galer`, targeting a real commit in that repository. The `magosouljah/BeatGaler` source SHA is metadata/provenance, never a cross-repository tag target.
4. Upload all assets to the Draft without `--clobber`, then verify the complete asset set.
5. Publish once. Prereleases publish with `make_latest=false`; only stable tags publish with `make_latest=true`.
6. After publication, perform read-only verification only. Immutable assets/tags are never replaced in place; use a new version/tag for corrections.

Release provenance:
- `provenance.json` records the source repository/SHA, public release repository/tag/version/channel, Windows and macOS build run IDs, and publication workflow/run metadata.
- The release notes repeat the source SHA and run IDs in human-readable form.
- Runtime provenance from both platform artifacts must match the exact selected source SHA before a release can be assembled.
- An existing release or tag with the requested name is treated as a conflict and publication fails closed rather than silently mutating it.

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

- Updater architecture: **Tauri v2 updater + signed GitHub Release artifacts; stable remains `releases/latest/download/latest.json`, while prereleases are explicitly excluded from GitHub `latest`.**
- Release publication: **Draft -> upload/verify all assets -> single publication; immutable releases are never clobbered or mutated after publication.**
- Release provenance: **source SHA + Windows/macOS run IDs + publication run metadata in release notes and `provenance.json`.**
- Galer T-Library Schema: **Galer T-Library Schema v2, explicit constant + compatibility validation + v1 -> v2 migration.**
- SQLite schema: **v1 via `PRAGMA user_version`.**
- Migration strategy: **sequential, forward-only, no downgrade; cloud lazy, SQLite startup migration.**
