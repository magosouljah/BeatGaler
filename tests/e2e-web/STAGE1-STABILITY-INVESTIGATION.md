# Stage 1 stability investigation — blocker, not acceptance

Branch: `stage1/real-multi-account-e2e`. HEAD:
`7ee4f3d321ce3cf88052dd3c11c109dd56ce8d3a`. No merge, commit, branch switch,
seeding, quota change or backend state cleanup was performed. All real runs used
`node scripts/run-stage1-real-multi-account-e2e.mjs --accounts 2`.

## Demonstrated cause and correction

In the 23:53:47–23:54:42 UTC run, both login probes expired before Vite's HTTP
request callback ran. Account 02 aborted at 1501 ms and reached the proxy after
2049 ms; Account 01 aborted at 1505 ms and reached the proxy after 2113 ms.
Neither reached Cloud. Vite loop gaps of 1362/1116 ms and 927/1369 ms respectively
overlapped these probe lifetimes. This directly locates that failure before Cloud.

The subsequent Vite CPU profile identifies native `FSWatcher.start` called through
Chokidar `_handleDir` / `_handleFile` and `fs.watch` as the dominant work (about
34.25 seconds of sampled self time in `start`). File inventory found 48,414 files
under the ignored-by-git but previously watched `runtime` tree. Git's ignore list
does not prevent this Vite watcher workload. The existing watch exclusions covered
`src-tauri`, `.vs` and `node_modules`, but not packaged `runtime` artifacts.

The only application-tooling behavior change is adding `**/runtime/**` to Vite's
watch exclusions. No files in that tree were removed. The health timeout remains
1500 ms. This fixes a demonstrated contributor, not every observed failure.

Evidence (local, ignored `tmp`):

- `stage1-real-multi-account-report-20260916T235442Z.json`
- `stage1-timing-analysis-fail6.json`
- `stage1-proxy-timing-stable.jsonl` (correlation IDs and exact loop intervals)
- `stage1-vite.cpuprofile` and `profile-summary.mjs`
- `stage1-cloud-timing-stable.jsonl`

## Residual blocker and last real experiment

The corrected configuration was run with a stricter health criterion at
00:03:28.541–00:04:39.015 UTC on September 17. Final result: **FAIL**, category
**A — Cloud availability during Reload**, code `STAGE1_HEALTH_UNSTABLE`.
The UI/library/Direct/identity checks completed, but Account 01 had three aborted
health probes at 1504, 1510 and 1500 ms. Therefore the real consecutive acceptance
count is **0/3**, regardless of recovered UI state.

For trace `ec8f80d6-3344-4180-8787-81cea1c7a9e8:1`:

- browser to Vite: 55 ms;
- proxy request event: +84 ms from browser start;
- proxy TCP connect and request finish: +132 ms;
- browser AbortController signal: +1503 ms by epoch timestamps (1504 ms monotonic
  fetch duration after rounding);
- upstream request closed after the browser abort, with no proxy response event;
- once Cloud dispatched the request, total processing/finish took 5.147 ms;
- handler took 2.869 ms; `runtime.flush()` took 0.104 ms;
- overlapping Vite loop gaps were about 111 and 109 ms, not a continuous 1500 ms
  stall. They do not explain the entire remaining wait.

The second probe reached Vite after 1486 ms; the third never reached it. Browser
Resource Timing zeroes request/response timing fields for these aborted fetches;
those zeroes must not be interpreted as proof that nothing was transmitted.

What remains unproven: the division of the remaining delay between browser socket
queueing, Windows↔WSL relay/network scheduling, and Cloud scheduling before the
HTTP request callback. The separate Windows and WSL clocks drifted; subtracting
their epoch values would invent a one-way timing conclusion. Short Cloud handler
and flush durations exclude those intervals for these probes, but do not exclude
delay before Cloud dispatch.

Evidence:

- `tmp/stage1-real-multi-account-report-20260917T000439Z.json`
- `tmp/stage1-timing-analysis-fixed2-fail.json`
- the matching records in proxy and Cloud JSONL traces;
- `tmp/stage1-cloud.cpuprofile` and `tmp/stage1-cloud-loop.jsonl` from the earlier
  targeted Cloud profiling experiment (not the final corrected run).

The last supplementary experiment made 60 real health requests from Windows and
60 within WSL, in two concurrent lanes per environment, without auth/state writes.
Maximum completion was 34.642 ms on Windows and 29.293 ms in WSL. This did not
reproduce the load-dependent residual delay and does not establish that the relay
is the cause. Artifacts: `tmp/stage1-loopback-windows.json`,
`tmp/stage1-loopback-wsl.json`, `tmp/stage1-loopback-probe.mjs`.

Next minimum experiment: one two-account run with the corrected watcher and strict
health validation, adding Cloud socket-connection/first-data timing and a Cloud
monotonic event-loop trace for that exact run. Correlate these with the existing
proxy connect/finish events; capture browser socket scheduling metadata if the
gap remains before Vite. Do not capture HTTP payloads or credential headers.
Do not change timeouts, retries or state without demonstrating the remaining cause.

## Harness correction and run record

