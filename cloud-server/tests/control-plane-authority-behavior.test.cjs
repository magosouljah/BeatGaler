'use strict';
// Caracterizacion (M7.6b-b0) de la seleccion de autoridad del plano de control: control-plane-authority.js +
// prepareControlPlaneCutover (rama json con pool falso; modo postgres solo hasta sus rechazos tempranos). Sin PG real.
// M7.6b-b2 (D17): sin PG => json por defecto; con PG la variable es obligatoria y json se rechaza; json nunca en produccion;
// el rollback a JSON (ROLLED_BACK + BEATGALER_JSON_ROLLBACK_EXPORT_SHA256) ya no existe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-authority-state-'));
process.env.BEATGALER_STATE_DIR = stateDir; // vacio: el arranque json usa los snapshots por defecto
const { controlPlaneAuthorityConfig } = require('../control-plane-authority.js');
const { prepareControlPlaneCutover } = require('../control-plane-cutover-runtime.js');

const SNAP = 'b'.repeat(64);

function fakePool({ marker, activations = 0, libraries = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(String(sql));
      if (/catalog_native_activation/.test(sql)) return { rows: [{ activations, libraries }] };
      if (/control_plane_cutovers/.test(sql)) return { rows: marker ? [marker] : [] };
      throw new Error(`unexpected SQL in fake pool: ${sql}`);
    },
  };
}
const prepare = (env, pool) => prepareControlPlaneCutover({ pool, env });
const NO_DEFAULT = /requires BEATGALER_CONTROL_PLANE_AUTHORITY=postgres/;
const JSON_WITH_PG = /JSON control-plane authority is not allowed/;

(async () => {
  // 1. Valor por defecto: sin variable de autoridad y sin PG => json. b2: con PG configurado => error (antes json).
  assert.equal(controlPlaneAuthorityConfig({}).authority, 'json');
  assert.throws(() => controlPlaneAuthorityConfig({ BEATGALER_POSTGRES_ENABLED: 'true' }), NO_DEFAULT);

  // 2. json explicito sin pool: no consulta nada y no hay runtime. b2: el campo rollbackSha256 desaparece.
  const noPool = await prepare({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'json' }, null);
  assert.equal(noPool.authority, 'json');
  assert.equal(noPool.runtime, null);
  assert.deepEqual(Object.keys(noPool).sort(), ['authority', 'runtime']);

  // 3. postgres sin snapshot SHA => rechazo de configuracion; sin pool => rechazo de arranque.
  assert.throws(() => controlPlaneAuthorityConfig({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres', BEATGALER_POSTGRES_ENABLED: 'true' }), /CUTOVER_SNAPSHOT_SHA256/);
  await assert.rejects(prepare({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres', BEATGALER_POSTGRES_ENABLED: 'true' }, fakePool()), /CUTOVER_SNAPSHOT_SHA256/);
  await assert.rejects(prepare({
    BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres',
    BEATGALER_POSTGRES_ENABLED: 'true',
    BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: SNAP,
  }, null), /requires an initialized PostgreSQL pool/);

  // 4. b2: PG configurado SIN variable de autoridad => el arranque se niega antes de tocar SQL (antes arrancaba en json).
  const pgEnv = { BEATGALER_POSTGRES_ENABLED: 'true' };
  const noMarkerPool = fakePool();
  await assert.rejects(prepare(pgEnv, noMarkerPool), NO_DEFAULT);
  assert.deepEqual(noMarkerPool.calls, [], 'no consulta SQL');

  // 5. b2: con marcador READY el rechazo llega antes, por configuracion (sin variable o json explicito + PG).
  const ready = fakePool({ marker: { state: 'READY', rollback_export_sha256: null } });
  await assert.rejects(prepare(pgEnv, ready), NO_DEFAULT);
  await assert.rejects(prepare({ ...pgEnv, BEATGALER_CONTROL_PLANE_AUTHORITY: 'json' }, ready), JSON_WITH_PG);
  assert.deepEqual(ready.calls, []);

  // 6. b2: el rollback a JSON ya no existe. ROLLED_BACK + SHA correcto ya no arranca en json; la variable de rollback
  //    se ignora (ni habilita json con PG ni bloquea postgres).
  const rolled = fakePool({ marker: { state: 'ROLLED_BACK', rollback_export_sha256: SNAP } });
  await assert.rejects(prepare({ ...pgEnv, BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: SNAP }, rolled), NO_DEFAULT);
  await assert.rejects(prepare({ ...pgEnv, BEATGALER_CONTROL_PLANE_AUTHORITY: 'json', BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: SNAP }, rolled), JSON_WITH_PG);
  assert.deepEqual(rolled.calls, []);
  assert.equal(controlPlaneAuthorityConfig({
    BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres', BEATGALER_POSTGRES_ENABLED: 'true',
    BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: SNAP, BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: SNAP,
  }).authority, 'postgres');

  // 7. json + pool con activacion nativa o bibliotecas: b2 => rechazo por configuracion, sin consulta SQL.
  //    json explicito sin PG configurado: el pool (inexistente en server.js) se ignora y no se consulta.
  const native = fakePool({ activations: 1 });
  await assert.rejects(prepare(pgEnv, native), NO_DEFAULT);
  await assert.rejects(prepare({ ...pgEnv, BEATGALER_CONTROL_PLANE_AUTHORITY: 'json' }, fakePool({ libraries: 2 })), JSON_WITH_PG);
  assert.equal(native.calls.length, 0);
  const strayPool = fakePool({ activations: 1 });
  assert.equal((await prepare({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'json' }, strayPool)).runtime, null);
  assert.deepEqual(strayPool.calls, []);

  // 8. b2: la variable de rollback sola ya no exige PG (se ignora). Valor desconocido => rechazo (intacto).
  assert.equal(controlPlaneAuthorityConfig({ BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: SNAP }).authority, 'json');
  assert.throws(() => controlPlaneAuthorityConfig({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'dual' }), /json or postgres/);

  // 9. b2: json nunca con NODE_ENV=production (por defecto o explicito).
  await assert.rejects(prepare({ NODE_ENV: 'production' }, null), /forbidden with NODE_ENV=production/);
  await assert.rejects(prepare({ NODE_ENV: 'production', BEATGALER_CONTROL_PLANE_AUTHORITY: 'json' }, null), /forbidden with NODE_ENV=production/);

  // 10. Revision L3: el modo postgres solo acepta el marcador READY (antes cubierto por el tramo rollback de la integracion).
  const { assertCutoverReady } = require('../postgres-control-plane-runtime.js');
  for (const state of ['ROLLED_BACK', 'WEIRD']) {
    await assert.rejects(assertCutoverReady(fakePool({ marker: { snapshot_sha256: SNAP, state } }), SNAP),
      new RegExp(`PostgreSQL cutover marker is ${state}; authority switch is refused`));
  }
  await assert.rejects(assertCutoverReady(fakePool(), SNAP), /marker is missing/);
  assert.equal((await assertCutoverReady(fakePool({ marker: { snapshot_sha256: SNAP, state: 'READY' } }), SNAP)).state, 'READY');

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('PASS control-plane authority behavior: json solo sin PG y fuera de produccion, PG exige variable, sin rollback a JSON');
})().catch((e) => { console.error(e); process.exit(1); });
