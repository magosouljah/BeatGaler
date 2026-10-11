# STEP 15 — first real Browser gate

This gate is intentionally smaller than the final E2E matrix. Run it first against the dedicated STEP 15 Cloud/database/account/vault after `scripts/step15-isolated-env-guard.mjs` passes.

It proves through the real Web UI that:

- account A can log in through the current sign-in form;
- Web receives cookie session + CSRF state;
- `/plans/me` and `/auth/account` expose the same PostgreSQL-backed Access projection;
- the account has a provisioned vault;
- the authoritative library surface loads without inventing an empty library on error;
- a full browser reload preserves account identity and Access.

It does **not** import, edit, delete, purge, pay, or publish a PROJECT. It therefore does not count as Telegram mutation or financial evidence.

Required in addition to the isolated-environment variables:

```text
STEP15_ACCOUNT_A_IDENTIFIER=<disposable STEP15 account email/username>
STEP15_ACCOUNT_A_PASSWORD=<secret supplied only in the local shell>
```

Run after dependencies are installed and the isolated STEP 15 Cloud is already healthy:

```bash
npx wdio run wdio.step15-real.conf.mjs
```

Use `STEP15_WEB_PREVIEW=1` after `npm run build:web` to exercise the built Web artifact. The report is sanitized and written to `STEP15_RUN_DIR/browser-auth-access.json`; the identifier/password are not written there.
