# Billing V1 — Polar sandbox compatibility

Verified: 2026-09-11

This document closes the compatibility matrix required before the Polar sandbox adapter is treated as implemented. It describes the exact contract BeatGaler tests and the operational boundary that remains outside source control.

## Fixed runtime contract

| Area | BeatGaler contract | Evidence / behavior |
| --- | --- | --- |
| Node | 22.23.2 in Billing CI | `billing-v1-policy.yml` installs the locked Cloud dependency tree on Node 22.23.2. |
| Polar SDK | `@polar-sh/sdk@1.0.0-alpha.20` exactly | Exact version in `cloud-server/package.json` and `package-lock.json`; no `latest`, `next`, caret or tilde. |
| Polar API | `2026-04` | Adapter imports `@polar-sh/sdk/2026-04` and passes `version: '2026-04'`. |
| Environment | `sandbox` only | Adapter always creates the client with `environment: 'sandbox'`. No environment value is accepted from callers. |
| Module loading | CommonJS + ESM | Contract tests load the exact versioned SDK entry with both `require()` and dynamic `import()`. |
| Webhook verification | SDK `webhooks.validateEvent()` on raw body | Adapter accepts only unmodified string/Buffer/Uint8Array and fails closed on signature error. |
| Webhook secret compatibility | legacy literal secret + current `whsec_` key form | Contract tests exercise both schemes against the real installed SDK. |
| Provider errors | typed BeatGaler errors | Configuration and provider/request failures surface as `PolarSandboxConfigError` / `PolarSandboxAdapterError` with stable codes. |

## Credential boundary

Only these sandbox names are accepted by the adapter:

- `POLAR_SANDBOX_ACCESS_TOKEN`
- `POLAR_SANDBOX_WEBHOOK_SECRET`
- `POLAR_SANDBOX_ORGANIZATION_ID`
- `POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRODUCT_ID`
- `POLAR_SANDBOX_PAID_ENTRY_MONTHLY_PRICE_ID`
- `POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRODUCT_ID`
- `POLAR_SANDBOX_HIGHEST_PAID_MONTHLY_PRICE_ID`

The adapter does not read generic `POLAR_ACCESS_TOKEN`, live/production credentials, product IDs supplied by the frontend or price IDs supplied by the frontend.

Secrets are server-side only. The manual GitHub Actions smoke receives them through repository Actions secrets and does not commit or print them intentionally.

## Commercial mapping owned by BeatGaler

BeatGaler owns the offer identity and expected commercial values. Polar owns the provider Product/Price objects.

Before creating checkout, the adapter retrieves the configured Polar Product and rejects the operation unless the provider data matches BeatGaler:

| Offer | Plan | Interval | Currency | Amount |
| --- | --- | --- | --- | ---: |
| `paid_entry_monthly_v1` | `paid_entry` | month × 1 | USD | 699 minor units |
| `highest_paid_monthly_v1` | `highest_paid` | month × 1 | USD | 1199 minor units |

Validation also rejects an archived product, wrong organization, missing configured Price ID, non-fixed price, wrong currency, wrong amount or wrong recurring interval.

Annual offers remain intentionally unavailable for sale.

## Adapter primitives

`cloud-server/billing-polar-sandbox.js` exposes the small provider surface required by Billing V1 at this stage:

- list products;
- validate an offer mapping against Polar;
- create hosted checkout;
- create customer portal;
- fetch customer by provider ID;
- fetch customer by BeatGaler external user ID;
- fetch subscription;
- fetch payment;
- verify webhook signature.

Checkout always resolves the Product/Price server-side, sets `allow_trial: false`, and returns `entitlementGranted: false`. Redirect success is never authority for Paid access.

## Test matrix

Automated PR CI must pass all of the following from the locked dependency tree:

1. Billing commercial catalog tests.
2. Billing access resolver tests.
3. Polar sandbox adapter fake/contract tests.
4. Real installed Polar SDK CommonJS load.
5. Real installed Polar SDK ESM load.
6. Legacy literal-secret webhook validation.
7. Current `whsec_` Standard Webhooks key validation.
8. Tampered raw webhook body rejection.
9. `npm ci` from `cloud-server/package-lock.json`.

The manual workflow `Billing V1 Polar Sandbox Smoke` is the operational test for a provisioned Polar sandbox organization. It lists products, validates both monthly mappings and can create checkout/portal fixtures when the corresponding smoke variables exist.

## Operational prerequisite, not source-code work

A real Polar sandbox smoke requires credentials and provider objects that must not be invented or committed:

- Organization Access Token;
- webhook endpoint secret;
- Paid Entry monthly Product + Price;
- Highest Paid monthly Product + Price;
- optional existing sandbox customer fixture for portal validation.

Until those external objects are provisioned, CI can prove the installed SDK contract and all BeatGaler-side behavior but cannot truthfully claim a live provider transaction occurred.

## Task 6 completion boundary

For repository implementation, Task 6 is complete when this matrix and the automated tests are green: the SDK is exact, API/environment are explicit, sandbox/live credentials cannot mix through this adapter, provider IDs are server-side, checkout/portal/lookups exist, signatures are verified by the real SDK and errors fail closed.

The later Billing tasks remain separate: persistent checkout idempotency, durable webhook inbox/projection, commercial lifecycle, reconciliation and full sandbox E2E.