The older harness could report PASS after a probe timed out and the UI recovered.
The 23:50:46 run is concrete evidence: its saved report says PASS but contains
three aborted Reload probes. New validation rejects these and also requires an
observed successful health response in login and Reload for each account.
Report v4 stores explicit before/after user, Web client, vault, transport and
expected temporary-auth bot identity. Existing real Direct/library assertions
remain intact.

All files below are under `tmp/`; timestamps are UTC and identify distinct runs:

1. `stage1-real-multi-account-report-20260916-232649-diagnostic-invalidated.json`:
   FAIL during Reload. Diagnostic development restarted Vite during the run;
   category H, excluded from acceptance and causal confirmation.
2. `stage1-real-multi-account-report-20260916T232929Z.json`: PASS; zero aborted
   health probes, max completed health 564 ms; Reload 24,423 ms.
3. `stage1-real-multi-account-report-20260916T233059Z.json`: FAIL A; Account 01
   login health aborted at 1502 ms; browser→proxy 1085 ms; Cloud 4.605 ms,
   flush 0.121 ms. No login sent for that account.
4. `stage1-real-multi-account-report-20260916T233444Z.json`: PASS; zero aborted
   health probes, max completed health 675 ms; Reload 28,101 ms.
5. `stage1-real-multi-account-report-20260916T235301Z.json`: legacy harness PASS,
   **rejected for acceptance**: three aborted health probes; Reload 34,677 ms.
6. `stage1-real-multi-account-report-20260916T235442Z.json`: FAIL A; both login
   probes aborted before Vite dispatch; demonstrated watcher starvation above.
7. `stage1-real-multi-account-report-20260916T235810Z.json`: strict FAIL A;
   recovered UI but an aborted Reload probe. Vite/Cloud profiling was enabled.
8. `stage1-real-multi-account-report-20260917T000208Z.json`: FAIL before sign-in,
   zero observed health requests. An overlapping watcher regression test created
   another Vite server with a shared dependency cache. Exact browser failure was
   not captured; classify H/I, not the original health failure. The test now uses
   its own cache and runs before, not during, E2E validation.
9. `stage1-real-multi-account-report-20260917T000439Z.json`: strict FAIL A after
   the watcher correction; residual blocker detailed above.

No three consecutive accepted PASS runs exist. Earlier PASS reports were not
rewritten to conceal failures or retroactively change their recorded outcomes.

## Tests, state preservation and limits

Nine local tests cover pre-document capture, navigation persistence, account
isolation, secret exclusion, preserved health request options, exact abort-signal
timestamps, numeric Resource Timing, Cloud flush/handler ordering and uninstall,
strict health acceptance, and Vite's actual watcher ignore matcher permitting
`src` while excluding packaged runtime paths. Watcher tests use their own cache;
they do not mutate the application's dependency cache or account state.

No Cloud product file was edited. Live Cloud diagnostic wrappers were removed
without restarting Cloud. Auth accounts, installation bindings, PostgreSQL,
transport assignments and residual state were not manually altered or deleted.
The original modified `cloud-server/diagnostics/telegram-direct-control.txt` was
not edited, reverted or staged. Cloud itself appended diagnostic lines during the
real runs. Its original 8,943-byte prefix still hashes to
`793A8C1EE4E09412D4CC23A59BA9960D1DD896AA8426CAA9C8BD7A2B97DEFA34`.
Do not require its whole-file hash to remain constant while the live Cloud writes.

The new timing tools emit metadata only. Optional live inspector diagnostics use
internal Node/Express surfaces and should remain opt-in. The regression uses
Vite's bundled Chokidar matcher, so a Vite upgrade may require adapting the test.
Playback, upload, downloads, Trash and four-account scaling remain NOT_TESTED.

Final validation: 9/9 local tests passed; `node --check` passed for all 11 modified
or new JS/TS executable files; `npm run test:typecheck` and `git diff --check`
passed. The temporary local inspector was closed after diagnostic removal.
Final protected file size was 12,713 bytes: 8,943 original bytes plus 3,770 bytes
appended by Cloud. The original prefix hash was checked again at completion.

Final `git status --short` (no staged files):

```text
 M cloud-server/diagnostics/telegram-direct-control.txt
 M tests/e2e-web/STAGE1-REAL-MULTI-ACCOUNT.md
 M tests/e2e-web/stage1-real-multi-account.e2e.mjs
 M vite.config.ts
?? GATES.md
?? scripts/stage1-cloud-timing.cjs
?? scripts/stage1-install-live-timing.mjs
?? scripts/stage1-proxy-timing.mjs
?? tests/e2e-web/STAGE1-STABILITY-INVESTIGATION.md
?? tests/e2e-web/stage1-auth-observer.mjs
?? tests/e2e-web/stage1-auth-observer.test.mjs
?? tests/e2e-web/stage1-cloud-timing.test.cjs
?? tests/e2e-web/stage1-health-validation.mjs
?? tests/e2e-web/stage1-health-validation.test.mjs
?? tests/e2e-web/stage1-vite-watch.test.mjs
```

The protected diagnostic is explicitly outside this work. The Stage 1 E2E,
original documentation and two observer files already had local work at entry;
those changes were preserved and extended. The remaining listed files were added
or changed during this investigation. No commit was made.
