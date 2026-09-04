# Task 5.2 — Productive control-plane cutover runbook

Status: **NOT APPROVED FOR PRODUCTION YET**.

This runbook defines the required software/operational sequence for moving BeatGaler control-plane authority from legacy JSON to PostgreSQL. It does **not** prove or provide production infrastructure by itself.

## Invariants

- The pinned Galer T-Library Schema v2 INDEX remains the sole logical authority for beats, trash, deleted items and tombstones.
- PostgreSQL is control-plane authority only.
- MP3/WAV/artwork/samples/PROJECT ZIP remain device ↔ Telegram direct; Galer Cloud must preserve `galer_cloud_file_bytes=0`.
- There is no indefinite dual-write period.
- A PostgreSQL process may become authority only after a `READY` marker exists for the exact final source snapshot.
- Invalid legacy source is quarantined; rows are never silently skipped.
- Cleanup/garbage failure never rolls INDEX back or resurrects tombstones.
- Recoverable OAuth/MFA secrets must remain ciphertext in PostgreSQL/backups; the KEK/master material is external and versioned.

## Infrastructure gates required before a real cutover

A production cutover is forbidden until all of these are independently evidenced:

1. Production PostgreSQL provider is provisioned and access-controlled.
2. Real KMS/Secret Manager owns the KEK/master material outside PostgreSQL.
3. Encrypted backups are configured.
4. WAL/PITR or equivalent point-in-time recovery is configured with documented retention.
5. An isolated restore from the production backup path succeeds.
6. The measured recovery drill demonstrates RPO <= 15 minutes and RTO <= 2 hours at representative scale.
7. Monitoring, alerts, on-call ownership and rollback authority are assigned.
8. The productive KMS path proves both decrypt-by-version and a rehearsed key rotation without exposing key material to PostgreSQL or backup storage.

The CI development envelope key and CI dump/restore drill are not substitutes for these gates.

## Phase A — Preflight and immutable source evidence

1. Keep current authority on JSON.
2. Verify migrations and schema on the target PostgreSQL database.
3. Capture the current raw `accounts-data.json` and `cloud-data.json` into a new exclusive snapshot bundle directory.
4. The bundle must contain the exact raw source files, `manifest.json`, and `SEALED`.
5. Copy the sealed bundle to operator-controlled immutable/external storage and record its bundle SHA256 outside the application database.
6. Re-verify the bundle from that external copy before staging.
7. If bundle creation writes `QUARANTINED.json`, stop. Investigate and repair the source explicitly. Do not drop the invalid row and do not continue to staging.

## Phase B — Bulk stage while JSON remains authoritative

1. Run `stagePostgresCutover` with the verified raw files and recorded external bundle SHA256.
2. The stage imports and round-trip-validates PostgreSQL, then records `control_plane_cutover_stages`.
3. Confirm there is **no** `READY` row in `control_plane_cutovers`.
4. Confirm an attempted PostgreSQL authority startup still fails closed because `READY` is missing.
5. Continue normal JSON-authority operation until the scheduled final cutover window.

## Phase C — Short write freeze and final delta

This phase requires an externally enforced maintenance/write freeze. The staging library does not invent or silently enforce application-wide maintenance mode.

1. Announce and enter the approved maintenance window.
2. Stop all control-plane mutations using the deployment/edge maintenance mechanism approved for production.
3. Wait for in-flight control-plane writes to drain.
4. Re-read the exact raw legacy JSON files after the drain.
5. Create a **new** sealed final snapshot bundle; never overwrite the earlier bundle.
6. Copy/verify the final bundle in immutable external storage and record its bundle SHA256.
7. Restage PostgreSQL from the final raw files using that final bundle digest.
8. Verify the staged snapshot SHA256 matches the final bundle snapshot SHA256.
9. Keep writes frozen through the authority commit.

If the source changes after staging, `commitStagedPostgresCutover` must refuse the commit. Repeat the final snapshot + restage process; never override the mismatch.

## Phase D — Atomic authority readiness and switch

1. Call `commitStagedPostgresCutover` with:
   - exact staged/final snapshot SHA256;
   - exact final external bundle SHA256;
   - the current raw JSON source files.
2. The commit may create `READY` only if all exact hashes/plans still match.
3. After `READY`, configure the deployment for:
   - `BEATGALER_POSTGRES_ENABLED=true`;
   - `BEATGALER_CONTROL_PLANE_AUTHORITY=postgres`;
   - exact `BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256`.
