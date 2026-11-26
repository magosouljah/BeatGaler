'use strict';

// M7.4f: el filtro de registro lee los usuarios previos del índice de identidad en cada escritura.
// Caracterización (pasa en la base 314daab): los lectores nunca mutan el índice, lo escrito solo es
// visible tras el rename, las escrituras en secuencia conservan a los previos y los bytes preparados,
// los visibles y el snapshot a PG son los de la referencia literal (patrón M7.4e). Proceso propio:
// los parches de fs son globales.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installLegacyJsonCompatibility } = require('../control-plane-json-compat');
const { IdentitySnapshot } = require('../identity-store');
const {
  installAuthPublicRegistrationHardening,
  preserveUsersByStableId,
} = require('../auth-public-registration-hardening');
const { installAccountLifecycle } = require('../account-lifecycle');
const { installLifecyclePasswordAuthority } = require('../account-lifecycle-password-authority');

const NOW = 1_800_000_000_000;
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-m74f-'));
const auth = path.join(dir, 'accounts-data.json');
const authTmp = `${auth}.tmp`;

function user(i, extra = {}) {
  return {
    id: `usr_${i}`, username: `user${i}`, usernameSource: 'beatgaler', email: `user${i}@example.test`,
    passwordSalt: 'a'.repeat(32), passwordHash: `h${i}`.padEnd(64, 'b'), createdAt: NOW - i, providers: {}, ...extra,
  };
}
// Índice inicial con formas heredadas: id duplicado (gana el primero), id con espacios, sin id,
// tokens de X todavía en el índice (el filtro los quita solo de lo escrito).
const initial = {
  users: [
    user(1), user(2), user(3),
    user(2, { username: 'dup2', email: 'dup2@example.test' }),
    { ...user(7), id: ' usr_7 ' },
    { username: 'noid', email: 'noid@example.test' },
    user(8, { providers: { x: { id: '88', username: 'x8', accessToken: 'SECRET-AT-8', refreshToken: 'SECRET-RT-8', tokenExpiresAt: 8 } } }),
  ],
  sessions: { [sha('s1')]: { userId: 'usr_1', createdAt: NOW, expiresAt: NOW + 1e8 } },
};
const snapshots = [];
installLegacyJsonCompatibility({
  fsModule: fs,
  runtime: { saveAuthSnapshot: value => snapshots.push(JSON.stringify(value)), savePersistentSnapshot() {} },
  authPath: auth,
  persistentPath: path.join(dir, 'cloud-data.json'),
  initialAuth: initial,
  initialPersistent: {},
});
const express = { application: {}, json: () => (_req, _res, next) => next() };
installAuthPublicRegistrationHardening(express, {
  env: {},
  getAccountLifecycle: () => express.application.__beatgalerAccountLifecycleRuntime || null,
});
const life = installAccountLifecycle(express, {
  dataDir: dir, env: {}, now: () => NOW,
  getCapabilityStore: () => ({ async revokeAuthSession() {} }),
});
installLifecyclePasswordAuthority(life);
const state = life.api.state;

// Referencia literal (base 80476f2/314daab): ciclo de vida sobre el texto y registro con los previos
// leídos como copia completa del índice.
function reference(text) {
  let parsed = JSON.parse(text);
  for (const runtime of fs[Symbol.for('beatgaler.accountLifecyclePersistenceFilter')].runtimes) {
    parsed = runtime.api.state.filterAccountsValue(parsed);
  }
  parsed = JSON.parse(JSON.stringify(parsed, null, 2));
  if (Array.isArray(parsed?.users)) {
    parsed.users = preserveUsersByStableId(parsed.users, state.accountsSnapshot().users, state.deletedUserIds);
    for (const entry of parsed.users) {
      if (!entry?.providers?.x) continue;
      delete entry.providers.x.accessToken;
      delete entry.providers.x.refreshToken;
      delete entry.providers.x.tokenExpiresAt;
    }
  }
  return JSON.stringify(parsed, null, 2);
}

