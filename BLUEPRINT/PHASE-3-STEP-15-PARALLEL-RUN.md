# STEP 15 — parallel run while STEP 14 remains PARTIAL

Decision recorded 10 October 2026: advance every STEP 15 activity that does not require the remaining Polar financial evidence. STEP 14 may remain PARTIAL during this work. This does **not** waive STEP 14 and does not permit declaring Phase 3 closed early.

## Allowed now

- Repository/static gates, Web build and focused tests.
- Isolated PostgreSQL suites and disposable databases.
- Nginx/Cloud PROJECT ingress, timeout, tempfile cleanup and admission controls.
- Browser/Auth/Access/library/PROJECT/Trash/downgrade/isolation preparation and execution only against a dedicated STEP 15 stack and disposable users/vaults.
- Telegram real tests only when they use fresh STEP 15 vaults/accounts and do not reuse or mutate STEP 14 state.

## Still forbidden

- Reusing `.billing-e2e`, its PostgreSQL rows, Polar objects, processes or run directories as mutable STEP 15 fixtures.
- Calling fixtures or grants financial evidence.
- Merging prep changes to canonical merely because an isolated smoke passed.
- Declaring STEP 15 PASS or Phase 3 CLOSED while required STEP 14 evidence remains unresolved.

## PROJECT operational defaults prepared before real E2E

- Exact public Nginx PROJECT route: 2g body ceiling, request buffering off, 30 minute body/proxy/send window.
- Cloud HTTP request/socket timeout supports an explicit 30 minute opt-in; default remains 30 seconds outside the isolated/public STEP 15 stack.
- Cloud owns one multer tempfile per PROJECT upload.
- Admission occurs before multipart body parsing. Default is one concurrent PROJECT upload and a 2,000,000,000-byte temporary reservation budget, enough for the 1,900,000,000-byte Highest V1 ceiling with headroom.
- Operators may raise concurrency only together with a measured temp-disk budget. Busy capacity returns `503 PROJECT_UPLOAD_BUSY` with `Retry-After`.
- Local smokes do not count as Telegram or production evidence.

## Tomorrow / final closure sequence

1. Close or explicitly resolve the remaining STEP 14 Polar Sandbox gate on its own evidence and state.
2. Freeze the exact STEP 15 candidate SHA and isolated environment identity.
3. Run Browser -> public-origin Nginx -> Cloud -> tempfile -> MASTER Telegram with a deterministic PROJECT >2 MiB, then verify receipt/INDEX/download/hash/reload and cleanup.
4. Run the remaining Free/Paid/Highest, quota, tenant isolation, Trash/purge, downgrade and failure/recovery matrix on disposable STEP 15 accounts/vaults.
5. Add the Browser checkout/Access projection cases that depend on real STEP 14 financial truth.
6. Repeat any affected cases after fixes, then record PASS/FAIL/BLOCKED/NOT_COVERED and only close Phase 3 if both STEP 14 and STEP 15 gates are satisfied.
