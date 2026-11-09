'use strict';
// T11 — Harness `scripts/catalog-transport-contract.cjs`: experimentos cerrados (fake) con resultados esperados y cerco
// STOP-APPROVAL del modo sandbox. Nunca toca red ni lee credenciales.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const harness = require('../../../scripts/catalog-transport-contract.cjs');

test('modo fake: los 10 experimentos producen el resultado esperado; G2 NOT_PROVEN; informe con SDK, política de reenvío y tabla de errores', async () => {
  const report = await harness.runExperiments({ mode: 'fake' });
  assert.equal(report.experiments.length, 10);
  for (const r of report.experiments) assert.equal(r.outcome, r.expected, `${r.id}: ${JSON.stringify(r.details).slice(0, 300)}`);
  assert.deepEqual([report.allMatch, report.evidence, report.g2], [true, 'FAKE', 'NOT_PROVEN']);
  assert.deepEqual(report.experiments.filter((r) => r.outcome === 'REQUIRES_SANDBOX').map((r) => r.id), ['E4', 'E7', 'E8']);
  assert.match(report.sdk.installed, /^2\.26\./);
  assert.match(report.sdk.lock.telegram.integrity, /^sha512-/);
  assert.equal(report.resendPolicy.uncertain, 'BLOCKED');
  assert.ok(report.errorTable.some((row) => row.kind === 'REVOKED'));
  assert.ok(report.stop.startsWith('STOP-APPROVAL'));
  const e4 = report.experiments.find((r) => r.id === 'E4');
  assert.deepEqual([e4.details.pessimistic.decision, e4.details.optimistic.decision], ['AMBIGUOUS', 'ADOPT']);
});

test('modo sandbox: STOP-APPROVAL sin descriptor, con descriptor inválido o sin variable de aprobación; con aprobación formal → STOP-ENV (runner real no implementado) sin red', async () => {
  await assert.rejects(harness.runExperiments({ mode: 'sandbox', env: {} }), (e) => e.code === 'STOP-APPROVAL' && e.exitCode === 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t11-'));
  const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, JSON.stringify({ scope: 'T11-SANDBOX', approvalId: 'short' }));
  await assert.rejects(harness.runExperiments({ mode: 'sandbox', descriptorPath: bad, env: {} }), (e) => e.code === 'STOP-APPROVAL');
  const good = path.join(dir, 'ok.json');
  fs.writeFileSync(good, JSON.stringify({ scope: 'T11-SANDBOX', approvalId: 'APR-20261109-T11', approvedBy: 'Purp', botIds: ['lab-bot'], vaultIds: ['lab-vault'], expiresAt: new Date(Date.now() + 3600_000).toISOString(), production: false }));
  await assert.rejects(harness.runExperiments({ mode: 'sandbox', descriptorPath: good, env: {} }), (e) => e.code === 'STOP-APPROVAL' && /BEATGALER_T11_SANDBOX_APPROVAL/.test(e.message));
  await assert.rejects(harness.runExperiments({ mode: 'sandbox', descriptorPath: good, env: { BEATGALER_T11_SANDBOX_APPROVAL: 'APR-20261109-T11' } }), (e) => e.code === 'STOP-ENV' && e.exitCode === 4);
  fs.writeFileSync(good, JSON.stringify({ scope: 'T11-SANDBOX', approvalId: 'APR-20261109-T11', approvedBy: 'Purp', botIds: ['x'], vaultIds: ['y'], expiresAt: new Date(Date.now() + 3600_000).toISOString(), production: true }));
  await assert.rejects(harness.runExperiments({ mode: 'sandbox', descriptorPath: good, env: { BEATGALER_T11_SANDBOX_APPROVAL: 'APR-20261109-T11' } }), (e) => e.code === 'STOP-APPROVAL', 'producción nunca es sandbox');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI: argumentos, --only y modo desconocido', async () => {
  assert.deepEqual(harness.parseArgs(['--mode', 'fake', '--only', 'E1,E9']), { mode: 'fake', out: null, descriptorPath: null, list: false, only: ['E1', 'E9'] });
  assert.throws(() => harness.parseArgs(['--boom']), (e) => e.code === 'STOP-ENV');
  await assert.rejects(harness.runExperiments({ mode: 'real' }), (e) => e.code === 'STOP-ENV');
  const r = await harness.runExperiments({ mode: 'fake', only: ['E1', 'E9'] });
  assert.deepEqual(r.experiments.map((x) => x.id), ['E1', 'E9']);
  assert.equal(r.allMatch, true);
});
