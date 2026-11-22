'use strict';

// Caracterización (M4.1a) de las compuertas de arranque G-a/G-c/G-d/G-e contra PostgreSQL EFÍMERO (solo lo ejecuta CI:
// `node scripts/run-cloud-tests.mjs --integration`, que crea la base, fija DATABASE_URL y verifica el centinela de la instancia).
// Arranca el server.js REAL en un proceso hijo con autoridad PostgreSQL (marca de cutover READY sembrada) y observa cómo termina el arranque.
// G-c/G-d: el arranque con autoridad nativa SIN gateway y SIN journal deja `gateway=none journal=none`; el comportamiento de purge/transferencias
// con gateway=null / journal=null lo cubren catalog-purge.integration.cjs (JOURNAL_UNAVAILABLE) y catalog-transport-gateway.test.cjs (módulos).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { bootCloud } = require('./helpers/boot-gates.cjs');

const { Pool } = require(path.join(__dirname, '..', 'node_modules', 'pg'));
const { applyMigrations } = require('../postgres-migrations');

const DATABASE_URL = process.env.DATABASE_URL || '';
const PG_ALLOW = process.env.BEATGALER_TEST_PG_ALLOW || '';
assert.ok(DATABASE_URL && PG_ALLOW, 'Requiere la base efímera del runner (DATABASE_URL y BEATGALER_TEST_PG_ALLOW).');
assert.ok(['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(DATABASE_URL).hostname), 'Solo PostgreSQL efímero en loopback.');

const SNAPSHOT = crypto.createHash('sha256').update('boot-gates-snapshot').digest('hex');
const MANIFEST = crypto.createHash('sha256').update('boot-gates-manifest').digest('hex');
const PG_ENV = {
  BEATGALER_POSTGRES_ENABLED: 'true',
  DATABASE_URL,
  BEATGALER_POSTGRES_SSL_MODE: 'disable',
  BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres',
  BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: SNAPSHOT,
  BEATGALER_SECRET_ENVELOPE_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
};
const NATIVE = { ...PG_ENV, BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const RISK = { BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED: 'true' };
const GATE_NATIVE = 'STOP-GATE: reused bot risk acceptance requires an enabled native PostgreSQL authority';
const GATE_ROW = 'STOP-GATE: reused bot risk acceptance requires REUSED_UNROTATED SQL activation';

let pool;
async function setActivation(exposure) {
  await pool.query('DELETE FROM catalog_native_activation');
  if (!exposure) return;
  await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
  await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory)
    VALUES ('boot-gates', 'run-1', '["Bot20"]', $1, $2, '[]')`, [exposure, MANIFEST]);
}
const boot = (env) => bootCloud(env, { pgAllow: PG_ALLOW, timeoutMs: 90_000 });
function assertRefused(r, message) {
  assert.equal(r.listening, false, r.output.slice(-1500));
  assert.equal(r.failureMessage, message, r.output.slice(-1500));
  assert.notEqual(r.exitCode, 0);
}

test.before(async () => {
  pool = new Pool({ connectionString: DATABASE_URL, max: 2, ssl: false });
  await applyMigrations(pool);
  await pool.query(`INSERT INTO control_plane_cutovers(id, snapshot_sha256, state) VALUES ('legacy-json-v1', $1, 'READY')
    ON CONFLICT (id) DO UPDATE SET snapshot_sha256 = EXCLUDED.snapshot_sha256, state = 'READY'`, [SNAPSHOT]);
});
test.after(async () => { await pool?.end(); });

test('G-a: riesgo aceptado con PG pero sin flag nativo -> STOP-GATE', async () => {
  await setActivation('REUSED_UNROTATED');
  assertRefused(await boot({ ...PG_ENV, ...RISK }), GATE_NATIVE);
});

test('G-a: riesgo aceptado sin fila catalog_native_activation -> STOP-GATE', async () => {
  await setActivation(null);
  assertRefused(await boot({ ...NATIVE, ...RISK }), GATE_ROW);
});

for (const exposure of ['ROTATED', 'FRESH_BOTS']) {
  test(`G-a: riesgo aceptado con fila ${exposure} (no REUSED_UNROTATED) -> STOP-GATE`, async () => {
    await setActivation(exposure);
    assertRefused(await boot({ ...NATIVE, ...RISK }), GATE_ROW);
  });
}

test('G-a/G-c/G-d/G-e: con fila REUSED_UNROTATED la compuerta pasa, avisa, y el arranque nativo queda sin gateway ni journal', async () => {
  await setActivation('REUSED_UNROTATED');
  const r = await boot({ ...NATIVE, ...RISK });
  assert.doesNotMatch(r.output, /STOP-GATE/, r.output.slice(-1500));
  assert.match(r.output, /\[catalog\] OWNER_RISK_ACCEPTED: unrotated Telegram tokens reused; G2 NOT_PROVEN; E8 residual risk/);
  assert.match(r.catalogLine || '', /^\[catalog\] native=enabled cursor-keys=\S+ gateway=none journal=none$/, r.output.slice(-1500));
});

test('G-e: nativo habilitado sin riesgo aceptado no exige fila REUSED y no monta gateway ni journal', async () => {
  await setActivation('FRESH_BOTS');
  const r = await boot({ ...NATIVE });
  assert.doesNotMatch(r.output, /STOP-GATE|OWNER_RISK_ACCEPTED/, r.output.slice(-1500));
  assert.match(r.catalogLine || '', /^\[catalog\] native=enabled cursor-keys=\S+ gateway=none journal=none$/, r.output.slice(-1500));
});
