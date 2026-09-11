# BeatGaler Billing V1 Commercial Catalog

Status: **Task 2 complete — catalog contract**

This document defines the server-side commercial catalog for Billing V1. It builds on `BILLING-V1-POLICY.md` and remains intentionally disconnected from the current checkout routes, Auth/Account, subscription state, entitlements, migrations, Settings, Direct, bots, transport, uploads and library operations.

Implementation: `cloud-server/billing-commercial-catalog.js`.

## 1. Authority split

BeatGaler owns:

- internal offer IDs;
- which BeatGaler plan an offer grants after confirmed payment;
- interval;
- currency;
- intended amount;
- whether an offer is sale-enabled;
- whether a business decision is still pending.

The provider owns the external product/price objects used to charge the customer.

The mapping between both is server-side configuration. Provider product/price IDs never define BeatGaler capabilities by themselves and are never accepted from the client.

## 2. V1 offers

| Internal offer | Plan | Interval | Currency | Amount minor | Sale enabled | Status |
| --- | --- | --- | --- | ---: | --- | --- |
| `paid_entry_monthly_v1` | `paid_entry` | month | USD | 699 | Yes | approved |
| `highest_paid_monthly_v1` | `highest_paid` | month | USD | 1199 | Yes | approved |
| `paid_entry_annual_v1` | `paid_entry` | year | USD | pending | No | annual price/launch pending |
| `highest_paid_annual_v1` | `highest_paid` | year | USD | pending | No | annual price/launch pending |

Free is a baseline plan, not a checkout offer.

Amounts use minor currency units. `699` means USD 6.99 and `1199` means USD 11.99.

## 3. Provider choice and environments

Billing V1 prepares the catalog for **Polar** as the primary provider.

Supported provider environments at this stage:

- `sandbox`
- `production`

A catalog instance belongs to exactly one provider environment. Sandbox and production mappings must therefore be configured separately and must never be inferred from one another.

No Polar SDK is installed by this task and no Polar API call is made.

## 4. Provider mapping

Each offer can receive one server-side provider mapping:

```js
{
  productId: 'provider_product_id',
  priceId: 'provider_price_id',
}
```

Configuration is keyed by BeatGaler internal offer ID:

```js
createCommercialCatalog({
  provider: 'polar',
  environment: 'sandbox',
  providerMappings: {
    paid_entry_monthly_v1: {
      productId: 'sandbox_product_example',
      priceId: 'sandbox_price_example',
    },
    highest_paid_monthly_v1: {
      productId: 'sandbox_product_example_2',
      priceId: 'sandbox_price_example_2',
    },
  },
});
```

The values above are examples only. This task does **not** create or approve real provider IDs.

Unknown offer keys fail closed instead of silently creating a new commercial offer.

## 5. Two independent readiness flags

An offer has two different concepts:

### `salesEnabled`

Business policy says the offer is allowed to be sold.

### `providerConfigured`

The selected provider/environment has a complete product + price mapping.

`checkoutReady` is true only when both are true.

Therefore the approved monthly offers may exist in the catalog before provider onboarding is complete, but checkout code must not use them until the external mapping is configured.

Annual offers remain `salesEnabled=false` even if someone accidentally provides provider IDs. Supplying IDs must never override the unresolved business decision.

## 6. Annual policy

The catalog deliberately models annual offers now so later work does not require inventing a second schema.

However:

- annual amount remains `null`;
- annual sales remain disabled;
- pending reason is `ANNUAL_PRICE_AND_LAUNCH_PENDING`;
- no annual CTA should be exposed;
- no fallback formula such as `monthly * 12` or an assumed discount is allowed.

Annual becomes sellable only after a separate product decision supplies the exact price and launch policy.

## 7. Currency

Initial Billing V1 commercial currency is **USD**.

The catalog stores `usd` because provider/API code conventionally uses ISO-4217 lowercase identifiers. Presentation may display `USD`.

The frontend cannot choose or override currency. Adding another currency later requires a deliberate catalog change or explicit multi-currency offer design; it must not be inferred from browser locale.

## 8. What is deliberately not in this catalog

The commercial catalog does not contain:

- plan quotas or capabilities — those belong to BeatGaler plan policy;
- welcome duration — that belongs to grant policy;
- grace/refund/cancellation logic — that belongs to lifecycle/access policy;
- provider trial days — welcome is not a provider trial;
- tax behavior — provider/Merchant-of-Record integration owns that detail;
- checkout redirect URLs;
- customer IDs;
- subscription IDs;
- secrets or API keys;
- bot/vault/transport configuration.

This keeps a commercial offer distinct from both an entitlement and a provider object.

## 9. Contract for the later checkout integration

When Task 7 eventually connects checkout:

1. Client sends an internal offer ID, never price/currency/provider IDs.
2. Server resolves the offer from this catalog.
3. Server requires `salesEnabled=true`.
4. Server requires a provider mapping for the active provider environment.
5. Server sends only the server-owned mapping to the provider adapter.
6. Checkout creation still grants no entitlement.
7. Confirmed financial state is processed later through billing state/webhooks/reconciliation.

The existing legacy checkout catalog is not the new authority and must be migrated to this contract only when the later integration task intentionally wires it.

## 10. Out of scope for Task 2

This task does not:

- create Polar products/prices;
- install or call the Polar SDK;
- alter `billing-checkout.js` runtime behavior;
- mount routes;
- grant Paid access;
- change PostgreSQL;
- implement the access resolver;
- implement persistent checkout idempotency;
- process webhooks;
- modify Auth, Account or Settings;
- modify membership, bot pool, Direct credentials, transport sessions, capabilities, uploads, index, Trash or Desktop helper behavior.

Next: Task 3 creates the pure access resolver that consumes commercial subscription coverage + grants + server time and returns the effective BeatGaler plan, capabilities and quotas.
