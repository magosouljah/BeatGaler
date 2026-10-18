# Internal observability runbook

This contract is software-only. It does not claim that an external metrics backend, paging provider, status page, retention policy, or on-call rotation exists.

The HTTP request and `/readyz` paths emit local API error spikes, auth failure spikes, PostgreSQL unavailable transitions, and PostgreSQL pool saturation through `operations-runtime.js`. HTTP 5xx responses on Direct, MASTER upload, PROJECT, INDEX publish and Polar webhook routes emit specific local conditions; three non-upload requests of at least five seconds in one minute emit a latency condition. Billing reconciliation sweep exceptions, provider configuration failures, and three consecutive paged reconciliation sweeps also emit local conditions. A migration failure signals before startup exits. `scripts/v1-temp-storage-check.mjs` is a read-only disk/stale-upload probe to schedule outside the Cloud process. Release and backup failure signals need the external deploy and backup runners. None of these log conditions pages anyone by itself. Run `node scripts/v1-observability-preflight.mjs` from the repository root to enumerate missing routes without sending alerts. Even when every route is configured, the output says `CONFIGURED_UNDELIVERED` until a real provider delivery is observed.

## Signals

Emit structured events with `structuredEvent`; secret-shaped fields are discarded. Count bounded internal events with `createMetrics`. Local tests cover the HTTP, PostgreSQL, billing, migration and temp-storage condition rules. A Cloud process cannot observe its own outage, so monitor `/healthz` and `/readyz` externally. Direct and MASTER availability without a request also need a provider-aware external probe; the route error conditions cover failed requests only. A scheduled temp probe must run under a user that can inspect the upload directory and must send its nonzero result to the configured route.

## Alert routing

`alertRoute` maps each supported condition to an explicit environment route. A missing route returns `routable=false`; callers must not claim delivery. External provider configuration and delivery verification remain operational evidence outside this module.

## Kill switches

`BEATGALER_KILL_BILLING_WRITES`, `BEATGALER_KILL_DIRECT_OPERATIONS`, and `BEATGALER_KILL_BACKGROUND_WORKERS` accept only `on` or `off`. Invalid values fail closed during configuration parsing. Before the corresponding high-impact operation, call `assertOperationEnabled`; an enabled kill switch throws `OPERATION_KILLED`.

## Incident procedure

1. Confirm `/healthz` and `/readyz` plus the dependency snapshot.
2. Identify the structured event and affected internal metric.
3. If an alert route is configured, verify delivery externally; absence of a route is a blocker, not success.
4. Use the narrowest applicable kill switch when continuing the operation risks durable corruption, incorrect billing state, or runaway background work.
5. Preserve request/correlation identifiers, exact deployment SHA, timestamps, and provider evidence. Never place tokens, passwords, cookies, authorization headers, or secrets in logs.
6. Restore the switch only after the triggering condition is resolved and readiness is healthy.

## External tails

Still required outside this software contract: metrics/tracing backend, durable error-reporting backend, retention configuration/evidence, provider alert resources and delivery proof, on-call ownership/escalation, and public status page.
