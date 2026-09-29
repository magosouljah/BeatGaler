# Gates: Stage 1 real two-account stability

Scope: Diagnose the real health delay, fix only demonstrated causes, preserve state, and prove three consecutive independent real runs.

- [x] G1: Required branch and initial state recorded before edits.
  EVIDENCE: stage1/real-multi-account-e2e, HEAD 7ee4f3d321ce3cf88052dd3c11c109dd56ce8d3a; no staged files. Existing changes: protected diagnostic, Stage 1 documentation/E2E and two observer files.
- [ ] G2: Correlated browser/proxy/Cloud/handler/durability/response/abort timing locates the delay.
  EVIDENCE: Vite watcher starvation demonstrated in report 20260916T235442Z and CPU profile; residual Reload delay in report 20260917T000439Z remains unproven outside Cloud handler/flush. Full evidence in tests/e2e-web/STAGE1-STABILITY-INVESTIGATION.md.
ABANDON: G2 Full causal closure is blocked by the unexplained residual delay after the demonstrated watcher correction; further speculative product changes are not authorized.
- [x] G3: Minimal demonstrated correction and regression tests pass, or an investigated external blocker is documented.
  EVIDENCE: runtime watcher exclusion, strict health acceptance, 9/9 tests PASS; 11 files pass node --check; tsc --noEmit and git diff --check PASS. No timeout/retry/quota change.
- [ ] G4: Three separate consecutive real two-account PASS reports prove all required identity, library, Direct and Reload invariants.
  EVIDENCE: 0/3 current accepted runs. Nine separate real reports archived; final run FAIL STAGE1_HEALTH_UNSTABLE during Reload. A legacy PASS containing three aborted health probes is explicitly rejected for acceptance.
ABANDON: G4 Residual health failure remains; no blind reruns to manufacture three green reports.
- [x] G5: Final syntax/tests/diff checks and protected-file preservation verified; no merge, branch switch, seeding or state cleanup.
  EVIDENCE: Final checks PASS; branch and HEAD unchanged, staged list empty. Original protected 8943-byte prefix retains SHA256 793A8C1EE4E09412D4CC23A59BA9960D1DD896AA8426CAA9C8BD7A2B97DEFA34; live Cloud appended 3770 bytes, not edited/reverted by agent. Cloud timing uninstalled and temporary inspector closed, Cloud not restarted.

## Task 6 — Final Verification Gates

- [x] Repository state and prior Task 1–5 evidence inspected.
  EVIDENCE: Branch stage1/real-multi-account-e2e at a5fa39061d621dce9f3ff20a7f13fe73cc932533; retained Task 4, Task 5 and Task 1 download-integrity reports read before the run.
- [x] Existing final-verification support/harness identified and minimally extended only if needed.
  EVIDENCE: Added STAGE1_TASK6_FINAL_VERIFICATION to the existing real browser harness; it reuses authoritative library, runtime, observer, and strong-download helpers.
- [x] All five account-to-user-to-vault-to-transport mappings verified from authoritative state with no cross-account mapping.
  EVIDENCE: Task 6 report accounts 01–05 records five unique user/vault pairs and expected direct transport authority: Bot03, Bot02, Bot04, Bot05, Bot09.
- [x] `get_index` completed authoritatively for every vault; beats, metadata, and retained files correlated to current state and prior evidence.
  EVIDENCE: Five completed observed get_index operations; authoritative counts 9, 2, 20, 2, 2. Task 1 fixture, Task 4 playback fixtures, Task 5 recovery beat and Account 04 persisted 116/bm metadata all found in owner state.
- [x] Representative strong download validation proves the download route remains correct.
  EVIDENCE: Account 01 Task 1 fixture: WAV SHA-256 b0adef60bbf724ec53770fc3393b3b99d198b5359b72a6b8fa8f39334a584481; ZIP SHA-256 392f93b529952f8206919dbc74599f2fc1646e87a73a9038bc6eba3db60bfb8c; MP3 payload SHA-256 7efd8bdf4fcfead1f1be9bf7cdd63343484f617f5b032a7d7ef6918e6cfdacbb and expected ID3 fields passed.
- [x] Final five-vault isolation comparison found no crossed beat/file/media or visible state.
  EVIDENCE: 35 unique beat ids; foreign_references is [] in the Task 6 report.
