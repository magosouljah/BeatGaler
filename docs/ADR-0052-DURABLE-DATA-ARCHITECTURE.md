# ADR-0052 — Durable data architecture

**Status:** Approved for architecture; implementation not started  
**Date:** 2026-08-25  
**Task:** Fase 0 / Tarea 5.2  
**Release state:** NO-GO

## Context

Task 5.2 requires a production-grade durable persistence model with migrations, constraints, backup/restore, rollback, secret protection, Telegram/INDEX reconciliation, and a durable garbage journal.

The current codebase uses multiple persistence mechanisms with different authority levels:

- Galer Cloud control-plane data is largely persisted in JSON files.
- Some jobs and runtime coordination are memory-only.
- Desktop SQLite is a local cache/materialized/offline store, not the production control-plane authority.
- Telegram media messages are the physical object store for beat assets.
- The pinned Galer T-Library Schema v2 INDEX is the logical source of truth for library membership, Trash and tombstones.

Task 5.1 already fixed an immutable trust boundary: MP3/WAV/artwork/samples/PROJECT ZIP bytes travel directly between the device and Telegram. Galer Cloud authorizes and coordinates but must never become a relay for those bytes.

## Decision

### 1. PostgreSQL becomes the durable control-plane authority

Production control-plane state will use PostgreSQL rather than JSON or process memory as its authoritative mutable store.

Initial durable domains:

- accounts/users;
- auth sessions;
- OAuth/provider identities and provider token metadata;
- MFA factors;
- entitlements/grants;
- jobs;
- durable audit events;
- vault metadata;
- transport-bot metadata that is safe to persist as metadata;
- Direct leases, operations, allocator/admission state and waitlist state that must survive restart;
- last-observed INDEX pointer/revision/hash metadata;
- reconciliation state;
- garbage journal.

Production JSON files may exist only as migration inputs, diagnostics, examples or compatibility exports. They are not production authority after cutover.

### 2. The pinned INDEX remains the sole logical library authority

PostgreSQL does **not** become the source of truth for the beat library itself.

Authority is intentionally split:

- **Pinned Galer T-Library Schema v2 INDEX:** logical authority for `beats`, `trash`, `deleted` and asset references.
- **Telegram media messages:** physical object storage.
- **PostgreSQL:** durable control-plane authority, operational metadata, reconciliation and cleanup debt.
- **Desktop SQLite / Web local state:** cache, offline state or preferences only.

If PostgreSQL and the pinned INDEX disagree about library state, the pinned INDEX wins. PostgreSQL must reconcile to it rather than silently overwriting it.

A `deleted` tombstone wins over the continued physical existence of a Telegram message. Cleanup failure must never resurrect a logically deleted asset.

### 3. External Telegram effects use saga/outbox/reconciliation semantics

Telegram cannot participate in a PostgreSQL ACID transaction. Cross-system operations therefore use explicit staged state and idempotency instead of pretending one transaction spans both systems.

The intended pattern is:

1. create/lock a durable operation with an idempotency key;
2. perform the direct Telegram operation from the client/authorized component;
3. durably record produced object identifiers/observations where possible;
4. commit the logical INDEX change with existing compare-and-swap/copy-on-write protections;
5. mark the operation committed in PostgreSQL and enqueue any post-commit cleanup debt;
6. retry cleanup from a durable worker;
7. reconcile after crashes or partial failures.

Logical INDEX commit boundaries are never rolled back merely because physical cleanup later fails.

### 4. Durable garbage journal

A production garbage journal is required for cleanup that cannot be guaranteed synchronously.

Minimum conceptual fields:

- journal id;
- vault id;
- operation id;
- idempotency key;
- object kind (`media`, `old_index`, `topic`, etc.);
- Telegram object/message/topic identifier;
- optional beat id;
- reason (`orphan_upload`, `replace_asset`, `permanent_delete`, `old_index`, etc.);
- state (`pending`, `retrying`, `blocked`, `done`);
- attempt count;
- next attempt time;
- redacted last error code/message;
- INDEX commit identifier/revision/hash that authorizes cleanup;
- created/updated/completed timestamps;
- worker lease/lock metadata where required.

A unique constraint must make cleanup idempotent. Concurrent workers must use database locking semantics appropriate for queue work, such as row locks with skip-locked behavior.

`MESSAGE_DELETE_FORBIDDEN` or equivalent cleanup failures do not revert INDEX state. The journal records the unresolved physical debt and the tombstone remains authoritative.

### 5. Orphan-upload handling

Uploads occur before the final INDEX commit, so a successful physical upload followed by crash/CAS failure can leave unreferenced Telegram objects.

The durable operation/journal model must retain produced Telegram message/object identifiers where possible. If no matching INDEX commit exists after a safety grace period, those objects become orphan candidates and enter the garbage journal.

Periodic reconciliation must detect missed gaps without transporting media bytes through Galer Cloud.

