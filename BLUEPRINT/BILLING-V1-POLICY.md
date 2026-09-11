# BeatGaler Billing V1 Policy

Status: **V1 product policy**

This document defines the commercial and access rules for Billing V1. It is intentionally provider-agnostic and does **not** connect billing to Auth, Account, Direct, transport, uploads, Settings, bot membership, bot pools, Direct credentials, library index, Trash implementation or Desktop helper behavior.

The later access resolver must implement these rules as a pure domain policy. Provider facts are projected into PostgreSQL; the provider redirect itself never grants access.

## 1. Plans

| Policy | Free | Paid Entry | Highest Paid |
| --- | ---: | ---: | ---: |
| Monthly price | USD 0 | USD 6.99 | USD 11.99 |
| Beats, including Trash | 20 | 100 | No commercial plan limit |
| New PROJECT ZIP upload | No | Yes | Yes |
| PROJECT ZIP maximum | Not available | 1,000,000,000 bytes | 1,900,000,000 bytes |
| YouTube uploads / UTC day | 3 | 10 | No commercial plan limit |
| YouTube uploads / UTC month | 31 | 60 | No commercial plan limit |
| Bulk YouTube | `none` | `limited` | `full` |
| Early Access | No | No | Yes |

Additional V1 rules:

- Trash consumes beat slots.
- `No commercial plan limit` does not forbid technical anti-abuse or concurrency controls; those controls are not marketed plan quotas.
- V1 has **no commercial device limit and no commercial simultaneous-session limit**. Security/session expiry and technical concurrency controls remain independent.
- Downgrade, cancellation, failed renewal or refund do **not** delete user files.
- Existing beats remain usable after downgrade even when the account is over the lower plan's beat quota. New beat identities are blocked until usage is back within the effective quota.
- Existing PROJECT ZIPs remain available after downgrade to Free. Free cannot upload, replace or re-upload PROJECT content.
- YouTube policy can exist before the Web implementation is ready, but BeatGaler must not advertise an unavailable Web capability as usable.

### Explicitly pending

- Annual billing is not sold in initial V1. The catalog may support an `annual` interval later, but **annual price and launch policy are pending**.
- Paid Entry Bulk YouTube remains `limited`, but the numeric per-batch limit is **pending**. Until a value is approved, that level must not be represented as a finalized purchasable Bulk allowance.

## 2. Welcome access

The welcome benefit is an internal BeatGaler grant, not a provider trial.

- Duration: **7 days**.
- Effective level: **Paid Entry**.
- No card or checkout required.
- Starts once when the account is first activated/verified.
- Must be issued idempotently and at most once per eligible user.
- OAuth reconnect, reinstall, email change or repeated login must not restart it.
- Buying a paid plan during welcome creates a normal subscription immediately after confirmed payment. The welcome grant does not postpone the first charge or extend the paid period.
- When the welcome grant expires, access falls back to the highest remaining valid source: paid subscription, another valid grant, or Free.

## 3. Paid access and period authority

Commercial access is based on confirmed financial coverage persisted in PostgreSQL, not merely on a provider status string.

- A checkout redirect never grants Paid access.
- `checkout.created` or equivalent provider creation events never grant Paid access by themselves.
- A paid period becomes authoritative only after BeatGaler has sufficient confirmed payment evidence for that period.
- `current_period_end` is not, by itself, proof that the period was paid.
- The server clock determines whether a period, grace window or grant is active.

## 4. Cancellation

### Cancel at period end

- Cancellation is scheduled for the end of the already paid period.
- The user keeps the currently paid plan until the end of that paid coverage.
- The user may undo the cancellation before the period ends if the provider still permits it.
- At the end of coverage, the commercial source expires and the effective plan is recalculated from remaining grants and Free.
- No files, beats, PROJECTs or Trash entries are deleted because of cancellation.

### Immediate administrative termination

An explicit administrative termination may invalidate commercial access immediately. This is separate from a normal customer cancellation and must be auditable. It still does not delete user files.

## 5. Failed payments and grace

### First payment fails

- A failed first purchase does **not** grant commercial access.
- Any independent valid grants, including welcome, continue under their own dates.

### Renewal fails