- [x] Read-only final control-plane and health inspection captured sessions, leases, operations/index state, locks, PostgreSQL, transport status, and readyz.
  EVIDENCE: Report /readyz 200 with PostgreSQL ready; transport/status sessions=9 operations=0; post-run transport/status sessions=8 operations=0; browser-observed pending get_index=[] for all five. Direct PG counters/locks are explicitly NOT_CONFIGURED because no read-only URL was supplied.
- [x] `tmp/stage1-task-6-final-verification-report.json` written without secrets and with a supported final classification.
  CHECK: Test-Path -LiteralPath 'tmp/stage1-task-6-final-verification-report.json'
  EXPECT: True
  EVIDENCE: Present; overall PASS, task_6.classification COMPROBADO; sensitive-term scan returned no matches.
- [x] Final report and source changes rechecked against all gates and no unrelated work altered.
  EVIDENCE: node --check, git diff --check, and 8 focused observer/download tests pass; user-existing modified diagnostics and application files remain preserved and unedited by Task 6.

# Gates: Phase 2 real vault peer acquisition — patiodjuegos

Scope: Prove and fix the exact `CHANNEL_INVALID` cause for the existing patiodjuegos vault, then validate peer, index, playback, reload, and playback without changing watchdog, ping, or budgets.

- [x] P2G1: A correlated, secret-free trace proves the complete user → vault → lease bot → effective membership → Worker bot identity → channel conversion → zero-hash RPC chain.
  EVIDENCE: patiodjuegos user usr_29bf2dbc97184b1e044c259e → vault -1003994624009 → Bot01/8618989421 → channel 3994624009. Pre-fix MASTER GetParticipant returned USER_NOT_PARTICIPANT; repaired run returned ChannelParticipantAdmin. Worker getMe actual=expected=8618989421, zero-hash attempt 1 stored/resolved the peer and reached READY in 160 ms.

- [x] P2G2: The demonstrated cause of `CHANNEL_INVALID` is corrected with a deterministic readiness/identity/ID invariant rather than sleeps, blind retries, membership updates, or `getFullChat` in the hot path.
  EVIDENCE: PostgreSQL had stale ready since 2026-09-16 while Telegram said USER_NOT_PARTICIPANT. READY activation now requires same-bot Bot API getChat proof; authoritative absence performs same-bot READY→REPAIR→provision→bot-visible READY under the existing vault lock and 15 s membership budget. Transient probes fail closed without repair.

- [x] P2G3: Focused regression tests cover the failing real-account property and the successful E2E property.
  CHECK: npm test -- --runInBand tests/component-dom/webTransportWorker.test.ts
  EXPECT: /pass|passed/i
  EVIDENCE: direct persistent membership, READY-no-MASTER, provisioning primitive, startup trace (3/3), focused Worker zero-hash test, and focused Controller singleflight all PASS. Full Worker suite retains the pre-existing missing-pinned-index failure also reproduced in its baseline copy.

- [x] P2G4: Type checking and diff hygiene pass without changes to ping, watchdog, or budgets.
  CHECK: npm run typecheck
  EXPECT: /exit code 0|Done|success/i
  EVIDENCE: npm run test:typecheck, node --check for all changed Cloud JS, and git diff --check PASS. Ping, watchdog, heartbeat defaults, Worker 25 s peer deadline, and the existing 15 s Cloud membership budget were not increased or relaxed.

- [x] P2G5: A clean-browser real run for patiodjuegos proves new Worker → PEER_READY → authoritative INDEX → real beats → Play → Ctrl+R → library → Play, with no forbidden user-visible or peer errors.
  EVIDENCE: isolated Chrome profile PASS in 55.5 s. cached_hint=false; peer 160 ms; pointer 235 read with channels.getMessages and found=true; library materialized; cold Play 1967 ms; Reload library 16419 ms; post-Reload Play 997 ms. CHANNEL_INVALID, local-cache peer error, Poor connection, and Beat unavailable absent. Report: tmp/stage1-task4-single-reload-attribution.json.

- [x] P2G6: Final repository state is reported; no commit/push/destructive checkout occurred and the protected diagnostic file was not edited by this work.
  CHECK: git status -sb
  EXPECT: stage1/real-multi-account-e2e
  EVIDENCE: branch stage1/real-multi-account-e2e remains at HEAD db4b5bf5d6bd4986475190804e18a52ac74fd311, ahead 1, with no commit/push/reset/checkout. The protected diagnostic was never opened or patched; the live Cloud process continued its pre-existing runtime append behavior during the authorized real run.
