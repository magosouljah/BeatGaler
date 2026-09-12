# Billing V1 — Reconciliation and safe logs

Task 10 adds a small reconciliation layer on top of the durable Billing V1 state completed in Tasks 1–9.

## Scope

This task may compare Polar sandbox facts with PostgreSQL and repair only differences that are unambiguous. It does not connect billing to Auth/Account as runtime authority and does not touch membership, transport bots, Direct credentials, transport sessions, uploads, playback, downloads, INDEX, Trash or Desktop helper behavior.

## Authority rules

- A provider network/API error is **unknown**, never proof that the user is Free.
- Reconciliation reuses the Task 9 lifecycle projection instead of inventing a second set of subscription/payment/refund rules.
- Subscription facts can synchronize status, cancellation and period metadata, but paid access still advances only from a confirmed paid Order.
- A confirmed full refund of current coverage follows the Task 9 invalidation path and queues the durable provider revocation action.
- Independent grants in `entitlements` are read by the resolver and are never rewritten by reconciliation.
- Contradictory bindings, unknown/ambiguous offers, multiple live subscriptions and other uncertain provider states create/update a durable reconciliation exception instead of being auto-repaired.

## Discovery

Reconciliation discovers provider state by BeatGaler's server-side external customer identity. It asks Polar for subscriptions and recurring Orders for that user. This is required to recover an initial purchase whose webhook was lost even when PostgreSQL does not yet have a local subscription row.

The runtime exposes three bounded entry points:

1. `reconcileUser(...)` for a manual/user-specific check.
2. `runPendingSweep(...)` for unresolved checkout, failed webhook and stale billing states.
3. `runCommercialSweep(...)` for a cursor-paginated customer sweep suitable for daily scheduling.

No provider lookup is added to login or playback.

## Exceptions

`billing_reconciliation_exceptions` is reused. Exception identity is stable by provider + environment + user + reason, so repeated checks update one row and increase its attempt count instead of generating an exception per poll.

Provider/local snapshots stored there are deliberately narrow billing projections, not raw webhook/API payloads.

## Logging and audit

`billing-safe-log.js` provides one allowlisted structured logging boundary. Reconciliation emits/audits events such as:

- `reconciliation_mismatch`
- `reconciliation_repaired`
- `reconciliation_failed`
- `reconciliation_sweep_completed`

Allowed details include internal user/operation IDs, provider/environment, reason, error code, duration and small previous/next state projections.

The logger never accepts arbitrary provider payloads and drops unknown keys. It does not persist access tokens, webhook secrets, full signed URLs, card fields or raw provider error messages. Durable audit events reuse the existing `audit_events` table.

## Recovery behavior

A missed paid Order can reconstruct paid coverage and close its persisted checkout. A missed refund can invalidate the current commercial source and queue the durable revoke action. A provider outage changes neither paid coverage nor grants. Ambiguous state stays explicit until another reconciliation run has enough facts to resolve it.

## Validation target

The PostgreSQL integration gate must demonstrate:

- lost initial webhook/payment recovered from provider discovery;
- provider outage cannot cause a false downgrade and secrets do not appear in structured/durable logs;
- multiple live subscriptions remain one stable exception rather than being auto-repaired;
- missed current-period full refund is recovered without deleting grants;
- pending sweep reaches a checkout user that has no local subscription yet;
- commercial sweep is bounded and cursor-paginated;
- Tasks 7–9 remain green on the same migration set.
