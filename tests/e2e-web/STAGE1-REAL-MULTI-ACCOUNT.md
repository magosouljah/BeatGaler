# Stage 1 — real multi-account Web E2E

This harness is the first productive Stage 1 browser test. It is intentionally small: two independent BeatGaler accounts, two isolated Chrome sessions, one real Cloud, real PostgreSQL control-plane state and real Direct bootstrap.

It does **not** replace `cloud-server/tests/stage1-multi-account-concurrency.test.cjs`. That older test is useful synthetic coverage, but it does not prove the browser-to-Cloud-to-Direct path.

## What this first scenario proves

For account A and account B, concurrently:

1. opens an independent Chrome session;
2. clears that browser profile before the run;
3. signs in through the real BeatGaler Web UI;
4. verifies the browser received a Web cookie session and CSRF state;
5. verifies the two browsers have different BeatGaler user ids and different stable Web client ids;
6. calls the authenticated productive `/transport/session/start` path through the same-origin Web proxy;
7. records the real vault `chat_id` and persistent `transport_id` returned by the control plane;
8. requires the two accounts to resolve different vaults;
9. reloads both browsers concurrently;
10. verifies each account keeps the same user, Web client id, vault and persistent transport bot after Reload.

The two accounts are **allowed to share the same transport bot**. Persistent ownership is per vault; Stage 1 must not accidentally reintroduce a one-vault-per-bot assumption.

## What is real

- Chrome/WebdriverIO browser sessions;
- BeatGaler Web UI login;
- browser cookies, localStorage and sessionStorage;
- BeatGaler account session;
- Web same-origin Cloud proxy;
- Cloud authentication/control plane;
- PostgreSQL-backed persistent vault → transport assignment used by the current runtime;
- productive Direct session bootstrap metadata;
- real vault ids and transport ids.

No fake bot, fake token, fake vault, fabricated lease or monkey-patched provider client is used by this E2E.

The first scenario does **not** yet prove playback bytes, upload, metadata edit, download, Trash or high account counts. Those remain `NOT_TESTED` in the JSON result until later scenarios are added.

## Local prerequisites

Before running the E2E:

- use the validated BeatGaler checkout and dependencies;
- run the real BeatGaler Cloud on `http://127.0.0.1:4000` unless `STAGE1_CLOUD_URL` is intentionally overridden;
- keep PostgreSQL and the real Direct transport configuration available to that Cloud;
- have two dedicated BeatGaler test accounts with different vaults.

Do not put account credentials in Git, command history, screenshots, chat messages or test source.

Create this ignored local file at the repository root:

```dotenv
STAGE1_ACCOUNT_A_IDENTIFIER=...
STAGE1_ACCOUNT_A_PASSWORD=...
STAGE1_ACCOUNT_B_IDENTIFIER=...
STAGE1_ACCOUNT_B_PASSWORD=...
```

Name it exactly:

```text
.env.stage1
```

The repository already ignores `.env.*`, so `.env.stage1` is local-only.

The harness deliberately reuses dedicated accounts instead of registering fresh accounts every run. Registration provisions real external storage, so automatically creating disposable accounts on every execution would create persistent provider-side vaults and make repeated load runs destructive/noisy.

## Run

From the repository root:

```bash
node scripts/run-stage1-real-multi-account-e2e.mjs
```

To watch both browsers while developing the harness:

```bash
STAGE1_HEADED=1 node scripts/run-stage1-real-multi-account-e2e.mjs
```

On PowerShell:

```powershell
$env:STAGE1_HEADED="1"; node scripts/run-stage1-real-multi-account-e2e.mjs
```

The runner starts its own Vite Web dev server on port `1421` by default. That intentionally uses the existing `/beatgaler-api` proxy to the real Cloud instead of inventing a second E2E backend.

Optional local overrides:

- `STAGE1_WEB_PORT`
- `STAGE1_CLOUD_URL`
- `STAGE1_HEADED=1`

## Result artifact

The E2E writes:

```text
tmp/stage1-real-multi-account-report.json
```

`tmp/` is ignored by Git.

The report contains only safe identifiers and observations needed for Stage 1. It never writes passwords, auth-cookie values, CSRF values, bot tokens, API hashes or permanent Direct credentials.

Top-level outcome uses:

- `PASS`
- `FAIL`
- `BLOCKED`
- `FLAKY`
- `NOT_TESTED`

Failures use the Stage 1 severities when applicable:

- `P0` — account/vault isolation or corruption risk;
- `P1` — principal flow unusable;
- `P2` — degraded flow with workaround;
- `P3` — minor/cosmetic.

## Next scaling steps

Only after the two-account proof is stable:

1. add a concurrent playback scenario while preserving the known playback progress/seek bug as evidence rather than hiding it;
2. add upload + metadata edit while the other account plays/reloads;
3. add download and Trash isolation;
4. parameterize the account cohort and grow progressively (for example 2 → 4 → 10) rather than jumping directly to the size of the transport pool;
5. add controlled disconnect/session-expiry and Cloud/pool pressure scenarios.