4. Deploy/restart the control-plane service.
5. Verify startup accepted the exact READY marker.
6. Keep maintenance enabled while smoke checks verify auth, provider/MFA readback, entitlements, vault metadata, Direct control-plane state and reconciliation/garbage worker health.
7. Remove maintenance only after the Release Owner/Operator accepts those checks.

## Phase E — Observe

During the defined observation window:

- monitor PostgreSQL durability errors and process poison/fail-closed events;
- monitor Direct lease/operation persistence;
- monitor reconciliation and garbage debt/retries;
- verify INDEX remains logical library authority;
- verify file bytes still bypass Galer Cloud;
- verify backup/PITR health and replication/provider alerts.

## Secret-key rotation procedure

A key rotation is a maintenance operation. Do not rotate while uncontrolled control-plane writes are occurring.

1. Enter maintenance/write freeze and drain in-flight writes.
2. Confirm the productive KMS/Secret Manager can resolve the **current** key version and has created a distinct **new** active key version.
3. Record only KMS key identifiers/versions; never export raw key material into PostgreSQL, logs, artifacts or snapshot bundles.
4. Run `rotateStoredControlPlaneSecrets` with a source keyring capable of decrypting every currently stored `secret_key_version` and a target keyring whose active version is the new version.
5. The rotation must run transactionally. Any unavailable/wrong old key, malformed ciphertext or unsupported MFA factor aborts and rolls back the entire rotation.
6. Verify every encrypted `provider_identities` and `mfa_factors` row now carries the new `secret_key_version` and that OAuth/MFA round-trip succeeds through the productive KMS path.
7. Restart/smoke the service using the new active key version while the previous version remains recoverable in KMS for the approved rollback window.
8. Retire/disable the old KMS version only after smoke, backup and rollback-window requirements are satisfied.

CI proves the transaction, wrong/missing-key rejection and v7→v8 re-encryption on an isolated restored PostgreSQL database. It does **not** prove the real provider's KMS IAM, key lifecycle or deletion/retirement controls.

## Rollback after PostgreSQL writes exist

Never point authority back at the pre-cutover JSON snapshot.

1. Enter maintenance/write freeze again and drain mutations.
2. Use `exportCurrentPostgresForRollback` to export the **current** PostgreSQL state to legacy-compatible JSON.
3. Validate the export and preserve it as a new immutable/external rollback bundle.
4. Record its exact snapshot SHA256.
5. Call `commitPostgresRollback` with the original cutover snapshot SHA and the exact rollback export SHA.
6. Materialize exactly those exported JSON files in the legacy location.
7. Configure JSON authority with `BEATGALER_JSON_ROLLBACK_EXPORT_SHA256` equal to the committed digest.
8. Startup must call `assertJsonRollbackSnapshot`; any mismatch is a hard stop.
9. Smoke test under maintenance, then reopen only after approval.

## Quarantine policy

- Quarantine means **stop**, not “continue with good rows”.
- Preserve the exact raw source files that failed validation.
- The quarantine record may contain a bounded validation reason but must not dump OAuth/MFA secrets into logs.
- Repair happens in the authoritative legacy source with an auditable change; then create a fresh bundle and restart the sequence.

## Evidence to retain for the production gate

- immutable initial and final bundle locations + SHA256 digests;
- cutover stage and READY timestamps;
- operator/release-owner approvals and maintenance timestamps;
- migration ledger/checksums;
- KMS key identifiers/versions without key material;
- key-rotation evidence showing all encrypted rows moved to the intended version;
- backup/PITR configuration evidence;
- isolated restore evidence and measured RPO/RTO;
- smoke/monitoring evidence;
- rollback export digest if rollback was exercised.

## What the repository/CI can prove today

The repository can prove exact snapshot hashing, quarantine behavior, stage-before-READY, final-delta mismatch rejection, exact READY commit, post-cutover durable writes, current-state rollback export, exact rollback digest enforcement, PostgreSQL migrations/constraints, encrypted secret round-trip in the CI development-key model, ciphertext-only database storage, wrong/missing-key rejection, transactional secret-key rotation on an isolated restore, and isolated CI dump/restore.

It **cannot** prove a real production PostgreSQL provider, production KMS/Secret Manager/IAM, production immutable storage, WAL/PITR retention, representative RPO/RTO, productive key lifecycle controls, or a real maintenance-window cutover until those external systems are provisioned and exercised.
