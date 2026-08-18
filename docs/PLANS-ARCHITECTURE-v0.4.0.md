# BeatGaler Plans Architecture — v0.4.0

Architecture only. Pricing, checkout, payments, real referral generation/redemption and full quota enforcement are intentionally deferred.

## Server-side authority

`cloud-server/plans.js` is the single authority for plan entitlements and marketed quotas. Desktop/Web may display this state, but sensitive operations must be authorized server-side when enforcement is implemented.

## Plans

| Capability / quota | Free | Paid Entry | Highest Paid |
|---|---:|---:|---:|
| Max beats | 20 | 100 | Unlimited* |
| Max PROJECT ZIP | 500 MB | 1 GB | 1.9 GB |
| Upload PROJECT | No | Yes | Yes |
| YouTube uploads/day | 3 | 10 | Unlimited* |
| YouTube uploads/month | 31 | 60 | Unlimited* |
| Bulk YouTube Upload | No | Limited | Full |
| Active devices | 2 | 3 | Unlimited* |
| Simultaneous sessions | 1 | 2 | 2 |
| Early Access | No | No | Yes |

`Unlimited*` is the marketed quota. Private anti-abuse hard caps may still exist for stability/security.

## Temporary access and codes

Plan ownership and temporary access are separate concepts.

- New accounts receive a 7-day Paid Entry welcome grant.
- Existing users may redeem eligible codes for temporary free days (default architecture: 3 days).
- `Time Code` and `Unlock Code` both grant temporary plan days. Unlock Code is a special/collectible distribution mechanism, not a permanent feature unlock.
- Referral reward generation/redemption is deferred, but the current policy reserves 1 rewarded referral/month for Free, 2 for Paid Entry and 5 for Highest Paid.
- Referral reward target: Free earns Paid Entry days; Paid Entry/Highest Paid earn Highest Paid days.

## Account state

Each account has:

- `basePlanId`: permanent/current paid tier (`free` by default).
- `grants[]`: temporary plan access with start/end timestamps and source.
- `effective plan`: highest currently active access level derived server-side.

This allows monthly/yearly paid subscriptions and promotional days to coexist without rewriting the permanent plan.

## API architecture

- `GET /plans/catalog`: public catalog for UI rendering.
- `GET /plans/me`: authenticated effective plan/entitlements/quotas.
- Account auth payloads also include the current effective plan snapshot.

## Client behavior

Settings includes a `Plan` section that reads server-returned plan state. It is informational in v0.4.0; checkout and plan switching are intentionally not connected yet.

## Deferred enforcement

Before release, plan-sensitive operations should use server-side authorization and quota checks. For beat-count concurrency, use a simple atomic slot reservation: reserve before upload, release on failure, commit on success.
