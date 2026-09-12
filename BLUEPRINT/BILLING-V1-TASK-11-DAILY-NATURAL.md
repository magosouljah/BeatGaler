# Task 11 — Natural daily Sandbox renewal

This harness is implementation support, not proof that renewal has occurred. Task 11 remains PARTIAL until its independent scenarios are verified. No production wiring imports the daily harness.

## Isolation and financial authority

`POLAR_SANDBOX_E2E_MODE=daily_natural_sandbox`, `BILLING_E2E_PROVIDER=polar`, and `BILLING_E2E_PROVIDER_ENVIRONMENT=sandbox` are all mandatory. `NODE_ENV=production` is rejected. SDK entry/version remains `@polar-sh/sdk/2026-04` / `1.0.0-alpha.20`; network clients are pinned to Sandbox.

Daily offers have their own IDs: `e2e_daily_paid_entry_v1` and `e2e_daily_highest_paid_v1`. Internal plans remain `paid_entry` and `highest_paid`. Their internal commercial equivalents and `next_interval` remain monthly; `providerInterval=day` and the validated provider evidence explicitly identify the test cadence. This preserves the production catalog and its existing PostgreSQL month/year constraint, without a test-only production migration. No monthly product or price mapping is reused.

The harness explicitly injects a product validator through the adapter's existing dependency-injection boundary. Normal adapters keep the normal monthly validator. Every daily product must belong to the selected organization, be unarchived, have an unarchived fixed USD price with the configured positive amount, and use product `day/1` with no conflicting price interval. Products and prices must be distinct. IDs from production cannot resolve on the isolated Sandbox API.

Daily config requires these additional variables:

- `POLAR_SANDBOX_E2E_DAILY_PAID_ENTRY_PRODUCT_ID`
- `POLAR_SANDBOX_E2E_DAILY_PAID_ENTRY_PRICE_ID`
- `POLAR_SANDBOX_E2E_DAILY_PAID_ENTRY_AMOUNT_MINOR`
- `POLAR_SANDBOX_E2E_DAILY_HIGHEST_PAID_PRODUCT_ID`
- `POLAR_SANDBOX_E2E_DAILY_HIGHEST_PAID_PRICE_ID`
- `POLAR_SANDBOX_E2E_DAILY_HIGHEST_PAID_AMOUNT_MINOR`

Existing access names: `POLAR_SANDBOX_ACCESS_TOKEN`, `POLAR_SANDBOX_WEBHOOK_SECRET`, `POLAR_SANDBOX_ORGANIZATION_ID`, `POLAR_SANDBOX_E2E_EMAIL`, `BILLING_E2E_TEST_ADMIN_URL`, `BILLING_E2E_EXPECTED_HEAD`, `POLAR_SANDBOX_E2E_WEBHOOK_TRANSPORT=polar-cli-listen`. The token needs product/subscription/order/payment reads, checkout and subscription writes, and the existing later-scenario permissions for customer portal/refunds. Use the official CLI's existing Sandbox OAuth session; never store secrets in this document, evidence, Git or command arguments.

The admin URL must point to localhost `/postgres` and a role with CREATEDB. Only a newly generated `beatgaler_billing_e2e_daily_*` DB is used. Production/historical DB names are rejected.

## Start and resume

Before these commands, configure session credentials, start the official Sandbox relay, and load its current signing secret into the runtime environment. Exporting variables in an unrelated terminal does not change the runtime's environment. The relay prompts for environment and organization: choose Sandbox and the intended E2E organization.

```bash
polar listen http://127.0.0.1:4011/webhooks/polar # Runs Polar's official relay; keep its signing secret out of logs and evidence.
```

Run Billing tests and commit the tested code first. The runner checks the branch and exact committed Billing source before external mutations. From `cloud-server`, with the session environment ready:

```bash
npm run e2e:polar-sandbox -- start # Validates daily products, creates an isolated persistent DB and starts the real checkout phase.
```

