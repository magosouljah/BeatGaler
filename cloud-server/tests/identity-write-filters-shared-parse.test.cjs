'use strict';

// M7.4e: los filtros de escritura de identidad (ciclo de vida, exterior -> registro -> compat) escriben
// exactamente los mismos bytes que la implementación de referencia (copia literal de la base 80476f2),
// también cuando comparten el parse, y siguen fallando cerrado. Proceso propio: los parches de fs son
// globales y se instalan una vez por proceso.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installLegacyJsonCompatibility } = require('../control-plane-json-compat');
const {
  installAuthPublicRegistrationHardening,
  normalizeUsername,
  temporaryUsername,
} = require('../auth-public-registration-hardening');
const { installAccountLifecycle } = require('../account-lifecycle');
const { createGuardContext } = require('../account-route-guards');
const { installLifecyclePasswordAuthority } = require('../account-lifecycle-password-authority');

const NOW = 1_800_000_000_000;
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-m74e-'));
const auth = path.join(dir, 'accounts-data.json');
const authTmp = `${auth}.tmp`;
const persistent = path.join(dir, 'cloud-data.json');

// ---- Referencia: filtros de la base 80476f2, copiados literalmente y aplicados sobre el texto. ----
function refCloneUser(user) {
  return user && typeof user === 'object' ? JSON.parse(JSON.stringify(user)) : user;
}
function refPreserveUsersByStableId(nextUsers, previousUsers, deletedUserIds = new Set()) {
  const deleted = deletedUserIds instanceof Set ? deletedUserIds : new Set(deletedUserIds || []);
  const output = [];
  const byId = new Set();
  const usedNames = new Set();
  for (const raw of Array.isArray(nextUsers) ? nextUsers : []) {
    const id = String(raw?.id || '').trim();
    if (!id || deleted.has(id) || byId.has(id)) continue;
    const user = refCloneUser(raw);
    const nameKey = normalizeUsername(user?.username);
    if (nameKey && usedNames.has(nameKey)) {
      user.username = temporaryUsername(user.username, id, usedNames);
      user.usernameSource = 'beatgaler';
      user.usernameReconciliation = 'snapshot_collision';
    }
    byId.add(id);
    if (user?.username) usedNames.add(normalizeUsername(user.username));
    output.push(user);
  }
  for (const raw of Array.isArray(previousUsers) ? previousUsers : []) {
    const id = String(raw?.id || '').trim();
    if (!id || deleted.has(id) || byId.has(id)) continue;
    const user = refCloneUser(raw);
    const nameKey = normalizeUsername(user?.username);
    if (nameKey && usedNames.has(nameKey)) {
      user.username = temporaryUsername(user.username, id, usedNames);
      user.usernameSource = 'beatgaler';
      user.usernameReconciliation = 'snapshot_preserved';
    }
    byId.add(id);
    if (user?.username) usedNames.add(normalizeUsername(user.username));
    output.push(user);
  }
  return output;
}
function refLifecycle(data) {
  const state = fs[Symbol.for('beatgaler.accountLifecyclePersistenceFilter')];
  try {
    let parsed = JSON.parse(data);
    for (const runtime of state.runtimes) parsed = runtime.api.state.filterAccountsValue(parsed);
    return JSON.stringify(parsed, null, 2);
  } catch {
    const error = new Error('Account lifecycle persistence filter failed; write aborted.');
    error.code = 'ACCOUNT_LIFECYCLE_FILTER_FAILED';
    throw error;
  }
}
function refRegistration(data, life) {
  try {
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed?.users)) {
      parsed.users = refPreserveUsersByStableId(parsed.users, life.api.state.accountsSnapshot().users, life.api.state.deletedUserIds);
      for (const user of parsed.users) {
        if (!user?.providers?.x) continue;
        delete user.providers.x.accessToken;
        delete user.providers.x.refreshToken;
        delete user.providers.x.tokenExpiresAt;
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    const failure = new Error('Auth registration persistence filter failed; write aborted.');
    failure.code = 'AUTH_REGISTRATION_FILTER_FAILED';
    throw failure;
  }
}
const reference = (data, life) => refRegistration(refLifecycle(data), life);