let writes = 0;
const view = () => JSON.stringify(state.accountsSnapshot());
function stage(label, value) {
  writes += 1;
  const text = JSON.stringify(value, null, 2);
  const expected = reference(text);
  const before = view();
  fs.writeFileSync(authTmp, text, 'utf8');
  assert.equal(fs.readFileSync(authTmp, 'utf8'), expected, `${label}: bytes preparados`);
  assert.equal(view(), before, `${label}: preparar no cambia el índice`);
  return expected;
}
function commit(label, expected) {
  const before = snapshots.length;
  fs.renameSync(authTmp, auth);
  assert.equal(snapshots.length, before + 1, `${label}: un snapshot a PG`);
  assert.equal(snapshots.at(-1), JSON.stringify(JSON.parse(expected)), `${label}: snapshot entregado a PG`);
  assert.equal(fs.readFileSync(auth, 'utf8'), expected, `${label}: bytes visibles tras el rename`);
  const committed = JSON.parse(expected);
  assert.equal(view(), JSON.stringify({ users: committed.users, sessions: committed.sessions }), `${label}: índice tras el rename`);
  return committed;
}
const save = (label, value) => commit(label, stage(label, value));
const current = () => JSON.parse(fs.readFileSync(auth, 'utf8'));

function main() {
  // 1. Aislamiento en la ruta de escritura: los previos conservados se renombran y se limpian de
  //    tokens solo en lo escrito; el índice no cambia hasta el rename.
  let value = current();
  value.users = value.users.filter(u => !['usr_3', 'usr_8'].includes(String(u.id).trim()));
  value.users.push(user(6, { username: 'user3' }));
  const original = view();
  const staged = stage('previos conservados', value);
  const out = JSON.parse(staged);
  assert.match(out.users.find(u => u.id === 'usr_3').username, /^user3#\d{4}$/);
  assert.deepEqual(out.users.find(u => u.id === 'usr_8').providers.x, { id: '88', username: 'x8' });
  assert.equal(out.users.filter(u => u.id === 'usr_2').length, 1, 'id duplicado: una sola entrada');
  assert.equal(state.userById('usr_3').username, 'user3', 'el índice conserva el nombre original');
  assert.equal(state.userById('usr_8').providers.x.accessToken, 'SECRET-AT-8', 'el índice conserva su registro');
  // Repetir la misma preparación da los mismos bytes: el primer paso no alteró a los previos.
  assert.equal(stage('previos conservados (repetido)', value), staged);
  assert.equal(view(), original, 'sin rename el índice es el inicial');

  // 2. Las copias entregadas a los lectores no alteran el índice ni lecturas ni escrituras siguientes.
  const copy = state.accountsSnapshot();
  copy.users[2].username = 'HACKED';
  copy.users[6].providers.x.accessToken = 'HACKED';
  copy.users.length = 0;
  delete copy.sessions[sha('s1')];
  const byId = state.userById('usr_3');
  byId.username = 'HACKED-BY-ID';
  assert.equal(view(), original, 'mutar copias no altera el índice');
  assert.equal(stage('previos tras mutar copias', value), staged, 'ni la escritura siguiente');

  // 3. Visibilidad tras el rename.
  let committed = commit('previos conservados', staged);
  assert.match(state.userById('usr_3').username, /^user3#\d{4}$/);
  assert.equal(state.userById('usr_8').providers.x.accessToken, undefined);
  assert.equal(committed.users.some(u => u.username === 'noid'), false, 'sin id no se conserva');

  // 4. Escrituras en secuencia: cada una conserva a los previos del índice confirmado.
  value = current();
  value.users = value.users.filter(u => u.id !== 'usr_1');
  committed = save('omite usr_1', value);
  assert.ok(committed.users.some(u => u.id === 'usr_1'));
  value = current();
  value.users = [user(9, { username: 'USER1' })];
  committed = save('solo un usuario nuevo', value);
  assert.equal(committed.users[0].id, 'usr_9');
  assert.ok(['usr_1', 'usr_2', 'usr_3', 'usr_6', 'usr_8'].every(id => committed.users.some(u => u.id === id)));
  state.deletedUserIds.add('usr_2');
  value = current();
  value.users = value.users.filter(u => u.id !== 'usr_2');
  committed = save('lápida no resucita', value);
  assert.equal(committed.users.some(u => u.id === 'usr_2'), false);
  value = current();
  const kept = value.users.map(u => u.id);
  value.users = [];
  committed = save('lista vacía', value);
  assert.deepEqual(committed.users.map(u => u.id).sort(), kept.sort(), 'todos los previos se conservan');

  // 5. Diferencial con semilla, centrado en previos: omisiones, colisiones, ids con espacios, lápidas.
  let seed = 0x74f;
  const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let step = 0; step < 120; step += 1) {
    value = current();
    const op = rnd(7);
    const id = 20 + rnd(25);
    if (op === 0) value.users.push(user(id, { username: rnd(2) ? `user${rnd(10)}` : `u${id}` }));
    if (op === 1) value.users = value.users.filter(() => rnd(3) !== 0);
    if (op === 2 && value.users.length) value.users.splice(rnd(value.users.length), 1);
    if (op === 3 && value.users.length) value.users[rnd(value.users.length)].username = `USER${rnd(10)}`;
    if (op === 4) value.users.push({ ...user(id), id: `  usr_${id} ` });
    if (op === 5) state.deletedUserIds.add(`usr_${id}`);
    if (op === 6 && value.users.length) value.users[rnd(value.users.length)].providers = { x: { id: String(id), accessToken: `SECRET-${id}` } };
    const expected = stage(`fuzz ${step}`, value);
    assert.equal(expected.includes('SECRET'), false, `fuzz ${step}: sin tokens`);
    if (rnd(4) !== 0) commit(`fuzz ${step}`, expected);
  }

  // 6. IdentitySnapshot directo: copy() es independiente del índice y de las demás copias.
  const snap = new IdentitySnapshot(initial);
  const a = snap.copy();
  a.users[0].username = 'X';
  a.users.pop();
  assert.equal(snap.copy().users.length, initial.users.length);
  assert.equal(snap.copy().users[0].username, 'user1');
  assert.equal(snap.userById('usr_1').username, 'user1');
  initial.users[0].username = 'MUTATED-SOURCE';
  assert.equal(snap.userById('usr_1').username, 'user1', 'el índice no comparte la entrada');
  initial.users[0].username = 'user1';
  if (typeof snap.copyUsersWhere === 'function') copyUsersWhereCases(snap);

  console.log(`identity-write-previous-users tests: PASS (${writes} preparaciones)`);
}

// Accesor de M7.4f: copia solo los usuarios seleccionados, en orden, sin exponer el índice.
function copyUsersWhereCases(snap) {
  const seen = [];
  const picked = snap.copyUsersWhere(key => { seen.push(key); return key.trim() === 'usr_2' || key === 'usr_8'; });
  assert.deepEqual(seen, ['usr_1', 'usr_2', 'usr_3', 'usr_2', ' usr_7 ', '', 'usr_8'], 'el selector recibe solo la clave, en orden');
  assert.deepEqual(picked.map(u => u.username), ['user2', 'dup2', 'user8']);
  assert.deepEqual(picked, [initial.users[1], initial.users[3], initial.users[6]]);
  picked[0].username = 'X';
  picked[2].providers.x.accessToken = 'X';
  picked.length = 0;
  assert.equal(snap.userById('usr_2').username, 'user2', 'mutar lo devuelto no altera el índice');
  assert.equal(snap.copy().users[6].providers.x.accessToken, 'SECRET-AT-8');
  assert.deepEqual(snap.copyUsersWhere(() => true), snap.copy().users);
  assert.deepEqual(snap.copyUsersWhere(() => false), []);
  const empty = new IdentitySnapshot(null);
  assert.deepEqual(empty.copyUsersWhere(() => true), []);
}

try {
  const quiet = console.error;
  console.error = () => {};
  try { main(); } finally { console.error = quiet; }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
