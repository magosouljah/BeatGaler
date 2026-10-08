# Stage 1 — 4-account login root cause and architectural follow-up

Branch: `stage1/real-multi-account-e2e`.

This document records the current verified state after the first real 4-account
Stage 1 attempts. It is intentionally self-contained so a fresh session can
reconstruct the problem from GitHub without relying on chat history.

## Scope and current status

Stage 1 is validating real independent Web accounts through the real Web → Cloud
→ PostgreSQL / Direct control-plane path. The current reusable cohort contains 10
real accounts and must not be reseeded just to make a failing test pass.

The progression remains 2 → 4 → 10 accounts for the current login/isolation/
Reload scenario. Playback concurrency, upload while another user plays/reloads,
metadata edit, downloads, Trash isolation, disconnect/session expiry and pool
saturation remain separate later Stage 1 scenarios.

The 2-account corrected harness achieved 3 consecutive PASS runs before scaling
to 4 accounts.

## Harness bug found during the first 4-account attempt

The first 4-account attempt did not represent four independent Chrome profiles.
Accounts 03 and 04 shared the same browser-local client identity and their observed
network timings were identical. Chrome also printed a message indicating that an
existing browser session was reused.

Root cause: `wdio.stage1-real.conf.mjs` created multiple WebdriverIO aliases but
did not assign a distinct Chrome `--user-data-dir` to each alias.

Fix committed on the Stage 1 branch:

- commit `55aa456318a09d38189f2d3d99109b875e55ddd4`
- each `account01`, `account02`, ... receives a unique temporary Chrome profile;
- profiles live under `tmp/stage1-browser-profiles/run-...` and are removed after
  the run;
- regression test:
  `tests/e2e-web/stage1-wdio-profile-isolation.test.mjs`;
- the regression test passed locally before the next real 4-account run.

This harness correction must remain. It is not the product/root-cause fix below.

## Corrected 4-account run — demonstrated product failure

After the unique-profile fix, four distinct Chrome instances started correctly.
All four accounts reached the Cloud health endpoint successfully, then all four
real `/auth/login` requests were aborted by the Web client's existing 20-second
request timeout.

Observed per-account auth network result:

| Account | `/auth/health` | `/auth/login` |
| --- | --- | --- |
| 01 | HTTP 200, ~309 ms | aborted at ~20,001 ms |
| 02 | HTTP 200, ~372 ms | aborted at ~20,001 ms |
| 03 | HTTP 200, ~631 ms | aborted at ~20,010 ms |
| 04 | HTTP 200, ~754 ms | aborted at ~19,999 ms |

Therefore:

- the form did submit;
- `/auth/login` did start for all four accounts;
- Cloud itself remained alive enough to serve `/auth/health`;
- the failure is not explained by bad cohort passwords;
- the failure is not explained by the auth observer;
- increasing the client timeout is explicitly not an accepted root-cause fix.

## Password KDF was measured and excluded

`cloud-server/password-kdf.js` uses async `crypto.scrypt()`.

A synthetic benchmark using the same Node version used by the Cloud inside WSL
(`/root/.nvm/versions/node/v22.23.2/bin/node`) measured:

- concurrency 1: ~75 ms total;
- concurrency 2: ~73 ms total;
- concurrency 4: ~104 ms total, individual calls ~76–104 ms.

This is orders of magnitude below the 20-second login abort and excludes the KDF
as the cause of the observed 4-account failure.

## Root cause reproduced independently

The login handler in `cloud-server/server-core.js` currently performs, after
password/MFA validation:

1. `syncXIdentity(user)`;
2. `ensureUserStorage(user)`;
3. `bindInstallationToBeatGalerUser(...)`;
4. `createAuthSession(...)`;
5. respond to the login request.

For an already-provisioned user, `ensureUserStorage(user)` still performs remote
storage verification when MASTER storage is configured. It calls
`verifyPrivateUserStorageGroup(...)`.

`cloud-server/master-storage.js` implements that verification by:

1. constructing a new GramJS `TelegramClient`;
2. `client.connect()`;
3. checking authorization;
4. `client.getDialogs({ limit: 1000 })`;
5. locating the persisted vault by chat id;
6. disconnecting the client.

A read-only synthetic benchmark executed this exact verification path with a
nonexistent probe chat id. No account, PostgreSQL row or vault was modified.
Results:

- concurrency 1: **8,839 ms**;
- concurrency 2: **1,640 ms** total, individual ~1,484 / 1,637 ms;
- concurrency 4: **28,849 ms** total, individual
  **1,454 / 1,634 / 28,841 / 1,539 ms**.

The 28,841 ms outlier exceeds the Web login's 20,000 ms request timeout and
reproduces the failure mechanism seen in the real 4-account E2E.

### Root-cause conclusion

