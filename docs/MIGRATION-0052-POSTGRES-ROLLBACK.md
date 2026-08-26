# Migration 0052 — JSON to PostgreSQL, backup and rollback

**Status:** Approved migration design; implementation not started  
**Date:** 2026-08-25  
**Related ADR:** `ADR-0052-DURABLE-DATA-ARCHITECTURE.md`

## Goal

Move approved durable Galer Cloud/control-plane state from mutable JSON/process memory into PostgreSQL without changing the pinned Galer T-Library Schema v2 INDEX authority or the direct device-to-Telegram media data plane.

The migration must be repeatable, auditable, reversible and fail closed.

## Scope

Initial migration covers, as applicable to current stored state:

- accounts/users;
- password-hash metadata;
- auth sessions;
- OAuth/provider identities and encrypted recoverable provider tokens;
- MFA factors/secrets encrypted at rest;
- plan/entitlement state;
- vault/control metadata;
- Direct lease/operation/allocator state that must survive restart;
- jobs that require durability;
- audit/reconciliation metadata;
- garbage-journal state.

The beat manifest itself is not migrated into PostgreSQL as authority. The pinned INDEX remains authoritative for logical library state.

## Preconditions

Before production cutover:

1. PostgreSQL schema and constraints reviewed.
2. Versioned migrations pass from empty database to target schema.
3. Legacy JSON source files are snapshotted read-only and hashed with SHA-256.
4. Importer supports `--dry-run` or equivalent non-mutating validation mode.
5. Importer is deterministic and idempotent.
6. Encryption/KMS path is operational for all recoverable secrets.
7. Backup/PITR is configured and an isolated restore has been proven.
8. Compatibility export/rollback mechanism is tested.
9. Required crash/concurrency/reconciliation adversarial tests are passing.
10. No user-media route is added to Galer Cloud.

## Migration phases

### Phase A — Inventory and immutable snapshot

- enumerate every legacy authoritative JSON file and in-memory domain being replaced;
- record source path, expected schema/version, byte size and SHA-256;
- create encrypted immutable backup copies before transformation;
- do not rewrite or normalize source files in place.

If a source file cannot be parsed or violates expected invariants, stop. Do not substitute an empty/default state.

### Phase B — PostgreSQL schema

Create versioned schema migrations with explicit constraints.

Minimum rules:

- stable primary keys;
- foreign keys for ownership/relationships;
- unique constraints for provider identities, idempotency keys and other natural uniqueness;
- `NOT NULL` for required state;
- `CHECK` constraints for bounded enums/counters/status transitions where practical;
- timestamps generated consistently;
- encrypted-secret columns separated from plaintext metadata and carrying key version/nonce/tag metadata as required;
- migration ledger plus serialized migration execution.

Destructive schema changes use expand/contract rather than one-step destructive deploys.

### Phase C — Dry-run importer

The dry run must:

- parse all source files without mutation;
- validate required fields and references;
- detect duplicates/conflicts;
- classify invalid rows into a quarantine/error report;
- compute intended destination counts;
- verify that secrets can be transformed into encrypted representation without logging plaintext;
- produce no authoritative PostgreSQL writes.

Dry-run output must contain counts and redacted errors, never secrets.

### Phase D — Idempotent shadow import

Import into PostgreSQL while JSON remains production authority.

Rules:

- deterministic mapping from source records to destination IDs;
- idempotent upsert behavior;
- each domain imported in bounded transactions;
- uniqueness/constraint failures stop the domain import rather than being ignored;
- importer may be run repeatedly and must converge to the same canonical state.

This phase is verification, not indefinite dual-write architecture.

### Phase E — Verification

Before cutover compare:

- source record counts vs destination canonical counts;
- user/provider/session/grant ownership invariants;
- sampled hashes or deterministic normalized representations where safe;
- no plaintext recoverable secrets in PostgreSQL/logs;
- migration ledger version;
- database constraints active;
- application read-only smoke against imported data;
- current pinned INDEX observations remain observations only and do not replace Telegram authority.

Any unresolved mismatch blocks cutover.

### Phase F — Short write freeze and final delta

At cutover:

1. enter an explicit maintenance/write-freeze state for affected control-plane writes;
2. take a final legacy snapshot and SHA-256;
3. import/reconcile the final delta;
4. rerun invariant/count checks;
5. verify backup/PITR position;
6. switch Galer Cloud reads/writes for approved domains to PostgreSQL;
7. keep legacy JSON snapshot immutable.

The freeze should be short and observable. Do not silently accept writes into both authorities indefinitely.

### Phase G — PostgreSQL authority

After unfreeze:

- PostgreSQL is authoritative for approved control-plane domains;
- production code no longer mutates legacy authoritative JSON;
- compatibility JSON, if generated, is output-only and never read as authority;
- audit/garbage/reconciliation workers use PostgreSQL durability and idempotency;
- pinned INDEX authority remains unchanged.

## Secret migration

### Passwords

Do not decrypt or rehash solely for migration if the current hash is valid. Store algorithm/version parameters explicitly so future rehash-on-login is possible.

### Bearer sessions

Migrate only hashed session identifiers/keys and session metadata. Never create plaintext token copies.

### OAuth and MFA

Before writing destination rows:

