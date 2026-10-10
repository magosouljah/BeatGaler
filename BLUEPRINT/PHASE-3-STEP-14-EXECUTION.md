# STEP 14 — provider-real execution

Audit started 2026-10-09 on `integration-v0.9.0-alpha.4` at
`36d717197217c20de2c61c07966c5a12bd740512`. STEP 15 remains out of scope.

## Evidence boundary

The September daily run `20260912123817_e7cfaa52` belongs to `8943436`.
It records an initial purchase, deferred change and a paid cycle Order, but no
verified renewal delivery. It is historical context, not evidence for this HEAD.
Its files and database are preserved. The older accelerated monthly runner stays
disabled: changing a subscription end date does not produce a billed renewal.

The current runtime chain is persistent checkout -> Polar -> SDK signature
verification -> durable inbox -> lifecycle provider lookups -> PostgreSQL ->
Access runtime. Reconciliation independently reads provider facts and uses the
same lifecycle under the same per-user lock. Subscription status and redirects
cannot create paid coverage. Full current-period refunds enqueue a durable
provider revoke; historical refunds must not revoke a later paid period.

New runs bind the full committed SHA, branch, unique database, run marker,
organization, product mappings and UTC timestamps. Receipts record signature
verification and dedupe of the exact received delivery. No locally constructed
event can count as provider evidence. The JSON digest detects accidental edits;
it is not a cryptographic attestation by Polar. PostgreSQL and the provider IDs
remain necessary to inspect the evidence.

## Execution strategy

1. Start a fresh daily Entry purchase with the existing dedicated Sandbox
   products, then schedule Highest for the next paid period. Keep the same
   receiver and official relay alive during the natural boundary. Verify distinct
   Orders and successful Payments, financial line-item periods, real `order.paid`,
   paid-through advancement, Access and stable repeated reconciliation.
2. In a separate monthly run, prove the actual USD 6.99/11.99 mappings through
   checkout and financial settlement. Exercise a documented initial decline,
   verify absence of coverage, then recover via the real checkout. A checkout UI
   error alone is insufficient evidence of a failed provider payment.
3. After the daily renewal, refund the historical first Order and check that the
   later paid period and data survive. Schedule cancellation at the paid boundary,
   observe retained access, then natural expiration and no new paid cycle. If
   testing Highest -> Entry, schedule that paid transition before cancellation;
   it takes an additional real daily boundary.
4. Use an independent current paid period for partial refund then full refund.
   Verify provider refund completion, inbox/lifecycle, Access, one durable revoke,
   reconciliation and preservation of ACTIVE/Trash/PROJECT fixtures. These local
   library fixtures prove Billing non-deletion, not Telegram transport (STEP 15).
5. Use another daily subscription for failed renewal. Prepare an official test
   payment method through the hosted payment/portal flow that can succeed at
   setup and fail at renewal; verify Polar's actual behavior before naming the
   scenario ready. Do not assume an off-session authentication failure has the
   same semantics as a declined renewal. Observe the failed Payment/Order,
   `past_due`, last paid tier, grace deadline exactly +7 days and real recovery.
   Do not claim seven elapsed days of grace expiration.

Independent purchases prevent a refund/revoke from invalidating the subscription
needed for cancellation or failed renewal. Start time-dependent runs early; human
payment actions remain one at a time. No API mutation of period dates, trial
conversion, manual Order or synthetic webhook substitutes for a renewal.

## Audit findings and operational dependencies

- The daily runner required obsolete branch `billing/v1-policy`. It now requires
  the integration branch, exact HEAD, committed Cloud source and no untracked
  Cloud files. A mismatched historical state is still rejected.
- The pinned SDK returns one page with `pagination.total_count/max_page`.
  Discovery previously ignored these fields and could treat incomplete Orders
  or subscriptions as authoritative. The adapter now reports truncation when
  more history exists or pagination is inconsistent; reconciliation fails closed.
  This is a code-audit regression, not a bug claimed to have occurred in a new
  Polar payment run.
- The daily snapshot now calls the Web Access runtime and records capabilities,
  quotas, cancellation, past-due and grace, in addition to financial coverage.
- Opt-in `POLAR_SANDBOX_E2E_CONTINUOUS=1` keeps receipt processing alive while
  polling real renewal at 30-second intervals, waits for asynchronous delivery
  after API settlement, and stays listening after renewal verification. The
  finite default remains available. Processes do not survive host shutdown by
  themselves; a live process is not proof that every provider event arrived.
- Existing daily products are USD 100 Entry and USD 200 Highest, day/1. They are
  unchanged and isolated from monthly commercial products. They prove provider
  cadence/lifecycle, **not** commercial monthly pricing. The monthly purchase
  gate remains independent. Historical fixtures had inverted daily amounts;
  current configuration must come from provider IDs and validated product data.
- Polar CLI **v2.0.0** is installed in WSL. Its interface differs from the old
  runbook: `listen --org ID --print-secret` retrieves the current secret without
  starting the relay; `auth whoami` confirms Sandbox and the intended organization.
  Retrieve secrets privately and never print the relay banner to chat/evidence.
- No registered webhook endpoint existed in this Sandbox organization at audit.
  Therefore endpoint delivery retries/redelivery cannot repair an event that was
  never recorded for such an endpoint. The installed CLI relay is available;
  preserve its continuous connection, record actual verified receipts and leave
  missing deliveries unproven. Never use `polar trigger` as financial evidence.
- Local PostgreSQL is reachable, and a local CREATEDB role is available from
  existing ignored configuration. Tests use generated fixture databases; real
  E2E databases are never automatically dropped.

Official references checked during this audit:
[Sandbox](https://polar.sh/docs/integrate/sandbox),
[CLI webhooks](https://polar.sh/docs/integrate/cli/webhooks),
[delivery](https://polar.sh/docs/integrate/webhooks/delivery),
[Stripe test methods linked by Polar](https://docs.stripe.com/testing).
The installed CLI help and actual pinned SDK response shapes take precedence
over examples written for a different version.

## Validation before the new run

Billing V1: 119/119; isolated PostgreSQL checkout/inbox/lifecycle/reconciliation/
daily fixture: 70/70, zero skipped; TypeScript typecheck PASS. These are local or
PostgreSQL-with-fake-provider results. Real Sandbox read-only preflight validated
both monthly prices. No new payment or webhook is claimed by these checks.

The operational summary and next human handoff belong in `PHASE-3-STATUS.md`.

## Real concurrent-run incident

The organization-wide relay delivered monthly events into the isolated daily DB.
They had no trusted daily-user binding, so lifecycle correctly rejected them and
the inbox durably recorded failure. The continuous daily harness incorrectly
propagated this retryable processing error to its top-level wait and exited.
The repaired pump follows the production scheduler: report the durable failure,
end that batch, continue receiving and process later batches. Observation/proof
invariant exceptions still propagate. No receipt is marked successful by this
repair, and no provider object or financial row is edited.

The explicit repair reason `RELAY_FOREIGN_EVENTS_ABORTED_WAIT` is limited to an
`UPGRADE_SCHEDULED` failed run with one initial payment, Entry access and pending
Highest. It refuses changed Cloud files outside the enumerated harness/tests.
The original state is backed up; the DB and state record the transition; initial
evidence retains its old SHA provenance. The repair retains FAIL until a fresh
resume actually checks the provider and returns to a valid waiting state.