// ---- Cadena real, en el orden de server.js: compat (interior) -> registro -> ciclo de vida (exterior). ----
function user(i, extra = {}) {
  return {
    id: `usr_${i}`, username: `user${i}`, usernameSource: 'beatgaler', email: `user${i}@example.test`,
    passwordSalt: 'a'.repeat(32), passwordHash: `h${i}`.padEnd(64, 'b'), createdAt: NOW - i, providers: {}, ...extra,
  };
}
const initial = { users: [user(1), user(2), user(3)], sessions: { [sha('s1')]: { userId: 'usr_1', createdAt: NOW, expiresAt: NOW + 1e8 } } };
const snapshots = [];
installLegacyJsonCompatibility({
  fsModule: fs,
  runtime: { saveAuthSnapshot: value => snapshots.push(JSON.stringify(value)), savePersistentSnapshot() {} },
  authPath: auth,
  persistentPath: persistent,
  initialAuth: initial,
  initialPersistent: {},
});
const express = { application: {}, json: () => (_req, _res, next) => next() };
const ctx = createGuardContext();
installAuthPublicRegistrationHardening(ctx, {
  env: {},
  getAccountLifecycle: () => ctx.entries.accountLifecycle?.runtime || null,
});
const life = installAccountLifecycle(ctx, {
  express,
  dataDir: dir, env: {}, now: () => NOW,
  getCapabilityStore: () => ({ async revokeAuthSession() {} }),
});
installLifecyclePasswordAuthority(life);
const stockFilter = life.api.state.filterAccountsValue;

let writes = 0;
// Escribe como saveAuthData y compara los bytes preparados, lo que lee el servidor y lo que recibe PG.
function save(label, value, { text = JSON.stringify(value, null, 2), commit = true } = {}) {
  writes += 1;
  const expected = reference(text, life);
  fs.writeFileSync(authTmp, text, 'utf8');
  const staged = fs.readFileSync(authTmp, 'utf8');
  assert.equal(staged, expected, `${label}: bytes preparados para accounts-data.json`);
  if (!commit) return JSON.parse(staged);
  const before = snapshots.length;
  fs.renameSync(authTmp, auth);
  assert.equal(snapshots.length, before + 1, `${label}: un snapshot a PG`);
  assert.equal(snapshots.at(-1), JSON.stringify(JSON.parse(expected)), `${label}: snapshot entregado a PG`);
  assert.equal(fs.readFileSync(auth, 'utf8'), expected, `${label}: bytes visibles tras el rename`);
  return JSON.parse(expected);
}
function current() {
  return JSON.parse(fs.readFileSync(auth, 'utf8'));
}
function expectFailClosed(label, text, code) {
  assert.throws(() => reference(text, life), { code }, `${label}: la referencia también falla`);
  const before = snapshots.length;
  assert.throws(() => fs.writeFileSync(authTmp, text, 'utf8'), error => {
    assert.equal(error.code, code, `${label}: código`);
    assert.equal(String(error.message).includes('@example.test'), false, `${label}: sin datos en el mensaje`);
    return true;
  });
  assert.throws(() => fs.readFileSync(authTmp, 'utf8'), { code: 'ENOENT' }, `${label}: nada preparado`);
  assert.equal(snapshots.length, before, `${label}: nada hacia PG`);
}

