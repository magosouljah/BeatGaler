# Task 5.2 — AWS production contract

**Status:** preparation only; does not constitute productive evidence  
**Task:** Fase 0 / Tarea 5.2  
**Release state:** NO-GO

This document fixes the exact AWS-facing contract for the BeatGaler control-plane so production provisioning can be verified without inventing configuration during cutover.

## 1. Required AWS resources

Minimum productive resources:

1. PostgreSQL on Amazon RDS (or an explicitly approved equivalent) with encryption at rest, automated backups, retention and point-in-time recovery enabled.
2. One customer-managed AWS KMS key for the control-plane envelope-key secret.
3. One AWS Secrets Manager secret containing the versioned BeatGaler envelope keyring.
4. One workload identity/role for Galer Cloud with least privilege to read only that secret and decrypt it through only the approved KMS key.

The application must not receive AWS root credentials or broad administrator credentials.

## 2. Secrets Manager payload

Secret ID is supplied to the runtime through the non-secret configuration variable:

`BEATGALER_AWS_SECRET_ENVELOPE_ID`

The secret value itself is JSON with this exact schema identifier:

```json
{
  "schema": "beatgaler-envelope-keyring-v1",
  "activeKeyVersion": 8,
  "keys": {
    "7": "<32 random bytes encoded as base64>",
    "8": "<32 random bytes encoded as base64>"
  }
}
```

Rules:

- every decoded key is exactly 32 bytes;
- `activeKeyVersion` must exist in `keys`;
- old versions remain present only while ciphertext using them still exists or while a validated rollback/rotation window requires them;
- new writes use only the active version;
- old ciphertext may be read through retained versions;
- production never accepts `BEATGALER_SECRET_ENVELOPE_KEY_B64`;
- secret values must never be committed, pasted into logs, PR bodies, chat, screenshots or release artifacts.

## 3. Runtime configuration

Non-secret configuration for the productive Galer Cloud process:

```text
NODE_ENV=production
BEATGALER_CONTROL_PLANE_AUTHORITY=postgres
BEATGALER_POSTGRES_ENABLED=true
BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256=<exact final frozen snapshot sha256>
BEATGALER_SECRET_ENVELOPE_PROVIDER=aws-secrets-manager
BEATGALER_AWS_SECRET_ENVELOPE_ID=<Secrets Manager name or ARN>
AWS_REGION=<AWS region>
```

Database credentials and any infrastructure credentials remain outside source control and outside this document.

The AWS SDK uses its normal credential provider chain. Prefer a workload role (EC2 instance profile, ECS task role, EKS/IRSA or an equivalent short-lived workload identity) rather than long-lived access keys.

## 4. Minimum IAM intent

The Galer Cloud workload identity needs only the actions required to retrieve the approved secret. A policy should be scoped to the exact resources provisioned for BeatGaler.

Conceptual minimum:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "<exact BeatGaler secret ARN>"
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": "<exact BeatGaler customer-managed KMS key ARN>"
    }
  ]
}
```

The final policy must also satisfy the KMS key policy. Do not broaden either statement to `Resource: "*"` for convenience.

## 5. Application startup gate

PostgreSQL authority must remain fail-closed. Startup is refused if any of these conditions holds:

- provider is absent or not `aws-secrets-manager` in production;
- a development/base64 key is also configured;
- secret ID is absent;
- AWS credentials cannot be resolved;
- Secrets Manager denies access or is unavailable beyond the startup request failure;
- KMS decrypt is denied;
- returned secret is empty;
- returned secret is invalid JSON;
- schema identifier is wrong;
- a key version is malformed or not exactly 32 bytes;
- the active version is missing;
- the configured cutover snapshot SHA does not match the READY marker.

There is no automatic fallback to JSON authority and no automatic fallback to a local envelope key after a PostgreSQL authority switch.

## 6. Productive smoke required before cutover

With PostgreSQL still not carrying productive authority, execute a smoke using the actual Galer Cloud workload identity:

1. resolve AWS credentials through the workload identity;
2. fetch only the approved secret at `AWSCURRENT`;
3. let Secrets Manager/KMS decrypt it;
4. parse and validate the keyring;
5. confirm the active key version without printing any key bytes;
6. connect to the productive PostgreSQL target using its productive identity;
7. run migrations/preflight only;
8. keep authority switch disabled until the complete Task 5.2 cutover gate is satisfied.

Evidence must contain timestamps, resource identifiers safe to record, active key version, pass/fail and redacted error classes. It must never contain secret material or database passwords.

## 7. Rotation sequence

For a rotation from version N to N+1:

1. add N+1 to the secret while retaining N;
2. set `activeKeyVersion` to N+1 and publish a new `AWSCURRENT` secret version;
3. restart/reload the application and confirm it can decrypt N while encrypting only N+1;
4. run the transactional PostgreSQL re-encryption operation;
5. verify all OAuth/MFA rows use N+1;
6. restart/reload with the same keyring and run a control-plane smoke;
7. only after evidence and the rollback window allow it, remove N from a later secret version;
8. verify that stale ciphertext under N no longer exists before retiring N.

A failed database rotation rolls back atomically. It does not justify deleting the previous key version.

## 8. RDS evidence still required

Provisioning alone does not satisfy Task 5.2. The productive environment must still demonstrate:

- encrypted backup configuration;
- WAL/PITR or provider-equivalent point-in-time recovery;
- explicit retention;
- independent restore into a separate target;
- validated application invariants on the restored target;
- measured **RPO <= 15 minutes**;
- measured **RTO <= 2 hours**;
- final frozen-snapshot cutover and post-write rollback procedure.

Until those tests are recorded, Task 5.2 remains `[ 🟡 ] / NO-GO`.

## 9. Preserved boundaries

This AWS integration does not change:

- pinned Galer T-Library Schema v2 INDEX as the sole logical authority for beats/trash/deleted/tombstones;
- Telegram as physical media storage;
- device-to-Telegram Direct data plane;
- `galer_cloud_file_bytes=0`;
- temporary-auth trust boundary;
- max 4 active vaults per transport bot;
- token rotation/revoke behavior.