The runner prints its run ID, databaseName and state file path before creating the DB. Open the local `/checkout` page it prints; it redirects to the real Sandbox checkout without putting the provider URL in logs/state/evidence. Complete the checkout using an [official test payment method](https://polar.sh/docs/integrate/sandbox). Do not use a real card or persist card data.

START verifies Free, same-request recovery, near-duplicate checkout blocking, a redirect with no entitlement, the initial paid Order and successful Stripe Payment, a processed real `order.paid`, Paid Entry, a single subscription, and a `next_period` change to Highest. It saves the pre-renewal Paid Entry/Highest-pending snapshot and checks that scheduling did not alter the provider period end. It then returns `WAITING_FOR_NATURAL_RENEWAL`, with the actual UTC and Mexico City renewal timestamp. It never alters the period end.

The atomic `.billing-e2e/<runId>.json` envelope contains sanitized state/evidence plus an integrity digest. It contains no tokens, signing secret, payment-method data or provider checkout/portal URLs. IDs, financial status and periods are retained. The DB holds a run identity marker, real verified receipt/replay proofs and access observations. Resume checks the external expected run ID, DB name and SHA, the state digest, actual connected database, marker and freshly validated product configuration. It does not silently rebase old evidence onto new code.

To resume, restore the same credentials and current relay signing secret, and set `BILLING_E2E_RUN_ID`, `BILLING_E2E_DATABASE_NAME`, and `BILLING_E2E_EXPECTED_HEAD` to the saved non-secret identity. With no other runtime serving that run:

```bash
npm run e2e:polar-sandbox -- resume ../.billing-e2e/RUN_ID.json # Continues incomplete checkout/setup or verifies the same run after natural renewal.
```

An interrupted checkout reuses its persisted request; it does not silently create another subscription. An ambiguous provider checkout requires diagnosis through the existing checkout service. A crash between database creation and marker initialization preserves the DB and fails closed for diagnosis. A committed-code mismatch similarly requires checking out the original tested commit before continuing.

Before renewal, resume returns WAITING. After renewal time, a missing new paid cycle Order is tolerated for 30 minutes and then fails with `DAILY_NO_SECOND_PAID_ORDER`; rerunning allows checking delayed real provider processing. No clock is injected. The checkout/webhook wait defaults to 30 minutes, bounded to one hour via `POLAR_SANDBOX_E2E_WAIT_MS`.

RESUME requires distinct A/B Orders, distinct successful Stripe Payments, B's `subscription_cycle` billing reason and payment trigger, the same subscription/customer, the Highest product/price/amount, a new period taken from B's own financial line items, advanced PostgreSQL paid coverage, real processed B `order.paid` receipt and consistent reconciliation. `subscription.cycled`, active subscription status, provider product changes, manual Orders, trials and clock changes cannot satisfy the proof. Missing real renewal receipt yields PARTIAL even if financial reconciliation succeeds.

## Keeping real delivery available

START/RESUME are finite phases. Neither is required to run for 24 hours. For background receipt and processing between them, start the separate listener runtime against the saved state and keep the official Polar relay active:

```bash
npm run e2e:polar-sandbox -- listen ../.billing-e2e/RUN_ID.json # Serves real signed webhooks and records durable receipts/observations for this existing run.
```

Only one runtime may own a run at once. Stop `listen` before `resume`. Keep the relay running during that short handoff. The DB and state survive terminal closure, IDE closure, WSL restart and PC restart; neither process is an automatically installed boot service. Restoring them restores processing of durable inbox entries, not unreceived webhook deliveries.

Polar [documents the CLI as a connected relay](https://polar.sh/docs/integrate/webhooks/locally). The [official CLI implementation](https://github.com/polarsource/cli/blob/main/src/commands/listen.ts) forwards SSE events and supports stream reconnects; it does not provide a durable local replay queue for failed forwarding. Do not assume it delivers events emitted while offline. Polar's [up-to-ten exponential retries and delivery redelivery UI](https://polar.sh/docs/integrate/webhooks/delivery) describe registered webhook endpoints; they are not evidence of relay backlog retention. If the relay misses B, restore the services, reconcile real Orders, and keep webhook proof PARTIAL unless an actual provider redelivery is available and received. Never construct or sign a replacement event locally.

No daily phase drops the E2E DB, on success or failure. Cleanup is deliberately a separate explicit future action, after evidence export and user-requested cleanup. Local integration tests delete only their generated fixture DBs and are not E2E evidence.

## Remaining Task 11 scenarios

The initial purchase, checkout retry/redirect, real webhook replay, deferred upgrade and natural renewal have independent evidence. A renewal PASS does not mark all Task 11 complete.

After proof, cancellation and natural expiration can continue on the same daily subscription. Full/partial refunds and initial failure/recovery require separate real Sandbox purchases. Failed renewal/past_due/grace/recovery needs another daily run, prepared with an officially documented payment method that attaches successfully but declines off-session; wait for its natural renewal. Seven-day grace must be described honestly: local policy tests are distinct from observed real-time expiration. The historical runner still contains accelerated paths for archival context and must not be used to demonstrate these scenarios. No replacements for those real scenarios are claimed by the daily renewal harness.

## Validation

### Recorded real-run repair: late initial Order update

Run `20260912123817_e7cfaa52` exposed a lifecycle race: a real `subscription.updated` projected the deferred Highest change, then a late `order.updated` for the initial paid Order cleared the pending fields. The provider still had the scheduled change and the resolver still returned Paid Entry. The fix retains a provider pending update whose effective timestamp is at or beyond the paid Order's coverage end. Paying the new period consumes an applied update normally.

For this incident only, an explicit code-repair handoff preserves the original state file, records old/new SHAs and reason in state and a DB audit table, and moves the run marker to the tested descendant commit. It requires the exact old SHA in `BILLING_E2E_REPAIR_FROM_HEAD`, new SHA in `BILLING_E2E_EXPECTED_HEAD`, and the existing run/DB identity. It refuses an active runtime or anything other than the initial paid checkpoint with one real payment. Normal resume continues rejecting a mismatched commit. No financial facts, dates or provider subscription are rewritten by the handoff.

After stopping the old runtime and configuring those identities:

```bash
node scripts/polar-sandbox-daily-repair-code.cjs ../.billing-e2e/20260912123817_e7cfaa52.json # Audits the explicit code repair while preserving the original state and existing DB.
npm run e2e:polar-sandbox -- resume ../.billing-e2e/20260912123817_e7cfaa52.json # Reconciles real provider facts with the corrected code, then verifies the pending upgrade.
```

The handoff writes a staged state before its DB commit. If interrupted after the DB commit but before the file rename, repeating the same repair finishes the staged handoff. After successful completion use ordinary resume, not another repair. The original checkout and payment are retained, so the repair does not require another purchase.

```bash
npm run test:billing-v1 # Runs normal policy/SDK contracts and the daily fail-closed/state/financial-proof tests.
npm run preflight:polar-sandbox-e2e # Checks historical guard and daily runner syntax without provider mutations.
node --test tests/billing-polar-daily.integration.cjs # Tests daily domain equivalents and restart identity with local PostgreSQL fixtures, never Polar.
```

The existing checkout, durable inbox, lifecycle, migrations and reconciliation PostgreSQL gates still apply. The manual Task 11 preflight workflow includes the daily integration fixture and asserts the requested exact SHA; it never counts as real E2E PASS.
