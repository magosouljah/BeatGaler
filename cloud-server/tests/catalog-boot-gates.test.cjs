'use strict';

// Caracterización (M4.1a) de las compuertas de arranque del catálogo en el server.js REAL (proceso hijo, modo JSON, sin PostgreSQL).
// Fija HOY qué hace el arranque en cada combinación, para que M4.1 (ensamblado) no cambie ninguna compuerta.
// Cubre G-b (Direct en producción sin G2), G-a sin PG, la guarda propia del gateway (G-c en producción) y G-e (línea de estado).
// Producción se simula con BEATGALER_DEPLOYMENT_ENV=production (lo acepta directProd y evita las guardas de NODE_ENV=production).
const test = require('node:test');
const assert = require('node:assert/strict');
const { bootCloud } = require('./helpers/boot-gates.cjs');

const DIRECT = { BEATGALER_CATALOG_DIRECT_ENABLED: 'true' };
const PROD = { BEATGALER_DEPLOYMENT_ENV: 'production' };
const GATE_B = 'STOP-GATE: BEATGALER_CATALOG_DIRECT_ENABLED=true in production requires proven G2 or owner-accepted unrotated-bot risk; refusing to start.';
const GATE_A_NO_PG = 'STOP-GATE: reused bot risk acceptance requires an enabled native PostgreSQL authority';
const GATE_GW_PROD = 'STOP-GATE: BEATGALER_CATALOG_GATEWAY_ENABLED=true in production requires proven G2 or explicitly accepted reused-bot risk; refusing to start.';
const OFF_LINE = '[catalog] native=not-mounted cursor-keys=n/a gateway=none journal=none';

function assertRefused(result, message) {
  assert.equal(result.listening, false, `El Cloud no debe llegar a listen.\n${result.output.slice(-1500)}`);
  assert.equal(result.failureMessage, message);
  assert.notEqual(result.exitCode, 0);
}

test('todo apagado: arranca y la línea de estado refleja native=not-mounted gateway=none journal=none (G-e)', async () => {
  const r = await bootCloud({});
  assert.equal(r.listening, true, r.output.slice(-1500));
  assert.equal(r.failureMessage, null);
  assert.equal(r.catalogLine, OFF_LINE);
});

test('G-b: Direct en producción sin G2 ni riesgo aceptado -> STOP-GATE y no arranca', async () => {
  assertRefused(await bootCloud({ ...PROD, ...DIRECT }), GATE_B);
});

test('G-b: BEATGALER_CATALOG_G2_APPROVED=true en producción deja pasar la compuerta', async () => {
  const r = await bootCloud({ ...PROD, ...DIRECT, BEATGALER_CATALOG_G2_APPROVED: 'true' });
  assert.equal(r.failureMessage, null, r.output.slice(-1500));
  assert.equal(r.listening, true);
  assert.equal(r.catalogLine, OFF_LINE);
});

test('G-b: Direct sin producción no exige G2', async () => {
  const r = await bootCloud({ ...DIRECT });
  assert.equal(r.failureMessage, null, r.output.slice(-1500));
  assert.equal(r.listening, true);
});

test('G-b: producción con la marca G2 distinta de "true" sigue cerrada', async () => {
  assertRefused(await bootCloud({ ...PROD, ...DIRECT, BEATGALER_CATALOG_G2_APPROVED: 'yes' }), GATE_B);
});

test('G-b: producción sin el flag Direct arranca sin G2', async () => {
  const r = await bootCloud({ ...PROD });
  assert.equal(r.failureMessage, null, r.output.slice(-1500));
  assert.equal(r.listening, true);
});

test('G-a sin PostgreSQL: riesgo aceptado exige autoridad nativa PG -> STOP-GATE', async () => {
  assertRefused(await bootCloud({ BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED: 'true' }), GATE_A_NO_PG);
});

test('G-a sin PostgreSQL: se evalúa antes que G-b (el riesgo aceptado no abre la compuerta Direct)', async () => {
  assertRefused(await bootCloud({ ...PROD, ...DIRECT, BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED: 'true' }), GATE_A_NO_PG);
});

test('G-c: gateway real en producción sin G2 ni riesgo aceptado -> STOP-GATE (guarda propia del gateway)', async () => {
  // Sin PG la guarda del gateway ocurre antes de exigir PostgreSQL; el mensaje fija cuál responde hoy.
  assertRefused(await bootCloud({ ...PROD, BEATGALER_CATALOG_GATEWAY_ENABLED: 'true' }), GATE_GW_PROD);
});

test('G-c: gateway encendido fuera de producción sin PG -> STOP-ENV (nunca se monta sin plano PostgreSQL)', async () => {
  assertRefused(await bootCloud({ BEATGALER_CATALOG_GATEWAY_ENABLED: 'true' }),
    'STOP-ENV: the catalog gateway requires the PostgreSQL control plane');
});

test('G-d/G-e: el journal en disco solo se refleja cuando se configura el directorio', async () => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-journal-'));
  try {
    const r = await bootCloud({ BEATGALER_CATALOG_JOURNAL_DIR: dir });
    assert.equal(r.failureMessage, null, r.output.slice(-1500));
    assert.equal(r.catalogLine, '[catalog] native=not-mounted cursor-keys=n/a gateway=none journal=file');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
