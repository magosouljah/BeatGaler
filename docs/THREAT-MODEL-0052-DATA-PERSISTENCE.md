# Threat Model 0052 — Data persistence, reconciliation and recovery

**Status:** Architecture review artifact  
**Date:** 2026-08-25  
**Related ADR:** `ADR-0052-DURABLE-DATA-ARCHITECTURE.md`

## Scope

This threat model covers the durable control plane introduced by Task 5.2 and the boundaries between PostgreSQL, Galer Cloud, the pinned Galer T-Library Schema v2 INDEX, Telegram physical objects, Desktop SQLite and Web/local memory.

It does not change the Task 5.1 rule that user media bytes travel directly between the device and Telegram rather than through Galer Cloud.

## Security and integrity goals

1. A crash or process restart must not silently erase authoritative control-plane state.
2. Concurrent Galer Cloud instances must not produce duplicate identities, leases, grants or cleanup work.
3. A stale control-plane pointer must not overwrite a newer pinned INDEX.
4. A logically deleted beat must never reappear because physical cleanup failed.
5. Orphaned physical objects must be discoverable and cleaned conservatively.
6. Database theft alone must not reveal recoverable OAuth/MFA secrets.
7. Backup/restore and rollback must preserve committed control-plane state.
8. Local caches must never become accidental production authority.
9. The direct media data plane must remain direct after the persistence migration.

## Assets

- user/account records;
- password hashes and authentication session hashes;
- OAuth identities and recoverable OAuth tokens;
- MFA/TOTP secrets;
- plan/entitlement grants;
- vault/control metadata;
- Direct leases, admission and operation state;
- audit events and jobs;
- last-observed INDEX revision/message/hash metadata;
- reconciliation state;
- garbage-journal entries;
- encryption key references and key versions;
- backup and migration artifacts.

## Trust boundaries

### Client boundary

Web/Desktop clients may hold temporary auth in RAM. They must not receive permanent transport-bot credentials, API hashes or permanent auth material.

### Galer Cloud boundary

Galer Cloud controls authorization, allocation and durable operational metadata. It must not relay user media bytes.

### PostgreSQL boundary

PostgreSQL is trusted as the durable control-plane store, but database contents alone are not sufficient to decrypt recoverable secrets. The key-encryption/master key is external.

### Telegram/INDEX boundary

The pinned INDEX is the logical library authority. Telegram media messages are physical storage. Neither PostgreSQL nor local caches may silently override pinned INDEX state.

### Local cache boundary

Desktop SQLite and Web/local state are untrusted as global authority. Corrupt/stale cache data may affect UX but must be repairable from authoritative state.

## Threats and mitigations

### T1 — Monolithic JSON corruption or truncation

**Threat:** current JSON authority can be corrupted, partially written or parsed as fallback/empty state, leading to silent loss or overwrite.

**Mitigation:** PostgreSQL becomes authority; legacy importer validates hashes/schema and fails closed. Corrupt source is quarantined and never overwritten during migration.

**Required test:** corrupt JSON import fails without changing the source or committing partial destination state.

### T2 — Two server instances race on the same state

**Threat:** file locks do not protect all control-plane JSON files and do not scale to multiple instances.

**Mitigation:** database transactions, row/advisory locks, uniqueness constraints and idempotency keys.

**Required test:** concurrent registration/allocation/session/garbage operations cannot create duplicate authoritative rows or exceed configured invariants.

### T3 — Partial account-registration saga

**Threat:** account creation, vault provisioning, binding and session creation can succeed only partially.

**Mitigation:** model provisioning as an explicit durable state machine. Database-local changes use a transaction. External Telegram effects are recorded and reconciled through operation state.

**Required test:** inject failure after each external boundary and verify deterministic recovery/resume/compensation.

### T4 — OAuth provider link persists while flow state disappears

**Threat:** restart may lose in-memory OAuth flow state while persisted provider data survives.

**Mitigation:** durable OAuth transaction/state records with expiration and single-use constraints; provider linkage is finalized only by an idempotent terminal transition.

**Required test:** restart at each OAuth transition cannot produce an authenticated account with an unverified or mismatched flow.

### T5 — Recoverable secrets stored in plaintext

**Threat:** database/backup compromise exposes OAuth refresh/access tokens or MFA/TOTP seeds.

**Mitigation:** AES-256-GCM envelope encryption with unique nonce, AAD and key version; KEK/master key external in KMS/Secret Manager; least-privilege access and redacted logs.

**Required tests:** stolen DB without KMS cannot recover secrets; tampered ciphertext/AAD fails authentication; old ciphertext remains decryptable during key rotation.

### T6 — Crash after Telegram upload before INDEX commit

**Threat:** successful physical object creation leaves an orphan when the client crashes or INDEX CAS fails.

**Mitigation:** durable operation/idempotency records and produced-object observations; orphan reconciliation after a safety grace period; garbage journal cleanup.

**Required test:** inject crash after upload and verify orphan reaches a durable journal without changing logical library membership.

### T7 — Crash after INDEX commit before PostgreSQL pointer update

**Threat:** PostgreSQL remembers an older INDEX observation and later code mistakes it for authority.

