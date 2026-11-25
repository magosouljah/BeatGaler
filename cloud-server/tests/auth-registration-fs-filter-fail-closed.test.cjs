'use strict';

// B8b: el parche de fs de auth-public-registration-hardening falla cerrado.
// Proceso propio: el parche de fs se instala una sola vez por proceso.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installAuthPublicRegistrationHardening } = require('../auth-public-registration-hardening');
const { createAccountLifecycleRuntime } = require('../account-lifecycle');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-reg-fail-closed-'));
const tmpFile = path.join(dir, 'accounts-data.json.tmp');
let previousUsers = [{ id: 'usr_prev', username: 'prev' }];

installAuthPublicRegistrationHardening({ application: { post() {}, get() {} } }, {
  env: process.env,
  getAccountLifecycle: () => ({ api: { state: { accountsSnapshot: () => ({ users: previousUsers, sessions: {} }), deletedUserIds: new Set() } } }),
});

const withToken = JSON.stringify({
  users: [{ id: 'usr_x', username: 'xuser', email: 'user@example.com', providers: { x: { id: '1', accessToken: 'SECRET-AT', refreshToken: 'SECRET-RT', tokenExpiresAt: 9 } } }],
  sessions: {},
});

try {
  // Camino sano: retira tokens y conserva usuarios previos.
  fs.writeFileSync(tmpFile, withToken, 'utf8');
  const ok = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  assert.equal(ok.users.some(u => u.id === 'usr_prev'), true);
  assert.equal(ok.users.find(u => u.id === 'usr_x').providers.x.accessToken, undefined);
  fs.rmSync(tmpFile);

  // Fallo de la transformación (usuario previo con getter hostil): no escribe.
  previousUsers = [{ get id() { throw new Error('boom user@example.com'); } }];
  assert.throws(() => fs.writeFileSync(tmpFile, withToken, 'utf8'), error => {
    assert.equal(error.code, 'AUTH_REGISTRATION_FILTER_FAILED');
    assert.equal(String(error.message).includes('user@example.com'), false);
    return true;
  });
  assert.equal(fs.existsSync(tmpFile), false, 'no se escribe el contenido original con tokens de X');

  // JSON inválido: tampoco se escribe.
  assert.throws(() => fs.writeFileSync(tmpFile, '{not json', 'utf8'), { code: 'AUTH_REGISTRATION_FILTER_FAILED' });
  assert.equal(fs.existsSync(tmpFile), false);

  // Encadenado con el filtro de B8: el fallo del filtro de ciclo de vida tampoco escribe ni dobla.
  previousUsers = [];
  const runtime = createAccountLifecycleRuntime({ dataDir: dir, now: () => 1, env: {} });
  runtime.provide({ filterAccountsValue() { throw new Error('lifecycle boom'); } });
  runtime.installPersistenceFilter();
  assert.throws(() => fs.writeFileSync(tmpFile, withToken, 'utf8'));
  assert.equal(fs.existsSync(tmpFile), false, 'cadena de ambos parches: sin escritura parcial');

  // Otros archivos no se tocan.
  const other = path.join(dir, 'other.json.tmp');
  fs.writeFileSync(other, '{not json', 'utf8');
  assert.equal(fs.readFileSync(other, 'utf8'), '{not json');
  console.log('auth-registration-fs-filter-fail-closed tests: PASS');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
