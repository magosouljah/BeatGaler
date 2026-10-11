# STEP 15 — isolated environment guard

Use this before starting any mutable STEP 15 Cloud/Web/Telegram test while STEP 14 is still PARTIAL. The guard is read-only: it validates names/ports/paths/config and never connects to PostgreSQL, Telegram or Polar.

Required runtime identity:

- `STEP15_RUN_ID`: starts with `step15-` or `step15_`.
- `STEP15_CLOUD_PORT` and `STEP15_WEB_PORT`: dedicated and distinct. Known Stage1/STEP14 ports `4000`, `4011`, `4013`, `1421` are reserved by default; add any other live ports through `STEP15_RESERVED_PORTS`.
- `STEP15_DATABASE_URL`: dedicated PostgreSQL database whose database name contains `step15` and does not identify Billing/Polar/STEP14 state.
- `STEP15_TEMP_DIR` and `STEP15_RUN_DIR`: both include the run ID and must not point into `.billing-e2e` or `.env.stage1` state.
- `BEATGALER_PROJECT_UPLOAD_TEMP_DIR` exactly equals `STEP15_TEMP_DIR`.
- `BEATGALER_HTTP_REQUEST_TIMEOUT_MS=1800000` and `BEATGALER_HTTP_SOCKET_TIMEOUT_MS=1800000`.
- Explicit PROJECT admission values. The prepared conservative baseline is one concurrent upload and `2000000000` temporary bytes.
- A STEP15 shell must not inherit `BILLING_E2E_*`, `STAGE1_COHORT_ID` or `STAGE1_COHORT_PASSWORD`.

Example local shape (use a real isolated PostgreSQL URL; do not paste secrets into evidence):

```powershell
$env:STEP15_RUN_ID = 'step15-local-a1'
$env:STEP15_CLOUD_PORT = '4150'
$env:STEP15_WEB_PORT = '4151'
$env:STEP15_DATABASE_URL = '<dedicated postgres URL with a step15 database name>'
$env:STEP15_TEMP_DIR = '/tmp/step15-local-a1/uploads'
$env:STEP15_RUN_DIR = '/tmp/step15-local-a1/evidence'
$env:STEP15_CLOUD_URL = 'http://127.0.0.1:4150'
$env:BEATGALER_PROJECT_UPLOAD_TEMP_DIR = $env:STEP15_TEMP_DIR
$env:BEATGALER_HTTP_REQUEST_TIMEOUT_MS = '1800000'
$env:BEATGALER_HTTP_SOCKET_TIMEOUT_MS = '1800000'
$env:BEATGALER_PROJECT_UPLOAD_MAX_CONCURRENT = '1'
$env:BEATGALER_PROJECT_UPLOAD_TEMP_BUDGET_BYTES = '2000000000'
node scripts/step15-isolated-env-guard.mjs
```

A PASS proves only that the proposed environment is separated by the checked identifiers. It does not prove the database is empty, the Telegram vaults are disposable, or STEP 14 is closed; those remain explicit runtime checks before external mutations.