**Mitigation:** pinned INDEX always wins; pointer is observation/cache metadata only; reconciler reads the current pinned INDEX and updates PostgreSQL forward.

**Required test:** commit INDEX, kill before PG update, restart and reconcile to the pinned INDEX without rewriting it backward.

### T8 — Stale concurrent INDEX writer

**Threat:** two clients could overwrite each other's logical changes.

**Mitigation:** retain current copy-on-write/CAS behavior using expected pinned message/revision identity and reject stale writers.

**Required test:** concurrent stale writer loses cleanly with no lost update.

### T9 — Physical delete fails after logical delete

**Threat:** `MESSAGE_DELETE_FORBIDDEN`, network failure or permissions can leave old media messages physically present.

**Mitigation:** INDEX/tombstone commit occurs first. Cleanup is durable post-commit debt. Failure never rolls back the tombstone or restores the beat.

**Required test:** force delete failure and prove logical deletion remains, journal records debt, retry is safe and beat never reappears.

### T10 — Duplicate garbage workers

**Threat:** multiple workers retry the same cleanup concurrently and produce duplicate/destructive actions.

**Mitigation:** unique idempotency key plus row-level worker lease/locking; cleanup operations themselves must be idempotent where provider semantics allow.

**Required test:** two workers race one row and converge to one final state.

### T11 — Reconciler deletes a valid but temporarily unobserved object

**Threat:** aggressive orphan detection could destroy valid data during delayed INDEX propagation or partial observation.

**Mitigation:** never delete solely because an object is absent from one transient observation. Require authoritative pinned INDEX comparison, durable operation context, safety grace period and explicit cleanup authorization state.

**Required test:** delayed commit/observation does not mark a still-valid object deletable.

### T12 — Missing physical object referenced by INDEX

**Threat:** an INDEX entry points to a Telegram object that no longer exists.

**Mitigation:** classify as data-loss/integrity incident. Do not silently remove the reference or synthesize a replacement. Surface alert/recovery workflow.

**Required test:** missing object produces an integrity alert and no automatic resurrection/deletion rewrite.

### T13 — Backup exists but cannot restore

**Threat:** backups are configured but invalid, incomplete or too slow to meet release recovery targets.

**Mitigation:** encrypted backups + PITR/WAL equivalent; scheduled independent restore drills; validate schema constraints, row counts, selected hashes/invariants and application boot.

**Required test:** isolated restore meets RPO <=15 min and RTO <=2 h with evidence.

### T14 — Rollback after PostgreSQL accepted new writes loses data

**Threat:** reverting to the pre-cutover JSON snapshot discards writes committed after cutover.

**Mitigation:** post-cutover rollback requires write freeze and current PG export/replay into validated legacy-compatible state before old backend activation.

**Required test:** write after cutover, perform rollback drill, verify that committed write still exists.

### T15 — Migration importer duplicates or mutates state

**Threat:** retrying a failed importer creates duplicate users/sessions/providers/grants.

**Mitigation:** deterministic source IDs/mapping, idempotent upserts, transaction boundaries, uniqueness constraints and dry-run verification.

**Required test:** execute importer twice and compare canonical results.

### T16 — Local cache becomes accidental authority

**Threat:** stale Desktop SQLite/Web local state overwrites newer cloud/INDEX state.

**Mitigation:** explicit authority rules in APIs and reconciliation; local data can propose changes only through normal authoritative commit path.

**Required test:** stale local cache cannot overwrite a newer pinned INDEX without passing CAS/authorization.

### T17 — Persistence migration accidentally proxies media through Galer Cloud

**Threat:** implementation convenience moves uploads/downloads through the control plane.

**Mitigation:** retain Task 5.1 direct transport contract; media-byte counters/tests remain a regression gate.

**Required test:** representative upload proves `galer_cloud_file_bytes=0` while the operation succeeds.

### T18 — Audit log leaks secrets

**Threat:** errors, encrypted fields, bearer material or provider responses are written into audit/garbage logs.

**Mitigation:** structured allowlisted audit fields, redaction at source, never log raw auth/session/provider secrets, keep failure payloads bounded.

**Required test:** secret-canary values never appear in logs/audit/journal records.

## Reconciliation rules

1. Pinned INDEX is the library logical authority.
2. PostgreSQL only stores observed INDEX metadata, not a competing beat manifest truth.
3. If PostgreSQL is stale and Telegram has a newer valid pinned INDEX, update PostgreSQL forward.
4. If INDEX references a missing physical object, alert; do not silently rewrite library membership.
5. If a Telegram object is unreferenced, classify it as a candidate orphan first; require safety window and durable cleanup authorization before deletion.
6. Tombstones prevent resurrection even when physical cleanup is impossible.
7. Reconciliation never requires Galer Cloud to transport beat media bytes.

## Release-blocking conditions

Task 5.2 remains incomplete if any of the following is true:

- production authority still relies on mutable JSON for approved durable domains;
- recoverable OAuth/MFA secrets remain plaintext at rest;
- no migration/rollback evidence exists;
- no independent restore evidence exists;
- cleanup debt can disappear on restart;
- reconciliation can override the pinned INDEX;
- adversarial tests for crash/concurrency/idempotency are undefined or failing.
