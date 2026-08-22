# BeatGaler Release Ledger

## Baseline — 2026-08-22

**Release state:** `NO-GO`

This ledger freezes the audited baseline before release work begins. It is evidence only; it does not authorize a public release or create a release tag.

### Audited sources

| Branch | Audited SHA | Observed app version | Role |
|---|---|---:|---|
| `galer-cloud-v0.7.4` | `131df88753c812c0fdf440a5558fff46b2a83f57` | `0.7.4` | Latest desktop baseline, Windows runtime, macOS portability work, Direct Cloud |
| `web-foundation-v0.1.0` | `e79728642839493326df706aba993a4cde2bdc02` | `0.7.0` | Web architecture, browser adapters, Web import/playback/edit/Trash |

### Measured audit evidence

#### Repository and integration

- Web branch: 317 tracked files; 234 text files fully read and 83 binaries inventoried.
- Cloud branch: 281 tracked files.
- Divergence from common base `d289f8c1649286376b194565710adb60e125e0f0`: 11 Web-only commits and 8 Cloud-only commits.
- Changed paths since the common base: 69 Web, 28 Cloud, 12 overlapping.
- Read-only merge simulation found textual conflicts in:
  - `src/App.tsx`
  - `src/components/Drawer.tsx`
  - `src/lib/libraryStateManager.ts`
  - `tests/integration/coreIntegration.test.tsx`

#### Build and test evidence

- Web frontend build: PASS — 118 modules.
- Web main bundle: 623.24 kB minified — size warning remains.
- Web worker bundle: 1,205.98 kB — size warning remains.
- Cloud frontend build: PASS — 101 modules.
- Cloud main bundle: 600.98 kB minified — size warning remains.
- Web audit runs reported PASS for typecheck, 8 TypeScript suites, 55 DOM tests, 9 integration tests, and 14 backend/regression tests.
- Cloud audit runs reported PASS for typecheck, 7 TypeScript suites, 7 DOM tests, 8 integration tests, and 11 backend/regression tests.

#### Dependency audit

- Production dependency graphs audited on 2026-08-22: 0 known production vulnerabilities in the four audited production graphs.
- Full tooling/development graphs across the audited branches: 24 vulnerable packages total:
  - 1 critical
  - 18 high
  - 4 moderate
  - 1 low
- This remains an open supply-chain risk until independently closed and re-verified.

### Not verified / must not be treated as PASS

- Clean Rust/native build did not receive a local verdict because the audit environment ran out of disk space.
- Current remote CI status is not frozen here as PASS without dated evidence tied to the audited SHA.
- Real Telegram transport behavior is not certified by this ledger.
- OAuth and YouTube production behavior are not certified by this ledger.
- GitHub Releases publication path is not certified by this ledger.
- Windows clean-machine installation and Authenticode signing are not certified.
- macOS clean-machine installation, Developer ID signing, notarization, Intel hardware and Apple Silicon hardware are not certified.
- Production hosting, domain/DNS ownership, backups, restore, monitoring, status page, Stripe, legal review, external security review and tester availability are not certified.

### Why the baseline is `NO-GO`

The audited branches are not yet one reproducible release line and still contain release-blocking security, data, operations, signing, legal/payment and cross-platform verification gaps. A passing frontend build or unit/integration test set does not override those release gates.

### Release rule frozen with this baseline

- No public release while any P0 or P1 gate remains open.
- No platform is considered supported until installation and critical flows pass on a clean real machine for that platform.
- No payments are accepted until reconciliation, refund and server-side entitlement behavior are demonstrated.
- No unverified external dependency is recorded as complete without dated evidence, owner and link/artifact.

### Baseline status

- [x] Audited branches and SHAs recorded.
- [x] Known test/build counts and warnings recorded.
- [x] Known dependency vulnerabilities recorded.
- [x] Unverified limits explicitly separated from PASS evidence.
- [x] Current release state recorded as `NO-GO`.
- [x] No public release tag created as part of this task.

This document is append-only release evidence. Future entries should identify the gate, exact SHA/version, environment, date/time, executor, result, evidence link/artifact and approver.