1. decrypt/read from legacy source only inside the migration process;
2. encrypt using the approved AEAD envelope;
3. write ciphertext + nonce/tag/key version/AAD metadata;
4. erase temporary plaintext buffers where practical;
5. never emit plaintext into logs/reports.

### Permanent infrastructure credentials

Prefer migration to external secret-manager entries/references. Do not place permanent bot/master/API credentials into ordinary PostgreSQL plaintext columns.

## Reconciliation cutover

The migration must not invent a PostgreSQL beat-library truth.

At startup after cutover:

1. read current pinned INDEX through the existing direct/authorized path;
2. compare with the last-observed PostgreSQL pointer/hash/revision;
3. if PostgreSQL is stale, move observation forward;
4. if physical objects are missing, raise integrity debt;
5. if unreferenced physical objects are known, classify as orphan candidates and use the garbage journal after a safety period;
6. never rewrite the pinned INDEX backward based solely on PostgreSQL metadata.

## Garbage-journal migration/initialization

Legacy cleanup failures may not have durable records. The first implementation must therefore start with an empty durable journal plus conservative reconciliation discovery.

Discovery rules:

- never assume an unreferenced object is safe to delete from a single observation;
- require pinned INDEX comparison and a safety grace period;
- record cleanup authorization in the journal before deletion;
- use an idempotency key so repeated discovery does not create duplicate cleanup work;
- `MESSAGE_DELETE_FORBIDDEN` moves the journal item to a durable blocked/retry/terminal-observed state according to policy, without altering tombstones.

## Backup design

Approved initial targets:

- **RPO <= 15 minutes**;
- **RTO <= 2 hours**.

Implementation requirements:

- encrypted PostgreSQL backups;
- WAL/PITR or equivalent continuous recovery mechanism capable of the RPO;
- backup encryption keys separate from backup payloads;
- retention policy defined before production;
- restore credentials and runbook access limited to operations owners;
- periodic independent restore into an isolated environment.

## Restore validation

A restore is not considered proven until the isolated environment verifies:

- schema migration version;
- database constraints;
- canonical row counts by critical domain;
- selected invariant/hash checks;
- ability to decrypt approved secrets using the production recovery process without exposing them to logs;
- Galer Cloud can boot against the restored database;
- pinned INDEX reconciliation moves observation forward without mutating library truth;
- garbage jobs remain idempotent;
- measured recovery falls within the approved RPO/RTO.

## Rollback plan

### Rollback A — Before PostgreSQL cutover/unfreeze

Safe rollback path:

1. abort migration;
2. discard incomplete destination database/schema if necessary;
3. verify original immutable JSON snapshot hashes;
4. restart existing backend against the unchanged legacy source;
5. investigate before retrying.

Because PostgreSQL has not yet accepted authoritative new writes, the preserved source remains current.

### Rollback B — After PostgreSQL accepted authoritative writes

The old pre-cutover JSON snapshot is no longer current and **must not** be restored directly.

Required sequence:

1. freeze affected writes;
2. take a fresh PostgreSQL backup/checkpoint;
3. export current PostgreSQL authoritative state through a tested legacy-compatible exporter or replay process;
4. validate counts/invariants against PostgreSQL;
5. write new compatibility JSON atomically to a separate path;
6. run old-backend read-only smoke against that compatibility state;
7. only then switch old backend to that newly generated state;
8. retain the PostgreSQL backup for forward recovery.

Any rollback that would discard committed post-cutover writes is prohibited.

## Required migration/adversarial test matrix

| Test | Expected result |
|---|---|
| Corrupt/truncated JSON | Fail closed; source untouched; no partial authoritative cutover |
| Import same snapshot twice | Same canonical destination; no duplicates |
| Duplicate provider/user identity | Constraint/import error surfaced deterministically |
| Concurrent server writes | Transactions/constraints preserve invariants |
| Crash mid-registration saga | Durable state resumes/compensates deterministically |
| Crash after upload before INDEX | Orphan candidate becomes durable cleanup debt |
| Crash after INDEX before PG observation | Reconciler updates PG to pinned INDEX |
| Stale INDEX CAS | Stale writer rejected; no lost update |
| `MESSAGE_DELETE_FORBIDDEN` | Tombstone remains; journal persists debt; no resurrection |
| Two GC workers | One idempotent logical cleanup outcome |
| DB/backup stolen without KMS | OAuth/MFA plaintext unavailable |
| Secret key rotation | Old ciphertext readable; new writes use new key version |
| Independent restore | RPO <=15 min and RTO <=2 h with invariants passing |
| Post-cutover rollback | New committed writes retained in generated legacy state |
| Data-plane regression | Upload succeeds with `galer_cloud_file_bytes=0` |

## Evidence required to close Task 5.2

The documentation in this file is architecture/migration approval evidence, not implementation proof. Task 5.2 should remain in progress until the plan's exit gate is met and the required implementation-sensitive work begins only after these architecture and adversarial-test definitions are reviewed.

Future evidence should include:

- reviewed ADR/threat model/migration plan;
- migration schema/constraints and importer tests;
- rollback drill evidence;
- independent backup restore evidence;
- reconciliation/garbage-journal adversarial tests;
- normal Required CI on the integrated implementation;
- confirmation that Task 5.1 direct data-plane invariants remain intact.
