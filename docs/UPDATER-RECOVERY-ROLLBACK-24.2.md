# Updater recovery / rollback — F4 24.2

This runbook is the fail-closed recovery surface for Beat Galer desktop updates. It reuses the existing immutable release flow, updater manifest validation, upgrade matrix, provenance/checksums, and release controls. It does not authorize signing, notarization, a public release, or movement of stable/latest.

## Acceptance invariant

A release candidate is acceptable only when the chain is demonstrable as:

`release tag -> exact source SHA -> successful Windows/macOS build runs -> provenance SHA -> checksummed artifact -> signed updater entry`

`.github/workflows/release-desktop-updater.yml` already verifies both build runs are successful and share one SHA, checks out that exact SHA, matches `VERSION` to the tag/artifacts, verifies provenance and SHA-256 sums, and creates an updater manifest from those artifacts. Release controls remain the final fail-closed publication gate.

## N-1 update acceptance

`npm run test:updater-recovery` exercises an installed N-1 (`0.8.0-alpha.1`) against a strictly newer candidate (`0.8.0-alpha.2`). Same/older manifests are rejected. This is a fixture-only acceptance test; it does not publish or install a real release.

The existing upgrade matrix remains authoritative for preserving app data, SQLite, settings, offline data and cache across upgrade/recovery.

## Failure behavior

For network, disk, signature, or manifest failures:

1. Do not activate a partial update.
2. Keep the currently installed version intact.
3. Do not mutate or replace an immutable release artifact.
4. Retry only after fresh endpoint/manifest/signature/artifact validation.
5. Never bypass channel minimum-version, publicationEnabled, or kill-switch controls to make recovery appear green.

Safe fixtures cover an insecure/unreachable-style endpoint, missing signature, malformed/empty manifest, and the policy invariant for disk failure. Real credential signing is outside 24.2 and is not required for these negative-path assertions.

## Bad artifact withdrawal

If a published artifact is found bad, first remove it from updater discovery according to the serving layer's authorized mechanism; do **not** overwrite the immutable GitHub release asset or reuse its tag. Before any mutation, produce a withdrawal plan:

```text
node scripts/updater-recovery.mjs plan-withdrawal \
  --bad-tag vX.Y.Z \
  --source-sha <40-char-source-sha> \
  --artifact-sha256 <64-char-sha256> \
  --bad-version X.Y.Z \
  --last-known-good-version A.B.C \
  --reason "incident summary"
```

The plan binds the incident to tag, exact source SHA and artifact digest, requires an older last-known-good version, preserves the installed version, forbids immutable-release mutation, and marks communication required. Generating the plan is non-destructive.

## Recovery choices

Preferred recovery is a new fixed version built from a new tag and the normal verified release chain. If users must recover before a fixed version is authorized, reinstall the last-known-good N-1 artifact after its tag/SHA/digest/provenance are revalidated. Do not force an updater downgrade through a manifest pretending an old version is new.

Moving `stable`/`latest`, changing publication controls, deleting/replacing public assets, or publishing a replacement release requires the normal release authorization. This runbook itself grants none of those actions.

## Communication minimum

An incident notice must identify the affected version/tag, affected platforms if known, the bad artifact digest, user impact, whether updater discovery has been withdrawn, the last-known-good recovery version, and the next fixed version when known. Never include signing secrets or private infrastructure details.
