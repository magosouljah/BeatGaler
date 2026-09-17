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