The demonstrated blocker is synchronous remote MASTER/vault verification inside
the normal login/session-restore path for already-provisioned accounts. Under
four concurrent logins, one of those verifications can exceed the login timeout.

This is a real architecture/concurrency defect discovered by Stage 1, not a reason
to relax the test or inflate timeouts.

## Important product fact supplied by the owner

End users cannot delete their BeatGaler vaults. The only person who can delete
those private groups is the owner of the MASTER account itself.

Therefore a persisted vault disappearing is an exceptional administrative event,
not a normal condition that should be synchronously re-verified on every login.

## Proposed architectural change — NOT IMPLEMENTED YET

Do not assume the architecture below has already been changed. At the time this
document was created, only the Chrome profile isolation harness fix was committed.

The proposed responsibility split is:

### A. Authentication / session path

Normal login for an already-provisioned account should use the durable storage
assignment already recorded for that account.

Conceptually:

`password/MFA → stored storage assignment present/valid → bind installation → create session → respond`

A login should not open MASTER merely to re-prove that a known vault exists.

### B. First-time provisioning

If the user has no persisted storage assignment (`storageChatId` absent/null), the
account is new/unprovisioned and BeatGaler must still provision a vault before the
account is considered storage-ready.

This remains a real MASTER operation.

### C. Vault health / recovery

Remote physical verification belongs to provisioning, explicit maintenance or a
recovery path triggered by a definitive storage failure — not every login.

The existing code already distinguishes definitive missing-vault signals such as
`CHANNEL_INVALID`, `CHANNEL_PRIVATE`, deleted/missing group and invalid peer from
transient failures. Preserve that distinction.

Because only the MASTER owner can delete a vault, automatic recreation should be
considered carefully. A safe V1 policy may be:

- normal persisted assignment → trust it;
- definitive missing-vault error during real storage use → mark/report storage as
  missing/broken and enter controlled recovery;
- do not interpret a transient MASTER/network failure as proof that the vault was
  deleted;
- do not create duplicate replacement vaults.

## Functions/responsibilities that should be separated

`ensureUserStorage(user)` currently mixes assignment/provisioning and remote
health/maintenance. The implementation should be refactored so responsibilities
are explicit, for example:

- assignment/provisioning function: ensure the user has a valid persisted
  `storageChatId`; create a vault only when there is no assignment;
- verification/recovery function: perform MASTER verification only on an explicit
  recovery/maintenance path;
- manager-bot cleanup (`ensurePrivateUserStorageBotAbsent`) should not be repeated
  synchronously on every login. Preserve it in provisioning/migration/recovery or
  another controlled maintenance path.

Names above are illustrative; preserve existing semantics and tests rather than
forcing those exact names.

## Required safety/invariants for the architectural fix

Before accepting the change, tests must protect at least these cases:

1. Existing user with persisted vault assignment can login without invoking remote
   MASTER vault verification.
2. New user with no storage assignment still provisions storage correctly.
3. Existing user whose real vault is definitively missing is not silently treated
   as healthy forever; the real data/storage path must surface a deterministic
   recovery/broken-storage condition.
4. Transient MASTER/network failure must never be treated as proof that a vault
   was deleted.
5. Recovery for one user must be single-flight/locked so concurrent failures do
   not create duplicate replacement vaults.
6. Independent users must not block each other's normal login on MASTER health.
7. Installation ownership/binding checks remain intact.
8. Existing stale-binding clearing/rebinding behavior must be preserved when a
   vault truly changes.
9. Manager-bot cleanup invariant remains enforced somewhere appropriate, even
   though it leaves the hot login path.
10. Do not increase auth timeout/retries/sleeps to manufacture a PASS.

## Protected local state / operational constraints

Do not edit, revert, stage or commit
`cloud-server/diagnostics/telegram-direct-control.txt`. The live Cloud may append
to it.

Do not reseed the 10-account Stage 1 cohort merely because the test fails.
Do not manually modify PostgreSQL to force the scenario through.
Do not hide the blocker by changing the 20-second login timeout.

## Next implementation sequence

A fresh session should:

1. Re-read the current remote HEAD of `stage1/real-multi-account-e2e`; do not
   assume any SHA in this document is still HEAD.
2. Inspect current `server-core.js`, `master-storage.js`, storage recovery tests,
   auth/session tests and any newer commits touching these areas.
3. Implement the smallest responsibility split that removes remote MASTER
   verification/cleanup from normal login/session restore for already-provisioned
   accounts while preserving first-time provisioning and recovery invariants.
4. Add focused regression tests before/with the implementation.
5. Run relevant Cloud/unit tests and type/build checks appropriate to touched
   files.
6. Re-run the real 4-account Stage 1 scenario **without increasing the timeout**.
7. If 4 accounts pass cleanly, continue the documented 2 → 4 → 10 progression;
   do not claim Stage 1 complete because later scenarios remain NOT_TESTED.