- Keep the **last successfully paid plan** during a **7-day grace period**.
- Grace begins at the first confirmed `past_due_at` for that renewal period.
- Provider retries do not restart or extend the seven days.
- A pending upgrade is not granted during grace. Grace preserves only the last paid level.
- If payment later succeeds, update paid coverage and clear the grace state.
- If grace expires without successful payment, commercial access ends and the effective plan falls back to valid grants or Free.
- Provider/API uncertainty must not be converted into either a cancellation or indefinite free Paid access. Ambiguous state remains ambiguous until reconciled.

BeatGaler does not implement its own retry charging schedule; payment retries belong to the billing provider.

## 6. Refunds and disputes

Refund policy is access revocation without destructive data handling.

### Full refund of the current paid period

- After the refund is confirmed, invalidate the commercial access source funded by that payment.
- Recalculate the effective plan immediately from any other valid subscription coverage, grants and Free.
- Do not delete beats, PROJECTs, Trash or other user files.
- If the resulting plan is below current usage, the account becomes over-quota under normal downgrade rules rather than losing stored data.
- The billing lifecycle must also prevent future unintended renewals when the refund is meant to end service; that provider synchronization belongs to the lifecycle implementation, not to file deletion.

### Partial refund

- A partial refund **does not revoke access by default**.
- If support intentionally agrees that a partial refund should also terminate service, that is an explicit administrative action and must be recorded separately.

### Historical refund

- A refund for an older paid period must not automatically invalidate a different currently paid period.

### Pending refund or dispute

- A requested/pending refund is not treated as completed.
- A dispute may place the commercial source into a reversible review/suspension state according to the billing lifecycle, but it must never trigger deletion of user data.
- An old payment event cannot reactivate a period whose payment was later invalidated by a confirmed refund.

## 7. Plan changes

V1 deliberately avoids immediate prorated changes between paid tiers.

### Free -> Paid Entry / Highest Paid

- Effective immediately **after payment is confirmed**.
- Redirect alone never changes the plan.

### Paid Entry <-> Highest Paid

- Schedule the change for the **next billing period**.
- The current paid tier remains effective until the current paid period ends.
- Store and expose the pending next plan and its effective date.
- The new tier is granted only when the next period is successfully paid.
- If that renewal payment fails, grace preserves the previous successfully paid tier; it does not grant a pending upgrade for free.
- Additional paid-tier changes should be blocked while the financial state is ambiguous.

### Paid -> Free

- Treat as cancellation/downgrade at period end for normal customer flows.
- Keep the paid tier through existing paid coverage, then recalculate to grants/Free.
- No destructive cleanup is part of the downgrade.

### Monthly <-> Annual

Unsupported in initial V1 because annual pricing and launch policy are still pending.

## 8. Effective-access rule

Billing V1 uses a hierarchical plan model:

`free < paid_entry < highest_paid`

The effective plan is the highest level among:

1. Free baseline.
2. Valid current commercial coverage, including valid grace for the last paid tier.
3. Active, non-revoked grants such as welcome.

Rules:

- Do not add quotas from multiple sources. A Free 20-beat allowance plus a Paid Entry grant is still the Paid Entry 100-beat plan, not 120.
- A lower grant never reduces a higher valid paid plan.
- A grant equivalent to the paid tier never shortens paid coverage.
- Expiration is evaluated at authorization time; no cron is required to flip the account exactly at midnight.

## 9. Data-retention rule across every billing transition

The following billing events change access state only:

- welcome expiration;
- cancellation;
- downgrade;
- failed renewal;
- grace expiration;
- refund;
- dispute handling;
- paid-tier change.

None of them delete library data. Destructive deletion requires a separate explicit user/admin data-lifecycle action with its own authorization and confirmation.

## 10. Out of scope for this policy task

This document does not yet:

- define provider product/price IDs or configurable offer mappings;
- create Polar products or call Polar;
- implement the access resolver;
- change `plans.js`, Auth, Account or current entitlements readers/writers;
- change PostgreSQL migrations;
- mount billing routes;
- enforce quotas on uploads or YouTube;
- modify Settings;
- modify membership, bot pools, Direct credentials, transport sessions, uploads, index behavior, Trash implementation or Desktop helper behavior.

Those are separate tasks. The next billing step is to define the configurable commercial catalog that maps these internal offers to provider products/prices without making the provider the authority for BeatGaler capabilities.
