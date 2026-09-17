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

## Login diagnostics (report v3)

Each account retains a `login` record even when another account fails. Concurrent
login attempts settle before the failure report is written. It records the label,
elapsed time (including profile setup), form/login/MFA presence, visible phase,
sanitized alert text, submit disabled/aria-busy state, URL without query/hash,
Web client ID, and observed auth HTTP status and request duration.
The observer uses the installed WebdriverIO `addInitScript` (WebDriver BiDi),
registered before the first `client.url()`. Chrome runs it before application
scripts in every new document, including profile-reset refresh and simultaneous
Reload. There is no late `execute()` fallback if preload installation fails.
The fetch observer forwards request bodies and responses unchanged. The health
probe adds a non-sensitive `x-stage1-trace` correlation header. Existing headers
are forwarded but never serialized. No request/response bodies are inspected.

Only same-origin `/beatgaler-api/auth/health`, `/auth/session`, `/auth/account`
and `/auth/login` under that API prefix are observed. `/auth/session` is the
productive restore check (the app can skip it when no session marker exists).
Route, HTTP status, state, duration, harness phase, correlation ID, browser epoch
timestamps and allowlisted Resource Timing numbers are retained per request.
Query strings, headers and credential values are excluded from reports.
Sanitized metadata is emitted to a separate Node collector per browser, so
navigation and local/session storage clearing cannot erase earlier evidence.
The phase is captured when the request-start event reaches the collector.
`accounts[label].login.http` is the login-time snapshot; `auth_network` contains
the full observation up to report writing, including Reload or early failures
where no login form/DOM snapshot was available. Both are saved in the usual JSON
report. The observer is removed in the scenario's `finally` block.
`pending` means no completion was observed at snapshot time (including requests
whose document was destroyed); it is not evidence of a timeout or abort. Its
duration is elapsed observation time; completed durations use browser timing.
WebDriver exceptions are not serialized because they can contain input arguments.
Downstream scenarios remain `NOT_TESTED` when login prevents reaching them.

Isolated observer regression tests use Node VM documents without Cloud or accounts:

```powershell
node --test tests/e2e-web/stage1-auth-observer.test.mjs # Verifies early capture, navigation persistence, isolation and metadata filtering.
```

### Evidence collected on 2026-09-16 (two accounts only)

Local and GitHub Stage 1 HEAD were both `7ee4f3d321ce3cf88052dd3c11c109dd56ce8d3a`;
the integration branch remained `38b0ec770ca8e923f6d1f16e13b84c21d9fb1776`.
These runs used the uncommitted v3 harness changes on that baseline.
No product code, quota, account fixture or database data was manually changed.
The existing local runtime diagnostic modification was preserved.

- 22:49:49–22:50:39 UTC: FAIL. Both accounts displayed
  `Could not reach BeatGaler Cloud.` with distinct Web client IDs and no MFA.
  No `/auth/login` request was observed. This locates this run's failure before
  credentials are submitted, in the Cloud availability probe. The first observer
  did not record health requests, so timeout versus network/HTTP failure is unknown.
  Local evidence: `tmp/stage1-real-multi-account-report-20260916-225039.json`.
- 22:51:15–22:52:59 UTC: PASS, after adding health observation. Health returned
  HTTP 200 in 427/246 ms; login returned HTTP 200 in 5180/5342 ms. Both accounts
  had unique users, Web IDs and vaults. Both authoritative empty libraries loaded.
  Productive Direct used Bot03/Bot02 respectively; expected bot identity matched
  `transport_user_id`. Simultaneous Reload preserved user, Web ID, vault and
  persistent transport. Evidence: `tmp/stage1-real-multi-account-report.json`.

This PASS is evidence for the immediate two-account scenario, not proof that the
earlier intermittent login failure is fixed. The original account02 failure did
not include sufficient diagnostics to assign a root cause. Do not infer one from
the newer availability failure. Do not scale to 4/10 accounts yet.

### Auth path and residual state findings

Web resolves/probes the same-origin API before posting `/auth/login`, including
the adapter's installation ID. Server startup installs abuse, containment,
session-security and lifecycle middleware. Containment checks installation
ownership and reserves an unowned installation claim. The login handler resolves
the user, verifies password/MFA, syncs provider identity, verifies existing storage,
binds the installation, creates the auth session and returns the decorated response.
Containment binds the session to the installation; Web session security supplies
cookie/CSRF handling. Web `storeSession` stores the session marker/CSRF and dispatches
transport prewarm before `AuthExperienceGate` calls `setAccount`.

The historical device/session quota fields occur in `plans.js`; no corresponding
enforcement was found in the login/session creation path. Billing V1 omits those
fields. Auth abuse controls do enforce rate limits by IP/account/installation.
Ownership/claim errors, rate limits, storage verification failures and UI/harness
interaction remain diagnostic possibilities when future attempts fail.

Read-only PostgreSQL inspection during the second run found account01 with five
unexpired sessions and four installation bindings (one seed, three Web), and
account02 with four sessions and three bindings (one seed, two Web). The accounts
therefore have residual state, but exceeding the historical limits did not prevent
this PASS. These are binding counts, not proof of an enforced active-device quota.
The on-disk legacy JSON did not contain the cohort; PostgreSQL is the relevant
source here, exposed to server code through the compatibility layer.

### Stability continuation (2026-09-16/17 UTC): NOT CLOSED

See [STAGE1-STABILITY-INVESTIGATION.md](STAGE1-STABILITY-INVESTIGATION.md) for the
correlated failures, the demonstrated Vite watcher defect, its minimal correction,
the remaining unexplained delay, and all nine real-run artifacts.

Report v4 adds explicit before/after Reload identities and `auth_health_stability`.
A final successful UI no longer hides aborted, network-failed or non-200 health
probes. Successful observed health responses are required for both login and
Reload, per account. No timeout, retry, account or quota was changed.

Opt-in proxy tracing uses `STAGE1_PROXY_TIMING_FILE` (JSONL). Optional
`STAGE1_VITE_PROFILE` writes a CPU profile ending at the first correlated health
request. Neither is enabled by ordinary application startup. Cloud tracing is a
manual local diagnostic, installed/removed using
`scripts/stage1-install-live-timing.mjs` against an already-enabled local Node
inspector; it does not restart Cloud. The Cloud log path is WSL
`/tmp/beatgaler-stage1-cloud-timing.jsonl`. Use `--remove` after collecting evidence.
Cloud and Windows epoch clocks differed during this investigation: use monotonic
within-process durations, never subtract their epoch timestamps as one-way latency.

Local regressions:

```powershell
node --test tests/e2e-web/stage1-auth-observer.test.mjs tests/e2e-web/stage1-cloud-timing.test.cjs tests/e2e-web/stage1-health-validation.test.mjs tests/e2e-web/stage1-vite-watch.test.mjs
```
