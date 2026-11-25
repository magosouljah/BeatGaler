'use strict';

// M7.4-char: contrato observable del almacén de identidad (accounts-data.json real o virtual) que M7.4 no puede cambiar.
// Cubre lectura de sesión (válida/vencida/desconocida/revocada/sin usuario/rotada), visibilidad inmediata de un cambio de
// identidad en la petición siguiente y el puente virtual de PostgreSQL (solo lo confirmado por rename es visible y se encola).
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSessionSecurityRuntime } = require('../session-security');
const { createAccountLifecycleRuntime } = require('../account-lifecycle');
const { installLegacyJsonCompatibility } = require('../control-plane-json-compat');

const now = 1_800_000_000_000;
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const tok = name => `m74-${name}`;
const SESSIONS = {
  valid: { userId: 'usr_a', createdAt: now - 10, expiresAt: now + 100_000 },
  expired: { userId: 'usr_a', createdAt: now - 10, expiresAt: now - 1 },
  boundary: { userId: 'usr_a', createdAt: now - 10, expiresAt: now },
  orphan: { userId: 'usr_gone', createdAt: now - 10, expiresAt: now + 100_000 },
  nouser: { createdAt: now - 10, expiresAt: now + 100_000 },
  revoked: { userId: 'usr_a', createdAt: now - 10, expiresAt: now + 100_000 },
  managed: { userId: 'usr_a', createdAt: now - 10, expiresAt: now + 100_000 },
};
const USERS = [{ id: 'usr_a', username: 'a#0001', email: 'a@example.test' }];

