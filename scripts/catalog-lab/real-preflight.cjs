'use strict';
// E72: preflight de SOLO LECTURA (getMe, getWebhookInfo, miembros del chat). Sin escrituras en Telegram.
// Uso: BEATGALER_T11_SANDBOX_APPROVAL=<id> node scripts/catalog-lab/real-preflight.cjs <descriptor.json>
const path = require('node:path');
const fs = require('node:fs');
const S = require('../catalog-transport-sandbox.cjs');
const { createRealDeps } = require('../catalog-transport-sandbox-real.cjs');
(async () => {
  const d = S.loadDescriptor(process.argv[2], { env: process.env, execute: true });
  const out = path.resolve(__dirname, '..', '..', 'tmp', 't11b', 'preflight-e72');
  fs.mkdirSync(out, { recursive: true });
  const deps = await createRealDeps(d, { outDir: out, runId: 'preflight' });
  try {
    const facts = await S.preflight(d, deps);
    console.log('PREFLIGHT_OK', JSON.stringify(facts));
  } finally { await deps.close().catch(() => {}); }
})().catch((e) => { console.error(`PREFLIGHT_FAIL ${e.code || ''} ${String(e.message).replace(S.TOKEN_RE, '<redacted>')}`); process.exit(1); });
