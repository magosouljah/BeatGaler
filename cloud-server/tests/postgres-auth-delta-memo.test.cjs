'use strict';
// M7.4c: el flush incremental de identidad (installMultiprocessAuthSnapshotCompatibility) debe emitir EXACTAMENTE las mismas
// sentencias y parámetros que el algoritmo de referencia sin memo (clone de la base deseada + buildLegacyRows previo/actual en
// cada flush). Secuencias: alta, cambio de email, nueva sesión, revocación, borrado, flush fallido + reintento (runtime que
// envenena y runtime que no), cuarentena de vault (pre-comprobación y respaldo del trigger 0027) y su resolución.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { clone, mergeAuthSnapshotDelta, installMultiprocessAuthSnapshotCompatibility } = require('../postgres-auth-multiprocess-compat');
const { PostgresControlPlaneRuntime } = require('../postgres-control-plane-runtime');
const { SQLSTATE } = require('../catalog/authority');

const CRYPTO = { key: Buffer.alloc(32, 7), keyVersion: 1 };
const FAR = 9_999_999_999_999;
const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function normalize(value) {
  if (Buffer.isBuffer(value)) return `<buffer:${value.length}>`; // nonces aleatorios: solo la forma
  if (value instanceof Date) return `<date:${value.toISOString()}>`;
  if (Array.isArray(value)) return value.map(normalize);
  return value;
}