function accounts(extra = {}) {
  const sessions = {};
  for (const [name, record] of Object.entries(SESSIONS)) sessions[sha(tok(name))] = record;
  return { users: USERS, sessions, ...extra };
}
function fixture(data = accounts(), lifecycleState = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-identity-char-'));
  const file = path.join(dir, 'accounts-data.json');
  const write = value => fs.writeFileSync(file, JSON.stringify(value));
  write(data);
  if (lifecycleState) fs.writeFileSync(path.join(dir, 'account-lifecycle-state.json'), JSON.stringify(lifecycleState));
  fs.writeFileSync(path.join(dir, 'session-security-state.json'), JSON.stringify({
    version: 1,
    revoked_session_hashes: [sha(tok('revoked'))],
    managed_session_hashes: [sha(tok('managed'))],
  }));
  const security = createSessionSecurityRuntime({ dataDir: dir, now: () => now });
  const lifecycle = createAccountLifecycleRuntime({ dataDir: dir, now: () => now });
  return { dir, file, write, security, lifecycle, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const request = name => ({ method: 'POST', path: '/auth/account', url: '/auth/account', headers: { host: 'x', authorization: `Bearer ${tok(name)}` }, body: {} });
function response() {
  return { statusCode: 200, body: null, setHeader() { return this; }, getHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
}
function through(security, name) {
  const res = response();
  let accepted = false;
  const req = request(name);
  security.requestMiddleware(req, res, () => { accepted = true; });
  return { accepted, status: res.statusCode, code: res.body?.code, userId: req.beatgalerSessionSecurity?.userId };
}

test('M7.4-char: estados de sesión en la barrera de seguridad (código HTTP y causa)', () => {
  const f = fixture();
  try {
    assert.deepEqual(through(f.security, 'valid'), { accepted: true, status: 200, code: undefined, userId: 'usr_a' });
    for (const [name, code] of [['expired', 'SESSION_EXPIRED'], ['boundary', 'SESSION_EXPIRED'], ['unknown', 'SESSION_EXPIRED'],
      ['revoked', 'SESSION_REVOKED'], ['managed', 'SESSION_ROTATED'], ['nouser', 'SESSION_INVALID']]) {
      const out = through(f.security, name);
      assert.equal(out.accepted, false, name);
      assert.equal(out.status, 401, name);
      assert.equal(out.code, code, name);
    }
    // La barrera de seguridad solo mira sesión y userId; que el usuario exista lo decide el guard de ciclo de vida.
    assert.equal(through(f.security, 'orphan').accepted, true);
  } finally { f.done(); }
});

test('M7.4-char: sessionInfoFromRequest del ciclo de vida (válida, vencida, revocada, sin usuario, borrada)', () => {
  const sha_ = name => sha(tok(name));
  const f = fixture(accounts(), { version: 1, revoked_session_hashes: [sha_('revoked')], tombstones: { usr_dead: { receipt_id: 'r' } } });
  try {
    f.write(accounts({ users: [...USERS, { id: 'usr_dead', username: 'dead#0001', email: 'dead@example.test' }], sessions: { ...accounts().sessions, [sha_('dead')]: { userId: 'usr_dead', createdAt: now, expiresAt: now + 5 } } }));
    const info = name => f.lifecycle.api.session.sessionInfoFromRequest(request(name));
    assert.equal(info('valid')?.userId, 'usr_a');
    assert.equal(info('valid')?.user.email, 'a@example.test');
    for (const name of ['expired', 'boundary', 'unknown', 'revoked', 'orphan', 'nouser']) assert.equal(info(name), null, name);
    // Con el usuario en las tumbas, la sesión deja de valer aunque el almacén aún la contenga.
    assert.equal(info('dead'), null);
    assert.equal(f.lifecycle.api.session.sessionInfoFromRequest({ headers: {} }), null);
  } finally { f.done(); }
});

test('M7.4-char: un cambio de identidad en el almacén es visible en la petición siguiente (sin caché entre peticiones)', () => {
  const f = fixture();
  try {
    assert.equal(through(f.security, 'valid').accepted, true);
    assert.equal(f.lifecycle.api.session.sessionInfoFromRequest(request('valid')).user.email, 'a@example.test');

    const withoutValid = accounts();
    delete withoutValid.sessions[sha(tok('valid'))];
    f.write(withoutValid);
    assert.equal(through(f.security, 'valid').code, 'SESSION_EXPIRED');
    assert.equal(f.lifecycle.api.session.sessionInfoFromRequest(request('valid')), null);

    f.write({ ...accounts(), users: [{ ...USERS[0], email: 'renamed@example.test' }] });
    assert.equal(through(f.security, 'valid').accepted, true);
    assert.equal(f.lifecycle.api.session.sessionInfoFromRequest(request('valid')).user.email, 'renamed@example.test');

    f.write({ ...accounts(), users: [] });
    assert.equal(f.lifecycle.api.session.sessionInfoFromRequest(request('valid')), null);

    const extended = accounts();
    extended.sessions[sha(tok('expired'))] = { ...SESSIONS.expired, expiresAt: now + 1 };
    f.write(extended);
    assert.equal(through(f.security, 'expired').accepted, true);
  } finally { f.done(); }
});

test('M7.4-char: archivo virtual de PostgreSQL: solo el rename confirma, se encola el snapshot y ambos lectores lo ven', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-identity-virtual-'));
  const file = path.join(dir, 'accounts-data.json');
  const saved = [];
  const uninstall = installLegacyJsonCompatibility({
    fsModule: fs, authPath: file, persistentPath: path.join(dir, 'cloud-data.json'),
    runtime: { saveAuthSnapshot: snapshot => { saved.push(snapshot); return Promise.resolve(); }, savePersistentSnapshot() {} },
    initialAuth: accounts(), initialPersistent: {},
  });
  try {
    const security = createSessionSecurityRuntime({ dataDir: dir, now: () => now });
    const lifecycle = createAccountLifecycleRuntime({ dataDir: dir, now: () => now });
    assert.equal(through(security, 'valid').accepted, true);
    assert.equal(fs.existsSync(path.join(dir, 'cloud-data.json')), true);
    assert.equal(fs.readdirSync(dir).includes('accounts-data.json'), false, 'el almacén virtual no toca el disco');

    const next = accounts();
    delete next.sessions[sha(tok('valid'))];
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
    // Escrito pero no confirmado: ni visible ni encolado.
    assert.equal(through(security, 'valid').accepted, true);
    assert.equal(saved.length, 0);
    fs.renameSync(`${file}.tmp`, file);
    assert.equal(saved.length, 1, 'el rename entrega el snapshot completo al runtime de durabilidad');
    assert.equal(Object.hasOwn(saved[0].sessions, sha(tok('valid'))), false);
    assert.equal(through(security, 'valid').code, 'SESSION_EXPIRED');
    assert.equal(lifecycle.api.session.sessionInfoFromRequest(request('valid')), null);
  } finally { uninstall(); fs.rmSync(dir, { recursive: true, force: true }); }
});
