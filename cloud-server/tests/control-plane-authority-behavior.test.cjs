'use strict';
// Caracterizacion (M7.6b-b0) de la seleccion de autoridad del plano de control: control-plane-authority.js +
// prepareControlPlaneCutover (rama json con pool falso; modo postgres solo hasta sus rechazos tempranos). Sin PG real.
// Fija el comportamiento ACTUAL: sin variable => json; json + PG configurado solo arranca si no hay marcador READY.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-authority-state-'));
process.env.BEATGALER_STATE_DIR = stateDir; // vacio: el arranque json usa los snapshots por defecto
const { controlPlaneAuthorityConfig } = require('../control-plane-authority.js');
const { prepareControlPlaneCutover } = require('../control-plane-cutover-runtime.js');
const { snapshotManifest } = require('../legacy-import-plan.js');
const { ACCOUNTS_FILE_NAME } = require('../auth-helpers');

const SNAP = 'b'.repeat(64);
const DEFAULT_AUTH = JSON.stringify({ users: [], sessions: {} });
const DEFAULT_PERSISTENT = JSON.stringify({ linkedAccounts: {}, uploadedFiles: {}, beatTopics: {}, pendingTopicDeletes: {}, messageRedirects: {} });
const DEFAULT_SHA = snapshotManifest({ [ACCOUNTS_FILE_NAME]: DEFAULT_AUTH, 'cloud-data.json': DEFAULT_PERSISTENT }).manifest_sha256;

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

(async () => {
  // 1. Valor por defecto: sin variable de autoridad => json (con y sin PG configurado).
  assert.equal(controlPlaneAuthorityConfig({}).authority, 'json');
  assert.equal(controlPlaneAuthorityConfig({ BEATGALER_POSTGRES_ENABLED: 'true' }).authority, 'json');

  // 2. json explicito sin pool: no consulta nada y no hay runtime.
  const noPool = await prepare({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'json' }, null);
  assert.equal(noPool.authority, 'json');
  assert.equal(noPool.runtime, null);
  assert.equal(noPool.rollbackSha256, null);

  // 3. postgres sin snapshot SHA => rechazo de configuracion; sin pool => rechazo de arranque.
  assert.throws(() => controlPlaneAuthorityConfig({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres', BEATGALER_POSTGRES_ENABLED: 'true' }), /CUTOVER_SNAPSHOT_SHA256/);
  await assert.rejects(prepare({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres', BEATGALER_POSTGRES_ENABLED: 'true' }, fakePool()), /CUTOVER_SNAPSHOT_SHA256/);
  await assert.rejects(prepare({
    BEATGALER_CONTROL_PLANE_AUTHORITY: 'postgres',
    BEATGALER_POSTGRES_ENABLED: 'true',
    BEATGALER_POSTGRES_CUTOVER_SNAPSHOT_SHA256: SNAP,
  }, null), /requires an initialized PostgreSQL pool/);

  // 4. PG configurado SIN variable de autoridad: hoy arranca en json (sin marcador) y solo se niega con marcador READY.
  const pgEnv = { BEATGALER_POSTGRES_ENABLED: 'true' };
  const noMarkerPool = fakePool();
  const noMarker = await prepare(pgEnv, noMarkerPool);
  assert.equal(noMarker.authority, 'json');
  assert.equal(noMarker.runtime, null);
  assert.ok(noMarkerPool.calls.some((s) => /control_plane_cutovers/.test(s)), 'consulta el marcador de cutover');

  // 5. Marcador READY => rechazo (tambien cuando la autoridad es el valor por defecto).
  await assert.rejects(prepare(pgEnv, fakePool({ marker: { state: 'READY', rollback_export_sha256: null } })), /refused while PostgreSQL cutover is READY/);
  await assert.rejects(prepare({ ...pgEnv, BEATGALER_CONTROL_PLANE_AUTHORITY: 'json' }, fakePool({ marker: { state: 'READY' } })), /refused while PostgreSQL cutover is READY/);

  // 6. ROLLED_BACK: arranca solo con el SHA correcto y archivos que coincidan; si no, rechazo.
  const rolled = { state: 'ROLLED_BACK', rollback_export_sha256: DEFAULT_SHA };
  const ok = await prepare({ ...pgEnv, BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: DEFAULT_SHA }, fakePool({ marker: rolled }));
  assert.equal(ok.authority, 'json');
  assert.equal(ok.runtime, null);
  assert.equal(ok.rollbackSha256, DEFAULT_SHA);
  await assert.rejects(prepare(pgEnv, fakePool({ marker: rolled })), /rollback SHA256 does not match/);
  const other = 'c'.repeat(64);
  await assert.rejects(prepare({ ...pgEnv, BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: other }, fakePool({ marker: { state: 'ROLLED_BACK', rollback_export_sha256: other } })), /do not match the committed PostgreSQL rollback/);
  await assert.rejects(prepare({ ...pgEnv, BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: DEFAULT_SHA }, fakePool({ marker: { state: 'ROLLED_BACK', rollback_export_sha256: other } })), /rollback SHA256 does not match/);
  await assert.rejects(prepare(pgEnv, fakePool({ marker: { state: 'WEIRD' } })), /Unsupported cutover state/);

  // 7. json + pool con activacion nativa o bibliotecas => arranque negado (guarda previa al marcador).
  const native = fakePool({ activations: 1 });
  await assert.rejects(prepare(pgEnv, native), (e) => e.code === 'CATALOG_NATIVE_STARTUP_REFUSED');
  assert.equal(native.calls.some((s) => /control_plane_cutovers/.test(s)), false);
  await assert.rejects(prepare(pgEnv, fakePool({ libraries: 2 })), (e) => e.code === 'CATALOG_NATIVE_STARTUP_REFUSED');

  // 8. SHA de rollback solo con PG habilitado; no se admite junto a autoridad postgres.
  assert.throws(() => controlPlaneAuthorityConfig({ BEATGALER_JSON_ROLLBACK_EXPORT_SHA256: SNAP }), /requires BEATGALER_POSTGRES_ENABLED=true/);
  assert.throws(() => controlPlaneAuthorityConfig({ BEATGALER_CONTROL_PLANE_AUTHORITY: 'dual' }), /json or postgres/);

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('PASS control-plane authority behavior: default json, json sin pool, READY/ROLLED_BACK, postgres sin snapshot');
})().catch((e) => { console.error(e); process.exit(1); });