// Pool falso determinista. `script` decide por sentencia: conflictos de vault, fallo inyectado (una vez) o error del trigger.
function fakePool(script) {
  const log = [];
  const fired = new Set();
  const client = {
    async query(sql, params) {
      const text = String(sql).replace(/\s+/g, ' ').trim();
      log.push({ sql: text, params: normalize(params || []) });
      for (const rule of script.rules || []) {
        if (rule.match.test(text) && !fired.has(rule)) {
          if (rule.once !== false) fired.add(rule);
          if (rule.throw) throw rule.throw();
          if (rule.rows) return { rows: rule.rows(params), rowCount: 0 };
        }
      }
      if (/flush-quarantine \*\/$/.test(text)) return { rows: (script.vaultsInSql || []).map(row => ({ ...row })), rowCount: 0 };
      if (/count\(DISTINCT user_id\)/.test(text)) return { rows: [{ n: script.openQuarantine || 0 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  return { log, async connect() { log.push({ sql: '<connect>' }); return client; } };
}

// Runtime que no se envenena (cola serie): un fallo deja seguir la cola, el caso en que un memo obsoleto sí importaría.
function lenientRuntime() {
  let tail = Promise.resolve();
  return {
    cryptoConfig: CRYPTO,
    enqueue(label, work) { const op = tail.then(work); tail = op.catch(() => {}); return op; },
    async flush() { await tail; },
  };
}

function realRuntime(pool) { return new PostgresControlPlaneRuntime({ pool, expectedSnapshotSha256: 'x', cryptoConfig: CRYPTO }); }

// Referencia: el instalador de la base 0833a59 (sin memo), reescrito aquí literalmente sobre las funciones exportadas.
function referenceInstall(runtime, pool, initialAuth) {
  let desired = clone(initialAuth);
  const quarantinedBase = new Map();
  const VAULT_FIELDS = ['storageChatId', 'storageChatTitle', 'storageCreatedAt'];
  runtime.saveAuthSnapshot = function saveAuthSnapshotDelta(snapshot) {
    const captured = clone(snapshot);
    const previous = clone(desired);
    for (const [userId, base] of quarantinedBase) {
      const user = (previous.users || []).find(item => String(item?.id) === userId);
      if (user) for (const field of VAULT_FIELDS) { if (base[field] === undefined) delete user[field]; else user[field] = base[field]; }
    }
    desired = captured;
    return runtime.enqueue('auth snapshot delta', async () => {
      const result = await mergeAuthSnapshotDelta(pool, captured, runtime.cryptoConfig, previous);
      for (const userId of result.quarantined || []) {
        if (!quarantinedBase.has(userId)) {
          const user = (previous.users || []).find(item => String(item?.id) === userId) || {};
          quarantinedBase.set(userId, Object.fromEntries(VAULT_FIELDS.map(field => [field, user[field]])));
        }
      }
      for (const userId of [...quarantinedBase.keys()]) if (!(result.quarantined || []).includes(userId)) quarantinedBase.delete(userId);
      return result;
    });
  };
  return runtime;
}

function baseAuth() {
  return {
    users: [
      { id: 'u1', username: 'alpha#0001', usernameSource: 'beatgaler', email: 'a@example.test', passwordHash: 'h1', passwordSalt: 's1', createdAt: 10, storageChatId: '-1001', storageChatTitle: 'A' },
      { id: 'u2', username: 'beta#0001', email: 'b@example.test', createdAt: 20, storageChatId: '-1002', storageChatTitle: 'B', providers: { google: { id: 'g-2', email: 'b@example.test' } } },
      { id: 'u3', username: 'gamma#0001', email: 'c@example.test', passwordHash: 'h3', passwordSalt: 's3', createdAt: 30, mfaSecret: 'JBSWY3DPEHPK3PXP', providers: { x: { id: 'x-3' } } },
    ],
    sessions: {
      [sha('t1')]: { userId: 'u1', createdAt: 11, expiresAt: FAR },
      [sha('t3')]: { userId: 'u3', createdAt: 31, expiresAt: FAR },
    },
  };
}

// Cada paso muta el estado de trabajo (como server-core) y entrega el snapshot completo al runtime (como el rename virtual).
const STEPS = {
  alta(s) { s.users.push({ id: 'u4', username: 'delta#0001', email: 'd@example.test', passwordHash: 'h4', passwordSalt: 's4', createdAt: 40 }); s.sessions[sha('t4')] = { userId: 'u4', createdAt: 41, expiresAt: FAR }; },
  email(s) { s.users.find(u => u.id === 'u1').email = 'a2@example.test'; },
  sesion(s) { s.sessions[sha('t2')] = { userId: 'u2', createdAt: 21, expiresAt: FAR }; },
  revocacion(s) { delete s.sessions[sha('t1')]; },
  borrado(s) { s.users = s.users.filter(u => u.id !== 'u3'); delete s.sessions[sha('t3')]; },
  sesion2(s) { s.sessions[sha('t5')] = { userId: 'u1', createdAt: 51, expiresAt: FAR }; },
  chatU2(s) { s.users.find(u => u.id === 'u2').storageChatId = '-2002'; },
  tituloU2(s) { s.users.find(u => u.id === 'u2').storageChatTitle = 'B2'; },
  chatU1(s) { s.users.find(u => u.id === 'u1').storageChatId = '-2001'; },
  nada() {},
};

// awaitEach=false encola todos los pasos antes del primer flush (rename seguidos sin respuesta intermedia); un número N espera
// solo los N primeros y encola el resto.
async function run({ install, makeRuntime, steps, script, awaitEach = true }) {
  const pool = fakePool(typeof script === 'function' ? script() : script);
  const runtime = makeRuntime(pool);
  const initial = baseAuth();
  await install(runtime, pool, initial);
  const state = clone(initial);
  const outcomes = [];
  const pending = [];
  for (const step of steps) {
    STEPS[step](state);
    let op;
    try { op = Promise.resolve(runtime.saveAuthSnapshot(clone(state))); } catch (error) { op = Promise.reject(error); }
    const settled = op.then(r => ({ step, ok: true, quarantined: r.quarantined }), e => ({ step, ok: false, error: String(e?.message || e) }));
    const wait = typeof awaitEach === 'number' ? outcomes.length < awaitEach : awaitEach;
    if (wait) outcomes.push(await settled); else pending.push(settled);
  }
  outcomes.push(...await Promise.all(pending));
  await Promise.resolve(runtime.flush()).catch(() => {});
  return { log: pool.log, outcomes, quarantine: [...(runtime.__beatgalerFlushQuarantine || new Map()).keys()] };
}

const productionInstall = (runtime, pool, initialAuth) => installMultiprocessAuthSnapshotCompatibility(runtime, pool, { initialAuth });
const referenceInstallAsync = async (runtime, pool, initialAuth) => referenceInstall(runtime, pool, initialAuth);

async function same(name, config) {
  const got = await run({ ...config, install: productionInstall });
  const want = await run({ ...config, install: referenceInstallAsync });
  assert.deepEqual(got.outcomes, want.outcomes, `${name}: resultados por paso`);
  assert.deepEqual(got.log, want.log, `${name}: sentencias y parámetros emitidos`);
  return got;
}

const sessionInsertFails = () => ({ rules: [{ match: /^INSERT INTO auth_sessions/, throw: () => new Error('injected auth_sessions failure') }] });
const vaultTrigger = userId => () => ({ rules: [{ match: /^INSERT INTO vaults/, once: false, throw: () => Object.assign(new Error('vault rebind forbidden'), { code: SQLSTATE.VAULT_REBIND_FORBIDDEN, detail: `user_id=${userId}` }) }], openQuarantine: 1 });
const nativeVault = (userId, chat) => ({ user_id: userId, id: `v-${userId}`, telegram_chat_id: chat, native: true, open_rebind_to: null });

(async () => {
  const lifecycle = ['alta', 'email', 'sesion', 'revocacion', 'borrado', 'sesion2'];
  for (const makeRuntime of [realRuntime, () => lenientRuntime()]) {
    const r = await same(`ciclo de vida (${makeRuntime === realRuntime ? 'real' : 'sin veneno'})`, { makeRuntime, steps: lifecycle, script: {} });
    // Comportamiento esperado concreto (no solo igualdad con la referencia).
    const sqls = r.log.map(entry => entry.sql);
    assert.ok(sqls.some(s => /^INSERT INTO users/.test(s)), 'alta inserta el usuario');
    assert.ok(r.log.some(e => /^UPDATE users SET email=\$2/.test(e.sql) && e.params[1] === 'a2@example.test'), 'cambio de email');
    assert.ok(r.log.some(e => /^DELETE FROM auth_sessions/.test(e.sql) && e.params[0].includes(sha('t1'))), 'revocación');
    assert.ok(r.log.some(e => /^DELETE FROM mfa_factors/.test(e.sql)) && r.log.some(e => /^DELETE FROM provider_identities/.test(e.sql)), 'borrado');
    assert.equal(r.log.filter(e => /^INSERT INTO auth_sessions/.test(e.sql) && e.params[0] === sha('t4')).length, 1, 'una sesión se emite una sola vez');
    assert.equal(r.log.filter(e => /^INSERT INTO users/.test(e.sql)).length, 1, 'un usuario sin cambios no se reemite');
  }
  // Renames seguidos antes del primer flush (la cola se llena sin respuesta intermedia).
  await same('ciclo de vida encolado', { makeRuntime: realRuntime, steps: lifecycle, script: {}, awaitEach: false });

  // Flush fallido seguido de reintento: con el runtime real queda envenenado; con uno que no envenena el delta siguiente se
  // calcula sobre la base deseada (comportamiento heredado), no sobre el último flush confirmado.
  const failReal = await same('fallo + reintento (real)', { makeRuntime: realRuntime, steps: ['email', 'sesion', 'sesion2', 'tituloU2'], script: sessionInsertFails });
  assert.deepEqual(failReal.outcomes.map(o => o.ok), [true, false, false, false]);
  const failLenient = await same('fallo + reintento (sin veneno)', { makeRuntime: () => lenientRuntime(), steps: ['email', 'sesion', 'sesion2', 'tituloU2', 'revocacion'], script: sessionInsertFails });
  assert.deepEqual(failLenient.outcomes.map(o => o.ok), [true, false, true, true, true]);
  assert.equal(failLenient.log.filter(e => /^INSERT INTO auth_sessions/.test(e.sql) && e.params[0] === sha('t2')).length, 1,
    'la sesión del flush fallido no se reemite (heredado)');
  await same('fallo + reintento encolado (sin veneno)', { makeRuntime: () => lenientRuntime(), steps: ['email', 'sesion', 'sesion2', 'tituloU2'], script: sessionInsertFails, awaitEach: false });

  // Fallo al construir filas (sal ausente) en el flush N: N+1 calcula su delta sobre N y falla igual.
  STEPS.salRota = s => { delete s.users.find(u => u.id === 'u1').passwordSalt; };
  STEPS.salOk = s => { s.users.find(u => u.id === 'u1').passwordSalt = 's1'; };
  await same('fallo de filas + reintento (sin veneno)', { makeRuntime: () => lenientRuntime(), steps: ['email', 'salRota', 'sesion', 'salOk', 'sesion2'], script: {} });

  // Cuarentena por pre-comprobación: u2 tiene biblioteca nativa con otro chat; su vault no avanza y se reintenta cada flush.
  const quarantineScript = () => ({ vaultsInSql: [nativeVault('u2', '-1002')], openQuarantine: 1 });
  const q = await same('cuarentena de vault', { makeRuntime: realRuntime, steps: ['chatU2', 'sesion', 'tituloU2', 'email', 'nada'], script: quarantineScript });
  assert.deepEqual(q.quarantine, ['u2']);
  assert.ok(q.log.filter(e => /^INSERT INTO control_plane_flush_quarantine/.test(e.sql)).length >= 4, 'la cuarentena se repite en cada flush');
  await same('cuarentena encolada', { makeRuntime: realRuntime, steps: ['chatU2', 'sesion', 'tituloU2', 'email'], script: quarantineScript, awaitEach: false });
  // Cuarentena ya conocida y varios renames encolados: la base forzada de un paso no debe alterar el snapshot del anterior.
  await same('cuarentena conocida + encolados', { makeRuntime: realRuntime, steps: ['chatU2', 'sesion', 'tituloU2', 'email', 'nada'], script: quarantineScript, awaitEach: 1 });
  // Resolución: SQL ya tiene el chat nuevo (rebind hecho) ⇒ sale de cuarentena y la base vuelve a avanzar.
  let resolved = false;
  STEPS.resolver = () => { resolved = true; };
  const resolution = await same('cuarentena resuelta', { makeRuntime: realRuntime, steps: ['chatU2', 'sesion', 'resolver', 'email', 'sesion2'], script: () => {
    resolved = false;
    return { rules: [{ match: /flush-quarantine \*\/$/, once: false, rows: () => [nativeVault('u2', resolved ? '-2002' : '-1002')] }], openQuarantine: 1 };
  } });
  assert.deepEqual(resolution.quarantine, []);
  // L3: resolución con guardados encolados mientras la cuarentena seguía abierta. El flush que la resuelve deja memo, pero el
  // siguiente se encoló con base forzada (clone): solo la comprobación de identidad impide usar el memo.
  await same('cuarentena resuelta con encolados', { makeRuntime: realRuntime, awaitEach: 1, steps: ['chatU2', 'resolver', 'email', 'sesion2'], script: () => {
    resolved = false;
    return { rules: [{ match: /flush-quarantine \*\/$/, once: false, rows: () => [nativeVault('u2', resolved ? '-2002' : '-1002')] }], openQuarantine: 1 };
  } });

  // Respaldo del trigger 0027: un único reintento sin el usuario, que queda en cuarentena.
  const trig = await same('trigger 0027', { makeRuntime: realRuntime, steps: ['chatU1', 'sesion', 'email', 'nada'], script: vaultTrigger('u1') });
  assert.deepEqual(trig.quarantine, ['u1']);
  console.log('postgres-auth-delta-memo tests: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
