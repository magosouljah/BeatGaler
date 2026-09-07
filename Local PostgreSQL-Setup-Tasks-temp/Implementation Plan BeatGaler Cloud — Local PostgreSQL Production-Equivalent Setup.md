# Implementation Plan

## BeatGaler Cloud — Local PostgreSQL Production-Equivalent Setup

Bring the local development environment to an architecture that mirrors production: same entrypoint, same control plane backed by real PostgreSQL, same cutover mechanism, same claim coordinator, and same Direct capability persistence.

## Phase 1 — Discovery Summary

### Initial architecture

```text
server.js
  → postgresConfig(env)         → BEATGALER_POSTGRES_ENABLED
  → startPostgresControlPlane() → pool + automatic migrations
  → prepareControlPlaneCutover()→ authority selection
  → server-core.js              → JSON compatibility or PostgreSQL authority
```

The initial local environment used JSON authority, process-local claim coordination, and in-memory Direct capabilities. Production uses PostgreSQL for those three responsibilities.

### Target architecture

Enable PostgreSQL locally using the production application paths, with infrastructure-only differences:

- PostgreSQL in WSL.
- Dedicated local user and database.
- `BEATGALER_POSTGRES_SSL_MODE=disable` for local PostgreSQL.
- Official automatic migration runner.
- Official staged cutover and commit from `accounts-data.json` and `cloud-data.json`.
- Development secret-envelope provider with a generated 32-byte key.
- PostgreSQL authority after validating the committed snapshot SHA256.

## Phase 2 — Node.js in WSL

- Install Node.js 22.23.2 through nvm.
- Verify npm.
- Install `cloud-server` dependencies.

## Phase 3 — PostgreSQL Database

Create a dedicated user and database:

```sql
CREATE USER beatgaler_dev WITH PASSWORD '***';
ALTER ROLE beatgaler_dev CREATEDB;
CREATE DATABASE beatgaler_cloud_dev OWNER beatgaler_dev;
```

`CREATEDB` is required by the repository's PostgreSQL integration tests because they create isolated temporary databases and remove them afterward.

## Phase 4 — Configuration

Configure `cloud-server/.env` with:

```dotenv
BEATGALER_POSTGRES_ENABLED=true
DATABASE_URL=postgresql://beatgaler_dev:***@localhost:5432/beatgaler_cloud_dev
BEATGALER_POSTGRES_SSL_MODE=disable
BEATGALER_CONTROL_PLANE_AUTHORITY=postgres
BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256=<committed snapshot SHA256>
BEATGALER_SECRET_ENVELOPE_PROVIDER=development
BEATGALER_SECRET_ENVELOPE_KEY_B64=<generated 32-byte key in base64>
BEATGALER_SECRET_ENVELOPE_KEY_VERSION=1
```

The `.env` file is ignored by Git. Secrets are intentionally omitted from this document.

## Phase 5 — Cutover

1. Start the PostgreSQL control plane and apply migrations.
2. Read the two legacy JSON sources.
3. Run the official `stagePostgresCutover` path.
4. Validate the PostgreSQL round trip.
5. Run `commitStagedPostgresCutover` and create the `READY` marker.
6. Store the committed snapshot SHA256 in `.env`.
7. Start using PostgreSQL authority.

## Phase 6 — Startup Verification

The startup log must contain:

```text
[control-plane] authority=postgres claim-coordinator=postgres direct-capabilities=postgres
```

The health endpoints must report PostgreSQL ready and the process live:

```json
{"ok":true,"status":"ready","dependencies":{"postgres":"ready"},"environment":"development"}
{"ok":true,"status":"live","environment":"development"}
```

## Phase 7 — Restart and Tests

- Stop and start the server twice.
- Compare authoritative row counts before and after restart.
- Verify the cutover marker remains `READY` and its SHA matches `.env`.
- Verify all existing migrations are skipped with checksum validation.
- Run `npm run test:unit:cloud`.
- Run:

```bash
node --env-file=.env tests/postgres-cutover.integration.cjs
node --env-file=.env tests/postgres-live.integration.cjs
node --env-file=.env tests/direct-capability-postgres.integration.cjs
```

## Production-path components used

- Pool creation: `postgres-runtime-config.js`
- Migrations: `postgres-migrations.js` and `migrations/*.sql`
- Authority: `control-plane-authority.js`
- Cutover: `postgres-cutover-preparation.js`
- JSON compatibility: `control-plane-json-compat.js`
- Claim coordination: `postgres-installation-claim-coordinator.js`
- Direct capabilities: `direct-capability-boundary.js`
- Secret envelope: `secret-envelope-provider.js`
- Durability barrier: `control-plane-json-compat.js`

