# Internal observability runbook

This contract is software-only. It does not claim that an external metrics backend, paging provider, status page, retention policy, or on-call rotation exists.

## Signals

Emit structured events with `structuredEvent`; secret-shaped fields are discarded. Count bounded internal events with `createMetrics`. Recommended conditions are auth failure spikes, API 5xx spikes, PostgreSQL unavailable, billing reconciliation exceptions, provider failures, pool exhaustion, queue backlog, release failure, and backup failure.

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
