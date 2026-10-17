# Plan: BeatGaler V1 closure

Depth: tree 4. Mode: orchestrated for independent evidence audits, with integration and code fixes owned by the root agent.

## Contract

- Source of truth: current code, durable isolated A2 state, current Blueprint and plan, live issue state. Historical roadmap claims require revalidation.
- Worktree: `E:/777/app/beatvault-step15-wsl` only. Preserve the existing uncommitted account lifecycle fix/test, diagnostic append, PROJECT fixtures, `.billing-e2e`, STEP14 processes/DBs, Phase 4 worktree, production, and user data.
- Financial actions: audits are read-only. No new or duplicate charge, Polar mutation, or production cutover without the user's explicit authorization.
- File ownership: root owns STEP15 PROJECT client source/tests, `V1-CLOSURE-GATES.md`, and this plan. STEP14 audit agent owns only `BLUEPRINT/v1-gates/step14.md`. Launch audit agent owns only `BLUEPRINT/v1-gates/launch.md`. Production billing agent owns `cloud-server/billing-polar-sandbox.js`, `cloud-server/billing-polar-lifecycle-adapter.js`, `cloud-server/billing-web-runtime.js`, related new tests, and `BLUEPRINT/v1-gates/production-billing.md`. Portal agent owns `cloud-server/server-core.js`, `cloud-server/billing-web-portal-route.js`, `src/components/SettingsPanel.tsx`, related new tests/client helper, and `BLUEPRINT/v1-gates/subscriber-portal.md`. Shared existing files must not be edited without root coordination. Evidence references must be sanitized and distinguish observed behavior from design claims.
- A gate is PASS only with direct evidence for the final candidate SHA. An impossible gate keeps its checkbox open and gets an `ABANDON` line with the exact reason.

## Tree

- 1 V1 closure — `BLUEPRINT/V1-CLOSURE-GATES.md`
  - 1.1 Phase 3 financial evidence — `BLUEPRINT/v1-gates/step14.md`
  - 1.2 Phase 3 product E2E and fixes — root, gates G1/G3/G4/G7
  - 1.3 Public launch and Phase 4 audit — `BLUEPRINT/v1-gates/launch.md`
  - 1.3.1 Production Polar runtime, fail closed — `BLUEPRINT/v1-gates/production-billing.md`
  - 1.3.2 Existing subscriber portal path — `BLUEPRINT/v1-gates/subscriber-portal.md`
  - 1.4 Integration, final verification, and launch decision — root, gates G2/G5/G6/G8/G9/G10

## Status log

- 2026-10-17: Plan written after read-only classification of the single real PROJECT import attempt.
- 2026-10-17: Read-only STEP14 and launch audits completed; two disjoint launch code leaves dispatched while root revalidates PROJECT.
- 2026-10-17: Isolated >2 MiB PROJECT browser path passed with byte/hash/INDEX/DB proof after the CSRF fix. Production Polar runtime and subscriber portal code integrated without a provider mutation; Sandbox harness updates from canonical `3146cf9` were copied into this STEP15 worktree without changing canonical files. Cloud unit, source regressions, Web build, focused UI, and billing V1 142/142 pass. Production, public deployment, exact-SHA E2E, and missing natural financial cycles remain NO-GO gates.