async function main() {
  const quiet = console.error;
  console.error = () => {};
  try {
    // Alta (nombre que colisiona con otro usuario: nombre temporal) y login con sesión nueva.
    let value = current();
    value.users.push(user(4, { username: 'USER1' }));
    value.sessions[sha('s4')] = { userId: 'usr_4', createdAt: NOW, expiresAt: NOW + 1e8 };
    let out = save('alta', value);
    assert.match(out.users.find(u => u.id === 'usr_4').username, /^user1#\d{4}$/);

    // OAuth X: los tokens no se persisten nunca.
    value = current();
    value.users.push(user(5, { providers: { x: { id: '55', username: 'xu', accessToken: 'SECRET-AT', refreshToken: 'SECRET-RT', tokenExpiresAt: 9 } } }));
    value.users[0].providers.x = { id: '11', accessToken: 'SECRET-AT-1', refreshToken: 'SECRET-RT-1' };
    out = save('oauth x', value);
    assert.equal(JSON.stringify(out).includes('SECRET'), false);

    // Cambio de email.
    value = current();
    value.users.find(u => u.id === 'usr_2').email = 'nuevo2@example.test';
    out = save('cambio de email', value);
    assert.equal(out.users.find(u => u.id === 'usr_2').email, 'nuevo2@example.test');

    // Usuario previo que falta en la escritura: se conserva (y su nombre colisiona).
    value = current();
    value.users = value.users.filter(u => u.id !== 'usr_3');
    value.users.push(user(6, { username: 'user3' }));
    out = save('usuario previo conservado', value);
    assert.match(out.users.find(u => u.id === 'usr_3').username, /^user3#\d{4}$/);

    // Revocación: la sesión revocada no vuelve a escribirse.
    await life.api.session.revokeUserSessions('usr_1', 'test');
    value = current();
    value.sessions[sha('s1')] = { userId: 'usr_1', createdAt: NOW, expiresAt: NOW + 1e8 };
    value.sessions[sha('s1b')] = { userId: 'usr_1', createdAt: NOW, expiresAt: NOW + 1e8 };
    save('sesión nueva tras revocar', value);
    await life.api.session.revokeUserSessions('usr_1', 'test');
    out = save('revocación', value);
    assert.equal(out.sessions[sha('s1b')], undefined);

    // Contraseña con override vigente y override obsoleto (efecto lateral del filtro de autoridad).
    life.api.state.stateSnapshot().password_overrides.usr_2 = { passwordHash: 'OVR-HASH', passwordSalt: 'OVR-SALT', previousPasswordHash: 'h2'.padEnd(64, 'b') };
    value = current();
    value.users.find(u => u.id === 'usr_2').passwordHash = 'h2'.padEnd(64, 'b');
    out = save('override vigente', value);
    assert.equal(out.users.find(u => u.id === 'usr_2').passwordHash, 'OVR-HASH');
    value.users.find(u => u.id === 'usr_2').passwordHash = 'NEWER-CORE';
    out = save('override obsoleto', value);
    assert.equal(out.users.find(u => u.id === 'usr_2').passwordHash, 'NEWER-CORE');

    // Borrado: la lápida retira al usuario y a sus sesiones, y no lo resucita como "previo".
    life.api.state.deletedUserIds.add('usr_5');
    value = current();
    value.sessions[sha('s5')] = { userId: 'usr_5', createdAt: NOW, expiresAt: NOW + 1e8 };
    out = save('borrado', value);
    assert.equal(out.users.some(u => u.id === 'usr_5'), false);
    assert.equal(out.sessions[sha('s5')], undefined);
    value.users = value.users.filter(u => u.id !== 'usr_5');
    save('borrado (sin el usuario)', value);

    // Texto no canónico (desbordamiento numérico, -0, claves duplicadas, __proto__) y formatos raros.
    const base = current();
    const odd = JSON.stringify(base).replace('"id":"usr_6"', '"id":1e999,"x":-0,"x":-0').replace('"username":"user4', '"__proto__":{"a":1},"username":"user4');
    save('no canónico', null, { text: odd });
    save('id desbordado sin conservar', null, { text: '{"users":[{"id":-1e999,"username":1e999},{"id":"usr_9","username":"user9"}],"sessions":{},"extra":[1,-0,null]}', commit: false });
    save('sin users', null, { text: '{"sessions":{}}', commit: false });
    save('users no array', null, { text: '{"users":{"0":{"id":"usr_1"}},"sessions":{}}', commit: false });
    save('raíz array', null, { text: '[1,2]', commit: false });
    save('compacto', current(), { text: JSON.stringify(current()) });

    // Filtros que devuelven valores con alias o no JSON: los mismos bytes que serializando.
    const shared = { id: '77', accessToken: 'SECRET-SHARED' };
    life.provide({ filterAccountsValue: v => { const r = stockFilter(v); r.users[0].providers = { x: shared }; r.sessions.alias = { token: shared }; return r; } });
    out = save('alias entre usuario y sesión', current(), { commit: false });
    assert.equal(out.sessions.alias.token.accessToken, 'SECRET-SHARED');
    life.provide({ filterAccountsValue: v => { const r = stockFilter(v); r.users.push(r.users[0]); r.users.push({ ...r.users[1], id: 'usr_dup' }); r.users[1].providers = { x: r.users[2].providers.x || { id: '1', accessToken: 'T' } }; r.users[2].providers = r.users[1].providers; return r; } });
    save('alias entre usuarios', current(), { commit: false });
    life.provide({ filterAccountsValue: v => { const r = stockFilter(v); r.users[0].createdAt = Infinity; r.users[1].username = NaN; r.when = new Date(NOW); r.u = undefined; r.users[0].fn = () => 1; return r; } });
    save('valores no JSON', current(), { commit: false });
    life.provide({ filterAccountsValue: v => { const r = stockFilter(v); r.users[0].id = { toJSON: () => 'usr_json' }; r.users.length += 1; return r; } });
    save('toJSON y hueco', current(), { commit: false });
    life.provide({ filterAccountsValue: v => { const r = stockFilter(v); const { id, ...rest } = r.users[1]; r.users[1] = Object.assign(Object.create({ id }), rest); return r; } });
    save('id heredado del prototipo', current(), { commit: false });
    class HiddenUsers extends Array { *[Symbol.iterator]() {} }
    life.provide({ filterAccountsValue: v => { const r = stockFilter(v); r.users.push({ id: 'usr_hidden', username: 'hidden' }); r.users = HiddenUsers.from(r.users); return r; } });
    save('array con prototipo propio', current(), { commit: false });
    life.provide({ filterAccountsValue: stockFilter });

    // Otro envoltorio entre el ciclo de vida y el registro: no se le salta.
    const lifecycleState = fs[Symbol.for('beatgaler.accountLifecyclePersistenceFilter')];
    const inner = lifecycleState.original;
    let interposed = 0;
    lifecycleState.original = function interposedWrite(file, data, ...rest) {
      if (String(file).endsWith('accounts-data.json.tmp')) interposed += 1;
      return inner.call(this, file, data, ...rest);
    };
    try {
      save('envoltorio intermedio', current());
      assert.equal(interposed, 1, 'el envoltorio intermedio recibe la escritura');
    } finally {
      lifecycleState.original = inner;
    }

    // Fallo del filtro de registro (tras el de ciclo de vida): falla cerrado y no escribe nada.
    save('sin escritura pendiente', current());
    const deleted = life.api.state.deletedUserIds;
    let boomCalls = 0;
    const originalHas = deleted.has;
    deleted.has = function has(id) {
      if (id === 'usr_boom' && (boomCalls += 1) % 2 === 0) throw new Error('boom usr_boom@example.test');
      return originalHas.call(this, id);
    };
    value = current();
    value.users.push(user('boom'));
    try {
      expectFailClosed('fallo del filtro de registro', JSON.stringify(value, null, 2), 'AUTH_REGISTRATION_FILTER_FAILED');
    } finally {
      deleted.has = originalHas;
    }
    // Fallo del filtro de ciclo de vida y JSON inválido.
    life.provide({ filterAccountsValue: () => { throw new Error('lifecycle boom user1@example.test'); } });
    try {
      expectFailClosed('fallo del filtro de ciclo de vida', JSON.stringify(current(), null, 2), 'ACCOUNT_LIFECYCLE_FILTER_FAILED');
    } finally {
      life.provide({ filterAccountsValue: stockFilter });
    }
    expectFailClosed('JSON inválido', '{not json', 'ACCOUNT_LIFECYCLE_FILTER_FAILED');
    life.provide({ filterAccountsValue: v => { const r = stockFilter(v); r.big = 1n; return r; } });
    try {
      expectFailClosed('valor no serializable', JSON.stringify(current(), null, 2), 'ACCOUNT_LIFECYCLE_FILTER_FAILED');
    } finally {
      life.provide({ filterAccountsValue: stockFilter });
    }

    // Diferencial aleatorio con semilla: altas, bajas, X, colisiones, revocaciones, lápidas, overrides.
    let seed = 0x7e4e;
    const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let step = 0; step < 150; step += 1) {
      value = current();
      const op = rnd(9);
      const id = 100 + rnd(30);
      if (op === 0) value.users.push(user(id, { username: rnd(2) ? `user${rnd(8)}` : `u${id}` }));
      if (op === 1 && value.users.length) value.users.splice(rnd(value.users.length), 1);
      if (op === 2 && value.users.length) value.users[rnd(value.users.length)].providers = { x: { id: String(id), accessToken: `SECRET-${id}`, refreshToken: 'R', tokenExpiresAt: id } };
      if (op === 3 && value.users.length) value.users[rnd(value.users.length)].email = `e${step}@example.test`;
      if (op === 4) value.sessions[sha(`r${step}`)] = { userId: `usr_${id}`, createdAt: NOW, expiresAt: NOW + 1e8 };
      if (op === 5) await life.api.session.revokeUserSessions(`usr_${id}`, 'fuzz');
      if (op === 6) life.api.state.deletedUserIds.add(`usr_${id}`);
      if (op === 7 && value.users.length) {
        const target = value.users[rnd(value.users.length)];
        life.api.state.stateSnapshot().password_overrides[target.id] = { passwordHash: `O${step}`, passwordSalt: 'S', previousPasswordHash: rnd(2) ? target.passwordHash : 'other' };
      }
      if (op === 8 && value.users.length > 1) value.users[rnd(value.users.length)].username = value.users[0].username.toUpperCase();
      out = save(`fuzz ${step}`, value, { commit: rnd(4) !== 0 });
      assert.equal(JSON.stringify(out).includes('SECRET'), false, `fuzz ${step}: sin tokens de X`);
    }
  } finally {
    console.error = quiet;
  }
  console.log(`identity-write-filters-shared-parse tests: PASS (${writes} escrituras)`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
