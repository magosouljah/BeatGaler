# BeatGaler Cloud — Local PostgreSQL Setup Tasks

Audit completed on 2026-09-06 in WSL Ubuntu. Every checked item below was revalidated against the running environment rather than accepted from earlier notes.

## Phase 2 — Node.js in WSL

- [x] Install Node.js 22.23.2 in WSL — verified `v22.23.2`.
- [x] Verify npm works — verified `10.9.8`.
- [x] Install cloud-server dependencies in WSL — `npm ls --depth=0` succeeded with all declared dependencies.

## Phase 3 — PostgreSQL Database

- [x] Create `beatgaler_dev` user — verified as the connection user.
- [x] Give `beatgaler_dev` the `CREATEDB` test permission — required for isolated integration databases.
- [x] Create `beatgaler_cloud_dev` database — recreated cleanly after detecting stale partial-cutover rows; owner verified as `beatgaler_dev`.
- [x] Verify connectivity — PostgreSQL 18.3 accepts connections and the application user connects to the intended database.

## Phase 4 — Configuration

- [x] Generate 32-byte encryption key — development provider resolves the configured key successfully.
- [x] Update `.env` with PostgreSQL and control-plane variables — enabled, SSL disabled locally, authority set to PostgreSQL.

## Phase 5 — Cutover

- [x] Start with PostgreSQL enabled and run migrations — migrations `0001` through `0009` applied on the clean database.
- [x] Execute official cutover (stage + commit) — completed after round-trip validation.
- [x] Capture snapshot SHA256 — `d90fa567d36a9ba9e861e18fb95228daaf9b33ece7eae44970787bb0e8bc034b`.
- [x] Update `.env` with PostgreSQL authority and SHA256 — configured SHA matches the database marker.
- [x] Verify marker — `legacy-json-v1` is `READY`.

## Phase 6 — Startup

- [x] Start server with `authority=postgres`.
- [x] Verify log: `authority=postgres`, `claim-coordinator=postgres`, `direct-capabilities=postgres`.
- [x] Verify `/readyz` — returned ready with `dependencies.postgres=ready`.
- [x] Verify `/healthz` — returned live.

## Phase 7 — Restart and Validation

- [x] Stop and restart server — two clean startup/shutdown cycles completed.
- [x] Verify state persists — before and after: 14 users, 77 auth sessions, 12 vaults, 0 transport bots, and 9 migration ledger rows.
- [x] Verify migrations skip — `applied=[]`; skipped `0001` through `0009` on both audits.
- [x] Run unit tests — `npm run test:unit:cloud` passed.
- [x] Run integration tests:
  - [x] `postgres-cutover.integration.cjs` passed.
  - [x] `postgres-live.integration.cjs` passed.
  - [x] `direct-capability-postgres.integration.cjs` passed.

## Audit corrections

Earlier completion claims were not fully valid at the start of this audit:

- Existing cutover and live integration logs showed `permission denied to create database`.
- Earlier endpoint capture files were empty.
- The live database was missing its `READY` cutover marker, and the SHA in `.env` was stale.
- A failed/partial earlier import left extra PostgreSQL users, causing a round-trip count mismatch.

The local development database was therefore recreated from the declared JSON sources, migrations and official cutover were rerun, `.env` was updated with the new committed SHA, and every Phase 7 validation was rerun successfully.

## Evidence files

- `cloud-server/restart-first.log`
- `cloud-server/restart-second.log`
- `cloud-server/restart-first-readyz.json`
- `cloud-server/restart-first-healthz.json`
- `cloud-server/restart-second-readyz.json`
- `cloud-server/restart-second-healthz.json`
- `cloud-server/restart-audit-before.json`
- `cloud-server/restart-audit-after.json`
- `tests_unit.log`
- `tests_cutover.log`
- `tests_live.log`
- `tests_direct.log`
