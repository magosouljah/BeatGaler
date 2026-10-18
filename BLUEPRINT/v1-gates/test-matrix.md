# V1 final local verification matrix

`C` means the frozen commit at `prep/phase3-step15-e2e` (`git rev-parse prep/phase3-step15-e2e`); the completion report gives its literal SHA. The exact staged source trees for the diagnostic runs are retained in `tmp/v1-linux-snapshot-tree.txt` and the test logs; test assertions and disposable teardown were corrected before the final commit. The post-commit rerun binds the matrix to `C`; evidence prose changes no application or test code. The earlier isolated real Telegram PROJECT proof remains bound to `9263523e69790e4e47b685b8edbcc7d93eb5c19e`. No Sandbox or production charge, public write, or real Telegram PROJECT import was performed during this matrix.

| SUITE | COMMAND | SHA | RESULT | DURATION | FAILURES | NOTES |
| --- | --- | --- | --- | --- | --- | --- |
| TS unit | `npm run test:unit:ts` | C | PASS | 4 s | 0 | Clean Linux snapshot, 8 unit suites + 1 component suite |
| Component DOM | `npm run test:component:dom` | C | PASS | 66 s | 0 | 79 files/354 tests, zero skips |
| Integration | `npm run test:integration` | C | PASS | 27 s after observer assertion fix | 0 | 52 files/189 tests, zero skips; exact two-frame correlation |
| Direct persistent data plane | `npm run test:direct:data-plane` | C | PASS | 5 s | 0 | 7/7 Web and Desktop Telegram byte, INDEX, media and PROJECT checks; foreign pin fails closed |
| Playback transport boundary | `npm run test:playback:transport-boundary` | C | PASS | <1 s | 0 | 2/2 patched framing checks |
| Cloud unit | `npm run test:unit:cloud` | C | PASS | 5 s | 0 | Auth, session, Direct, PostgreSQL, security |
| All Cloud unit files | `node --test --test-concurrency=4 cloud-server/tests/*.test.cjs` | C | PASS | 7.6 s final staged run | 0 | 76 files/310 tests, zero skips; reconciler timer assertion stabilized |
| Regressions | `npm run test:regressions` | C | PASS | 5 s | 0 | Includes HTTP containment and Direct boundary |
| Typecheck | `npm run test:typecheck` | C | PASS | 11 s | 0 | TypeScript no emit |
| Web build | `npm run build:web` | C | PASS | 26 s | 0 | Static Web artifact; Vite chunk-size warning only |
| Chrome Web smoke | `npx wdio run wdio.web.conf.mjs` | C | PASS | 12 s | 0 | 1/1 real headless Chrome spec |
| Billing V1 | `cd cloud-server && npm run test:billing-v1` | C | PASS | 1 s | 0 | 142/142, zero skips, no charge |
| Operations/guards | `node --test ...` in `tmp/v1-final-run.sh` | C | PASS | 2 s before final sink/CLI tests | 0 | Alert conditions, preflight, post-deploy smoke, public canary; focused final checks pass |
| PostgreSQL integration | `bash scripts/v1-local-pg-integration.sh --run-disposable` | C | PASS twice after teardown fix | 24 s / 24 s | 0 | 18 files/122 tests, zero skips; random role/DB cleanup |
| Independent encrypted restore | `bash scripts/v1-local-postgres-recovery.sh --run-disposable` | C | PASS | 5 s | 0 | 18 migrations/constraints; 1 s measured local restore, no production PITR claim |
| Web/config rollback | `bash tests/v1-web-release-switch.test.sh` | C | PASS | <1 s | 0 | Disposable release/config switch and outside-target guards |
| Simulated PROJECT >2 MiB | `node scripts/step15-project-ingress-smoke.mjs --require-nginx`; two Cloud route smokes | C | PASS | 2 s total | 0 | 3,145,728 bytes; no external Telegram call |
| Public operations source | `node scripts/test-public-operations-pages.mjs` | C | PASS | <1 s | 0 | Static source checks |
| Rust library | `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | C | PASS | 79.5 s after local binary repair | 0 | Windows, 63 passed; initial 390.5 s attempt had Linux esbuild binary in Windows worktree and exited 101 |
| Cargo lock | `npm run test:cargo-lock` | C | PASS | ~1 s | 0 | 7 invariants |
| Web production dependency audit | `npm audit --omit=dev --json` | C | PASS | ~2 s | 0 | 0 vulnerabilities; clean production-only `npm ci` passed |
| Cloud production dependency audit | `cd cloud-server && npm audit --omit=dev --json` | C | PASS | ~2 s | 0 | 0 vulnerabilities |
| Root production-only install | `npm ci --omit=dev` in a disposable clean directory | C | PASS | 8 s | 0 | `patch-package` absent; postinstall skips only for omitted dev dependencies |

The first integration run failed because an existing `@fuman/io` patch makes concurrent writer calls produce two distinct WebSocket sends; the stale test expected one. The revised regression asserts both exact packet correlations. The first broad Cloud unit run exposed a test's timer-order assumption; it now waits for both reconciliation kinds and checks the resumed cursor. PostgreSQL teardown previously terminated its own test connections and produced intermittent uncaught errors; it now closes the pool and drops each disposable database without force, failing visibly if a connection leaks. Full affected suites passed again after each correction.

The Direct data-plane harness initially exposed a real Web INDEX bootstrap flaw: an empty history could create a fresh INDEX despite a pinned foreign message. The worker now fails closed when a positive pin cannot be resolved; the seven deterministic data-plane cases and the affected Web suites pass. This source change means the earlier isolated real Telegram PROJECT proof at `9263523e69790e4e47b685b8edbcc7d93eb5c19e` does not prove the final source SHA. A fresh isolated Telegram and public PROJECT hash check remain external gates.

The full root development-tool audit reports 32 findings (2 critical, 26 high, 3 moderate, 1 low); no patched `braces` release exists as of this run. This is a disclosed build/test toolchain risk, not a zero-audit claim for all dependencies. Public same-SHA, provider billing, Telegram Direct and production recovery/alert delivery are separate external gates, not silently counted as local PASS.