### 6. Secret protection

Secret classes are handled differently:

- Passwords remain irreversibly hashed; hash algorithm/version must be stored explicitly.
- Bearer session tokens remain stored only as one-way hashes, never plaintext.
- OAuth access/refresh tokens and MFA/TOTP secrets must use authenticated envelope encryption at rest.
- Recommended data encryption: AES-256-GCM with unique nonce, authenticated metadata/AAD and key versioning.
- The key-encryption/master key must live outside PostgreSQL in a production KMS/Secret Manager or equivalent secret store.
- Permanent transport-bot/master/API credentials should be represented by secret-manager references rather than plaintext database fields whenever practical.
- Temporary auth remains client-memory-only and is not persisted.

Stealing a PostgreSQL backup alone must not be sufficient to recover OAuth/MFA secrets.

### 7. Migrations and constraints

PostgreSQL schema changes use versioned migrations committed to the repository and an authoritative migration ledger.

Production requirements:

- primary keys, foreign keys, unique constraints, `NOT NULL` and `CHECK` constraints where applicable;
- migration serialization/advisory locking;
- expand/contract migrations for destructive changes;
- no silent destructive startup migration;
- explicit dry-run and rollback evidence for the JSON-to-PostgreSQL cutover.

### 8. Backup and recovery target

Architecture target approved for initial production planning:

- **RPO: <= 15 minutes** for durable PostgreSQL control-plane data.
- **RTO: <= 2 hours** for restoring an operational control-plane after a qualifying failure.

Implementation should use encrypted backups plus WAL/PITR or an equivalent mechanism capable of meeting the RPO. The release gate is satisfied only after an independent restore has actually been demonstrated and validated; provider promises alone are insufficient.

These targets can be tightened later if business/legal requirements demand it.

### 9. Rollback boundary

Rollback has two materially different phases:

- **Before final cutover/unfreeze:** restore/use the preserved validated JSON snapshot.
- **After PostgreSQL has accepted new authoritative writes:** never switch blindly to the old JSON snapshot. Writes must be stopped and current PostgreSQL state must be exported/replayed into a validated legacy-compatible form before reverting the old backend.

An idempotent compatibility exporter or equivalent verified rollback mechanism is therefore part of the migration gate.

### 10. Existing Task 5.1 decisions remain unchanged

This ADR does not reopen:

- device <-> Telegram media data plane;
- temporary-auth trust boundary;
- shared-bot fallback policy;
- fair allocation;
- maximum 4 active vaults per bot;
- bounded waitlist;
- accepted cross-vault residual risk of shared fallback;
- no per-operation permission churn;
- token rotation/revoke behavior;
- INDEX-first logical delete semantics.

## Consequences

### Positive

- control-plane writes gain transactional durability and database constraints;
- multi-process/horizontal operation becomes possible without monolithic JSON corruption races;
- crashes and partial Telegram operations become observable/recoverable;
- cleanup debt becomes durable instead of disappearing in `.catch(() => {})` paths;
- backup/restore and migration gates can be tested explicitly;
- secret-at-rest exposure is reduced.

### Costs / tradeoffs

- PostgreSQL and secret-management infrastructure become production dependencies;
- Telegram effects still require sagas/reconciliation and cannot be made globally ACID;
- operational complexity increases because migrations, PITR, restore drills and garbage workers must be maintained;
- reconciliation must be designed conservatively so it never competes with the pinned INDEX authority.

## Required adversarial tests before sensitive implementation is considered complete

1. Corrupt legacy JSON causes migration to fail closed without overwriting the source.
2. Running the importer twice yields the same final state and no duplicates.
3. Two server instances cannot corrupt or over-allocate state under concurrency.
4. Crash after Telegram upload but before INDEX commit produces recoverable orphan debt.
5. Crash after INDEX pin but before PostgreSQL pointer update is repaired by reconciliation.
6. `MESSAGE_DELETE_FORBIDDEN` leaves the tombstone authoritative and records durable cleanup debt without resurrection.
7. Two garbage workers racing the same item still produce one idempotent outcome.
8. Stale INDEX/CAS writers cannot cause lost updates.
9. Independent backup restore meets the approved RPO/RTO and passes invariant checks.
10. Rollback after PostgreSQL has accepted new writes loses no committed control-plane data.
11. A stolen database/backup without the KMS key cannot recover encrypted OAuth/MFA secrets.
12. Key-version rotation can decrypt old ciphertext and write new ciphertext safely.
13. Task 5.1 regression: Galer Cloud transports zero user media bytes; direct device-to-Telegram data plane remains intact.

## Implementation gate

Architecture is approved, but Task 5.2 is **not complete**. No sensitive persistence cutover is approved until the threat model, migration/rollback plan and adversarial tests are reviewed, implemented where applicable, and evidenced through the normal PR/CI/release gates.
