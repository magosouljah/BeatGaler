'use strict';
// Preflight G3/G2: solo lectura, nunca imprime valores de entorno, falla ante producción / G2 aprobado / puerto reservado, no ejecuta nada real.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const script = path.join(__dirname, '..', '..', '..', 'scripts', 'g3-preflight.cjs');
const run = (env) => { const r = spawnSync(process.execPath, [script, '--json'], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env }, encoding: 'utf8', timeout: 60000 }); let j = null; try { j = JSON.parse(r.stdout); } catch { /* */ } return { r, j, byId: (id) => j && j.checks.find((c) => c.id === id) }; };

test('G2 siempre NOT_PROVEN; sin entorno de prueba hay requisitos BLOCKED, ninguno ejecuta nada', () => {
  const { j, byId } = run({});
  assert.equal(j.g2, 'NOT_PROVEN'); assert.equal(byId('e7-no-incluido').status, 'PASS');
  assert.equal(byId('aprobacion-propietario').status, 'BLOCKED'); assert.equal(byId('gateway-real').status, 'BLOCKED'); assert.equal(byId('descriptor-t11').status === 'PASS', false);
});
test('FAIL ante producción, G2 aprobado, DB no loopback o puerto reservado', () => {
  const { byId } = run({ BEATGALER_DEPLOYMENT_ENV: 'production', BEATGALER_CATALOG_G2_APPROVED: 'true', DATABASE_URL: 'postgres://u:SECRETPASS@db.example.com:5432/x' });
  assert.equal(byId('no-produccion').status, 'FAIL'); assert.equal(byId('g2-no-aprobado').status, 'FAIL'); assert.equal(byId('postgres-aislado').status, 'FAIL'); assert.equal(byId('postgres-no-reservado').status, 'FAIL');
});
test('nunca imprime valores de entorno ni credenciales', () => {
  const { r } = run({ DATABASE_URL: 'postgres://u:SECRETPASS@127.0.0.1:54339/x', BEATGALER_T11_SANDBOX_APPROVAL: 'APPROVAL-VALUE-123', BEATGALER_CATALOG_CURSOR_KEYS: 'KEYMATERIAL-XYZ' });
  assert.doesNotMatch(r.stdout + r.stderr, /SECRETPASS|APPROVAL-VALUE-123|KEYMATERIAL-XYZ/);
});
