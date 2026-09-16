# Stage 1 — real multi-account Web E2E

This harness creates and reuses a fixed cohort of **10 real BeatGaler test accounts**. The accounts are created through the productive `/auth/register` path, so each account receives normal BeatGaler identity/storage provisioning instead of database fixtures, fake vaults or monkey-patched transport clients.

It does **not** replace `cloud-server/tests/stage1-multi-account-concurrency.test.cjs`. That older test remains useful synthetic coverage; this harness exists to prove the browser → Cloud → Direct → authoritative library path with real accounts.

## 1. Seed the real account cohort once

Prerequisites:

- BeatGaler Cloud running on `http://127.0.0.1:4000` unless `STAGE1_CLOUD_URL` is intentionally overridden;
- PostgreSQL available to that Cloud;
- MASTER storage account configured and able to create real vaults;
- productive Direct transport configuration available.

Run from the repository root:

```bash
node scripts/seed-stage1-real-accounts.mjs
```

The seed command:

1. creates a local random `STAGE1_COHORT_ID`;
2. creates a strong random cohort password;
3. stores both only in ignored `.env.stage1`;
4. creates 10 deterministic test emails for that cohort;
5. calls the real `/auth/register` endpoint sequentially;
6. therefore provisions real BeatGaler accounts and real vaults through normal Cloud code;
7. immediately signs each account in to prove the generated credentials are reusable;
8. treats an already-existing cohort account as reusable only if its password still signs in successfully.

The password is never printed and is not written to the JSON report.

The generated account identifiers have this form:

```text
stage1.<cohort-id>.01@beatgaler.test
...
stage1.<cohort-id>.10@beatgaler.test
```

`beatgaler.test` is used only as a reserved test-domain identifier; these accounts are not intended for real email delivery.

Seed evidence is written to:

```text
tmp/stage1-real-account-seed-report.json
```

## 2. Run the real browser test

A normal first run uses the first two accounts from the already-created 10-account cohort:

```bash
node scripts/run-stage1-real-multi-account-e2e.mjs
```

Scale without creating new accounts:

```bash
node scripts/run-stage1-real-multi-account-e2e.mjs --accounts 4
node scripts/run-stage1-real-multi-account-e2e.mjs --accounts 10
```

To watch the browsers:

PowerShell:

```powershell
$env:STAGE1_HEADED="1"; node scripts/run-stage1-real-multi-account-e2e.mjs --accounts 2
```

The runner starts its own Vite Web server on `localhost:1421` and uses the existing `/beatgaler-api` proxy to the real Cloud.

## What the current scenario proves

For every active account concurrently:

1. opens an independent Chrome session;
2. clears that browser profile before the run;
3. signs in through the real BeatGaler Web UI;
4. verifies the real browser session cookie + CSRF state;
5. waits for the authoritative Web library to finish loading;
6. verifies productive `/transport/session/start` identity;
7. records real BeatGaler user id, browser client id, vault `chat_id` and persistent `transport_id`;
8. requires every active account to have a unique BeatGaler user, browser client id and vault;
9. allows multiple independent vaults to share a transport bot;
10. reloads all active browsers simultaneously;
11. requires every account to keep the same user, browser id, vault and persistent transport assignment after Reload.

The active count is selectable from 2 through the 10 seeded accounts. The intended progression is 2 → 4 → 10 so a harness defect is not confused with a real scaling defect.

## What is real

- account registration;
- vault provisioning;
- Chrome/WebdriverIO browser sessions;
- BeatGaler Web UI login;
- browser cookies/localStorage/sessionStorage;
- BeatGaler account sessions;
- Web same-origin Cloud proxy;
- Cloud auth/control plane;
- PostgreSQL-backed persistent vault → transport assignment;
- productive Direct bootstrap metadata;
- authoritative Web library load;
- real vault ids and transport ids.

No fake bot, fake token, fake vault, fabricated lease or monkey-patched provider client is used.

## Still NOT_TESTED by this first scenario

- playback concurrency/bytes;
- upload while another account plays or reloads;
- metadata edit;
- downloads;
- Trash isolation;
- disconnect/session expiry;
- transport-pool saturation and larger cohorts beyond 10.

These stay explicitly `NOT_TESTED` in the report instead of being inferred from the startup test.

## Result artifact

The E2E writes:

```text
tmp/stage1-real-multi-account-report.json
```

It contains identifiers/measurements useful for Stage 1 but never the cohort password, auth-cookie values, CSRF values, bot tokens, API hashes or permanent Direct credentials.

Top-level outcome uses `PASS`, `FAIL`, `BLOCKED`, `FLAKY` or `NOT_TESTED`. Failures use Stage 1 severity (`P0` through `P3`).
