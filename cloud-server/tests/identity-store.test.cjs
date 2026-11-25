'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { sha256String } = require('../auth-helpers');
const { createAccountLifecycleRuntime } = require('../account-lifecycle');
const { createSessionSecurityRuntime } = require('../session-security');
const { installLegacyJsonCompatibility } = require('../control-plane-json-compat');
const { virtualIdentity } = require('../identity-store');

const now = 1_800_000_000_000;
const token = 'identity-store-token';
const hash = sha256String(token);
const req = {
  method: 'POST',
  path: '/auth/account',
  url: '/auth/account',
  headers: { host: 'test', authorization: `Bearer ${token}` },
};

function credential(security) {
  const request = { ...req };
  const response = { setHeader() {}, getHeader() {} };
  let accepted = false;
  security.requestMiddleware(request, response, () => { accepted = true; });
  assert.equal(accepted, true);
  return request.beatgalerSessionSecurity;
}

function snapshot(id, email) {
  return {
    users: [{ id, email, providers: { example: { linked: true } } }],
    sessions: { [hash]: { userId: id, expiresAt: now + 1000, details: { client: 'web' } } },
  };
}

function fixture(t, { virtual } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-identity-store-'));
  const file = path.join(dir, 'accounts-data.json');
  const initial = snapshot('usr_before', 'before@example.test');
  const persistent = path.join(dir, 'cloud-data.json');
  let uninstall;
  t.after(() => {
    uninstall?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (virtual) {
    uninstall = installLegacyJsonCompatibility({
      fsModule: fs, authPath: file, persistentPath: persistent, initialAuth: initial, initialPersistent: {},
      runtime: { saveAuthSnapshot() {}, savePersistentSnapshot() {} },
    });
  } else fs.writeFileSync(file, JSON.stringify(initial));
  return {
    file, persistent,
    lifecycle: createAccountLifecycleRuntime({ dataDir: dir, now: () => now }),
    security: createSessionSecurityRuntime({ dataDir: dir, now: () => now }),
  };
}

test('el índice virtual solo se reconstruye al confirmar el archivo de identidad', t => {
  const { file, persistent, lifecycle } = fixture(t, { virtual: true });
  const initial = virtualIdentity(fs, file);
  const info = () => lifecycle.api.session.sessionInfoFromRequest(req);
  const next = snapshot('usr_after', 'After@Example.Test');
  next.users.push({ id: 'usr_after', email: 'after@example.test', duplicate: true });
  assert.equal(info().user.id, 'usr_before');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
  fs.writeFileSync(`${persistent}.tmp`, '{}');
  fs.renameSync(`${persistent}.tmp`, persistent);
  assert.equal(info().user.id, 'usr_before');
  assert.equal(virtualIdentity(fs, file), initial);

  fs.renameSync(`${file}.tmp`, file);
  const committed = virtualIdentity(fs, file);
  assert.notEqual(committed, initial);
  assert.equal(info().userId, 'usr_after');
  assert.deepEqual(lifecycle.api.state.userById('usr_after'), next.users[0]);
  assert.deepEqual(committed.userByEmail(' AFTER@example.test '), next.users[0]);
  assert.equal(lifecycle.api.state.userById('usr_before'), null);
  assert.equal(virtualIdentity(fs, file), committed);
});

test('una escritura directa al archivo final sin rename sombrea el índice virtual', t => {
  const { file, lifecycle } = fixture(t, { virtual: true });
  const info = () => lifecycle.api.session.sessionInfoFromRequest(req);
  assert.ok(virtualIdentity(fs, file));
  assert.equal(info().user.id, 'usr_before');
  fs.writeFileSync(file, JSON.stringify(snapshot('usr_direct', 'direct@example.test')));
  // Sin rename no hay índice: se lee el contenido escrito por la vía heredada.
  assert.equal(virtualIdentity(fs, file), null);
  assert.equal(info().user.id, 'usr_direct');
});

test('las peticiones y las copias completas reciben datos de identidad aislados', t => {
  const { lifecycle, security } = fixture(t, { virtual: true });
  const info = () => lifecycle.api.session.sessionInfoFromRequest(req);
  const before = info();
  const expected = structuredClone(before);
  before.user.providers.example.linked = false;
  before.session.details.client = 'changed';
  credential(security).record.details.client = 'changed by security';
  const full = lifecycle.api.state.accountsSnapshot();
  full.users[0].providers.example.linked = false;
  delete full.sessions[hash];

  assert.deepEqual(info(), expected);
  assert.deepEqual(credential(security).record, expected.session);
  assert.deepEqual(lifecycle.api.state.accountsSnapshot(), snapshot('usr_before', 'before@example.test'));
});

test('el archivo JSON real se vuelve a leer después de una escritura externa', t => {
  const { file, lifecycle, security } = fixture(t);
  const info = () => lifecycle.api.session.sessionInfoFromRequest(req);
  assert.equal(virtualIdentity(fs, file), undefined);
  assert.equal(info().userId, 'usr_before');
  assert.equal(credential(security).userId, 'usr_before');

  const replacement = `${file}.external`;
  fs.writeFileSync(replacement, JSON.stringify(snapshot('usr_after', 'after@example.test')));
  fs.renameSync(replacement, file);
  assert.equal(info().userId, 'usr_after');
  assert.equal(credential(security).userId, 'usr_after');
  assert.equal(virtualIdentity(fs, file), undefined);
});
