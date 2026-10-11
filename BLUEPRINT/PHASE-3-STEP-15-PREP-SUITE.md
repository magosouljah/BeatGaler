# STEP 15 — prep suite

This suite groups the non-mutating checks prepared while STEP 14 is still PARTIAL.

Commands:

```bash
node scripts/step15-prep-suite.mjs
node scripts/step15-prep-suite.mjs --installed
node scripts/step15-prep-suite.mjs --full
```

- default/static: read-only preflight, pure Node contracts and the Nginx ingress contract (Nginx may SKIP if unavailable).
- `--installed`: additionally requires installed Cloud dependencies and real local Nginx; runs the PROJECT HTTP route and combined Nginx->Cloud smokes.
- `--full`: everything above plus `npm run build:web`.

These modes do not intentionally connect to PostgreSQL, Telegram or Polar. A PASS is preparation evidence only, not STEP 15 E2E PASS.
