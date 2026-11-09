'use strict';
// T05-N — Autoridad nativa y cerco de capa 1 sin PostgreSQL real (pools falsos, red denegada). NATIVO r2.1 §3, §5.1, §6.2, §8.5, §12.
// Las pruebas contra PostgreSQL real están en catalog-authority.integration.cjs (suite T05 del runner).
process.env.DIRECT_DIAGNOSTICS_DIR = process.env.DIRECT_DIAGNOSTICS_DIR || require('path').join(__dirname, '..', '..', '..', 'tmp', 't05-diag');
const test = require('node:test');
const assert = require('node:assert/strict');
const authority = require('../../catalog/authority.js');
const fence = require('../../catalog/legacy-fence.js');
const quarantine = require('../../catalog/flush-quarantine.js');
const { createLibraryIndexPublication } = require('../../library-index-publication.js');
const { createVaultIndexPointerStore } = require('../../vault-index-pointer-store.js');
const { createDirectIndexPinAuthority } = require('../../direct-index-pin-authority.js');
const { installDirectCapabilityBoundary } = require('../../direct-capability-boundary.js');
const { mergeAuthSnapshotDelta } = require('../../postgres-auth-multiprocess-compat.js');
const { createUserStorageLifecycle } = require('../../user-storage-lifecycle.js');

const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const ACTIVATION_ROW = { environment_id: 'lab', run_id: 'r1', transport_bot_ids: '["Bot20"]', direct_token_exposure: 'FRESH_BOTS', activated_at: new Date() };

// Pool falso: responde por patrón y registra toda sentencia que escriba.
function fakePool({ catalogUsers = [], catalogChats = [], activation = ACTIVATION_ROW, library = null, vault = null, quarantined = false, onQuery = null } = {}) {
  const statements = [];
  const writes = () => statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(s));
  async function query(sql, params = []) {
    statements.push(String(sql));
    if (onQuery) { const r = onQuery(String(sql), params); if (r !== undefined) return r; }
    const text = String(sql);
    if (/catalog-legacy-fence/.test(text)) {
      if (/catalog_library_chats/.test(text)) return { rows: catalogChats.includes(String(params[0])) ? [{ '?column?': 1 }] : [] };
      return { rows: catalogUsers.includes(String(params[0])) ? [{ '?column?': 1 }] : [] };
    }
    if (/FROM catalog_native_activation/.test(text)) return { rows: activation ? [activation] : [] };
    if (/FROM control_plane_flush_quarantine WHERE user_id/.test(text)) return { rows: quarantined ? [{ '?column?': 1 }] : [] };
    if (/FROM catalog_libraries l\s+LEFT JOIN catalog_generations/.test(text)) return { rows: library ? [library] : [] };
    if (/FROM vaults v WHERE v\.user_id = \$1/.test(text)) return { rows: vault ? [vault] : [] };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(text.trim())) return { rows: [] };
    return { rows: [] };
  }
  const client = { query, release() {} };
  return { query, async connect() { return client; }, statements, writes };
}

const eligibleVault = () => ({ id: 'v1', user_id: 'u1', telegram_chat_id: '-1001', catalog_native_eligible: true, index_bootstrap_pending: true, transport_bot_id: 'Bot20',
  chat_known: false, t_vault_index_pointers: false, t_library_quota_state: false, t_library_beats: false, t_library_trash_purges: false, t_library_beat_reservations: false,
  t_library_project_uploads: false, t_library_legacy_project_copies: false, t_pin_authority: false, t_garbage_journal: false, t_index_observations: false,
  t_direct_operations_live: false, t_direct_capabilities_index: false });

test('config: flag nativo por entorno; el flag de borrado de cuenta no se puede encender (§6.1)', () => {
  assert.equal(authority.catalogNativeConfig({}).nativeEnabled, false);
  assert.equal(authority.catalogNativeConfig(ENV_ON).nativeEnabled, true);
  assert.throws(() => authority.catalogNativeConfig({ BEATGALER_ACCOUNT_DELETION_ENABLED: 'true' }), /cannot be enabled/);
  assert.equal(authority.catalogNativeConfig({ BEATGALER_ACCOUNT_DELETION_ENABLED: 'false' }).accountDeletionEnabled, false);
});

test('disponibilidad: flag, authority postgres, pool y activación → 503 CATALOG_UNAVAILABLE sin efectos (§3.4.1, PASS 5)', async () => {
  const cases = [
    [{ pool: fakePool(), env: {}, controlPlaneAuthority: 'postgres' }, 'NATIVE_FLAG_DISABLED'],
    [{ pool: fakePool(), env: ENV_ON, controlPlaneAuthority: 'json' }, 'CONTROL_PLANE_NOT_POSTGRES'],
    [{ pool: null, env: ENV_ON, controlPlaneAuthority: 'postgres' }, 'POSTGRES_UNAVAILABLE'],
    [{ pool: fakePool({ activation: null }), env: ENV_ON, controlPlaneAuthority: 'postgres' }, 'NOT_ACTIVATED'],
    [{ pool: fakePool({ onQuery: (sql) => { if (/catalog_native_activation/.test(sql)) throw Object.assign(new Error('boom'), { code: '42P01' }); } }), env: ENV_ON, controlPlaneAuthority: 'postgres' }, 'SQL_ERROR'],
  ];
  for (const [opts, reason] of cases) {
    const a = authority.createCatalogAuthority(opts);
    for (const fn of [() => a.resolveContext({ userId: 'u1' }), () => a.provisionLibrary({ userId: 'u1' })]) {
      await assert.rejects(fn, (e) => e.code === 'CATALOG_UNAVAILABLE' && e.status === 503 && e.detail.reason === reason);
    }
    if (opts.pool) assert.deepEqual(opts.pool.writes(), [], reason);
  }
});

test('resolveContext es de solo lectura y un error SQL nunca equivale a biblioteca vacía (§3.3, PASS 2)', async () => {
  const pool = fakePool({ vault: eligibleVault() });
  const a = authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres' });
  await assert.rejects(a.resolveContext({ userId: 'u1' }), (e) => e.code === 'LIBRARY_NOT_PROVISIONED' && e.status === 404);
  assert.ok(pool.statements.some((s) => /^BEGIN READ ONLY/.test(s)), 'lectura en transacción READ ONLY');
  assert.deepEqual(pool.writes(), []);
  const broken = fakePool({ onQuery: (sql) => { if (/FROM catalog_libraries/.test(sql)) throw Object.assign(new Error('timeout'), { code: '57014' }); } });
  const b = authority.createCatalogAuthority({ pool: broken, env: ENV_ON, controlPlaneAuthority: 'postgres' });
  await assert.rejects(b.resolveContext({ userId: 'u1' }), (e) => e.code === 'CATALOG_UNAVAILABLE' && e.detail.sqlstate === '57014');
  const legacy = fakePool({ library: { user_id: 'u1', authority: 'LEGACY' } });
  await assert.rejects(authority.createCatalogAuthority({ pool: legacy, env: ENV_ON, controlPlaneAuthority: 'postgres' }).resolveContext({ userId: 'u1' }),
    (e) => e.code === 'LIBRARY_RESET_REQUIRED' && e.status === 409);
  const quarantinedPool = fakePool({ quarantined: true, vault: eligibleVault() });
  await assert.rejects(authority.createCatalogAuthority({ pool: quarantinedPool, env: ENV_ON, controlPlaneAuthority: 'postgres' }).resolveContext({ userId: 'u1' }),
    (e) => e.code === 'VAULT_QUARANTINED' && e.status === 409);
  await assert.rejects(a.resolveContext({ userId: '' }), /CATALOG_TENANT_REQUIRED/);
});

test('predicado nativo: cada rastro legacy, marca ausente, chat registrado o bot fuera de lista → no elegible (PASS 3)', () => {
  const activation = { transportBotIds: ['Bot20'] };
  assert.deepEqual(authority.evaluateNativePredicate(eligibleVault(), activation), { eligible: true, reasons: [] });
  assert.deepEqual(authority.evaluateNativePredicate(null, activation).reasons, ['NO_VAULT']);
  assert.deepEqual(authority.evaluateNativePredicate({ ...eligibleVault(), catalog_native_eligible: false }, activation).reasons, ['NOT_MARKED_ELIGIBLE']);
  assert.deepEqual(authority.evaluateNativePredicate({ ...eligibleVault(), index_bootstrap_pending: false }, activation).reasons, ['BOOTSTRAP_NOT_PENDING']);
  assert.deepEqual(authority.evaluateNativePredicate({ ...eligibleVault(), chat_known: true }, activation).reasons, ['CHAT_ALREADY_REGISTERED']);
  assert.deepEqual(authority.evaluateNativePredicate({ ...eligibleVault(), transport_bot_id: 'Bot99' }, activation).reasons, ['TRANSPORT_BOT_NOT_ALLOWED']);
  const traces = Object.keys(eligibleVault()).filter((k) => k.startsWith('t_'));
  assert.equal(traces.length, 12, 'lista exacta de rastros legacy del predicado');
  for (const t of traces) assert.deepEqual(authority.evaluateNativePredicate({ ...eligibleVault(), [t]: true }, activation).reasons, [`LEGACY_TRACE:${t.slice(2)}`]);
});

test('provision con pool falso: orden de escrituras §3.4.5 e idempotencia por fila existente', async () => {
  const libRow = { user_id: 'u1', vault_id: 'v1', authority: 'POSTGRES', migration_state: 'IDLE', authority_era: 'era-1', authority_epoch: '1', revision: '1',
    active_generation_id: 'native-x', active_count: '0', trash_count: '0', purging_count: '0', pending_count: '0', cleanup_enabled: false, restore_hold: true,
    generation_origin: 'NATIVE', generation_status: 'ACTIVE', current_chat_id: '-1001' };
  let libraryRows = [];
  const pool = fakePool({ vault: eligibleVault(), onQuery: (sql) => {
    if (/FROM catalog_libraries l\s+LEFT JOIN catalog_generations/.test(sql)) return { rows: libraryRows };
    if (/^INSERT INTO catalog_libraries/.test(sql.trim())) { libraryRows = [libRow]; return { rows: [{ authority_era: 'era-1' }] }; }
  } });
  const a = authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres', randomUUID: () => 'x' });
  const first = await a.provisionLibrary({ userId: 'u1' });
  assert.equal(first.created, true);
  assert.equal(first.context.authority, 'POSTGRES');
  const order = pool.writes().map((s) => s.trim().split(/\s+/).slice(0, 3).join(' '));
  assert.deepEqual(order, ['INSERT INTO catalog_libraries(user_id,', 'INSERT INTO catalog_generations(user_id,', 'INSERT INTO catalog_library_chats(provider,',
    'UPDATE direct_capabilities SET', 'UPDATE vaults SET']);
  const lockAt = pool.statements.findIndex((s) => /SELECT id FROM vaults WHERE user_id = \$1 FOR UPDATE/.test(s));
  const predicateAt = pool.statements.findIndex((s) => /FROM vaults v WHERE v\.user_id = \$1/.test(s));
  assert.ok(lockAt > 0 && predicateAt > lockAt, 'lock del vault en una sentencia previa al predicado (snapshot posterior al lock)');
  assert.ok(pool.statements.find((s) => /INSERT INTO catalog_generations/.test(s)).includes("'NATIVE'"));
  assert.ok(pool.statements.find((s) => /INSERT INTO catalog_libraries/.test(s)).includes("'POSTGRES', 'IDLE'"));
  const before = pool.writes().length;
  const second = await a.provisionLibrary({ userId: 'u1' });
  assert.deepEqual([second.created, second.context.generation_id, second.context.authority_era], [false, 'native-x', 'era-1']);
  assert.equal(pool.writes().length, before, 'la segunda provisión no escribe');
});

test('stripDirectCredentials: la sesión catalog-v1 serializada no contiene bot_token, api_id ni api_hash (§8.5, PASS 7b)', () => {
  const session = { ok: true, mode: 'telegram-direct-botapi-local', bot_token: '123:abc', telegram_api_id: 1, telegram_api_hash: 'h', chat_id: '-1001', generation: 2 };
  const stripped = authority.stripDirectCredentials(session);
  assert.equal(authority.containsDirectCredentials(JSON.stringify(session)), true);
  assert.equal(authority.containsDirectCredentials(JSON.stringify(stripped)), false);
  assert.deepEqual(Object.keys(stripped), ['ok', 'mode', 'chat_id', 'generation']);
  // Valores ficticios solo para construir la respuesta en memoria: no hay red ni Telegram en esta suite.
  process.env.TELEGRAM_API_ID = process.env.TELEGRAM_API_ID || '1';
  process.env.TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH || 'test-only-hash';
  const dtc = require('../../direct-transport-control.js');
  const runtime = { id: 's1', bot: { id: 'Bot20', telegram_user_id: '7', telegram_username: 'bot' }, chatId: '-1001', token: 'secret-token', generation: 1, credentialVersion: 1, startedAt: 0, resolverChatId: null };
  const legacy = JSON.stringify(dtc.__test.sessionPublic(runtime, 'ACTIVE'));
  const native = JSON.stringify(dtc.__test.sessionPublic(runtime, 'ACTIVE', { protocol: authority.CATALOG_SESSION_PROTOCOL }));
  assert.equal(authority.containsDirectCredentials(legacy), true, 'el modo legacy sigue igual');
  assert.equal(authority.containsDirectCredentials(native), false);
  assert.equal(native.includes('secret-token'), false);
  assert.ok(JSON.parse(native).protocol === 'catalog-v1');
});

test('capa 1 por helper: cada entrada C10 de library-index-publication rechaza con 410 y 0 llamadas externas (PASS 7)', async () => {
  const calls = { transport: 0 };
  const spy = (name) => async () => { calls.transport += 1; throw new Error(`${name} must not be called`); };
  const transport = { getPinnedMessage: spy('getPinnedMessage'), publishIndexBuffer: spy('publishIndexBuffer'), downloadMessageBuffer: spy('downloadMessageBuffer'),
    deleteMessages: spy('deleteMessages'), deleteAndVerifyMessages: spy('deleteAndVerifyMessages'), pinExistingIndexMessage: spy('pinExistingIndexMessage'),
    readPinnedIndexBuffer: spy('readPinnedIndexBuffer'), copyLegacyProjectPart: spy('copyLegacyProjectPart'), verifyLegacyProjectCopy: spy('verifyLegacyProjectCopy') };
  const pool = fakePool({ catalogUsers: ['native'], catalogChats: ['-1009'], onQuery: (sql, params) => {
    if (/SELECT id FROM vaults WHERE user_id=\$1 AND telegram_chat_id=\$2/.test(sql)) return { rows: [{ id: 'v-native' }] };
    if (/SELECT id,telegram_chat_id,index_bootstrap_pending FROM vaults/.test(sql)) return { rows: [{ id: 'v-native', telegram_chat_id: params[0] === 'native' ? '-1009' : '-1', index_bootstrap_pending: true }] };
  } });
  const pub = createLibraryIndexPublication({ pool, transport, readIndex: spy('readIndex') });
  const manifest = { schema: 'beatgaler.telegram.library', version: 2, beats: [], trash: [], deleted: [] };
  const entries = {
    publish: () => pub.publish({ userId: 'native', chatId: '-1009', manifest, expectedMessageId: 0 }),
    purgeTrash: () => pub.purgeTrash({ userId: 'native', chatId: '-1009', beatIds: ['b1'] }),
    recover: () => pub.recover({ userId: 'native', chatId: '-1009' }),
    migrateLegacyProjects: () => pub.migrateLegacyProjects({ userId: 'native', chatId: '-1009' }),
    reserve: () => pub.reserve({ userId: 'native', beatId: 'b1' }),
    ensureBootstrap: () => pub.ensureBootstrap('native'),
    verifyCommitted: () => pub.verifyCommitted({ userId: 'native', chatId: '-1009', messageId: 5 }),
    assertPurged: () => pub.assertPurged({ userId: 'native', beatIds: ['b1'] }),
    renew: () => pub.renew({ userId: 'native', beatId: 'b1' }),
    cancel: () => pub.cancel({ userId: 'native', beatId: 'b1' }),
    authorizeProject: () => pub.authorizeProject({ userId: 'native', declaredBytes: 1 }),
    uploadProject: () => pub.uploadProject({ userId: 'native', chatId: '-1009' }),
    byChatOnly: () => pub.recover({ userId: 'other-user', chatId: '-1009' }),
  };
  for (const [name, run] of Object.entries(entries)) {
    const before = pool.writes().length;
    await assert.rejects(run, (e) => e.code === 'LEGACY_CLIENT_UNSUPPORTED' && e.status === 410, name);
    assert.equal(pool.writes().length, before, `${name}: 0 escrituras SQL legacy`);
  }
  assert.equal(calls.transport, 0, '0 llamadas a Telegram/MASTER');
  // Un usuario sin catálogo pasa el cerco y llega a su lógica legacy (aquí: falla por falta de INDEX, no por el cerco).
  await assert.rejects(pub.reserve({ userId: 'legacy-user', beatId: 'b1' }), (e) => e.code !== 'LEGACY_CLIENT_UNSUPPORTED');
});

test('capa 1 bajo el lock: provisión concurrente entre la entrada y FOR UPDATE falla cerrada antes de pinned/publishIndexBuffer (PASS 7)', async () => {
  let locked = false;
  const external = [];
  const pool = fakePool({ onQuery: (sql) => {
    if (/catalog-legacy-fence/.test(sql)) return { rows: locked ? [{ '?column?': 1 }] : [] }; // la provisión gana tras el lock
    if (/FROM vaults WHERE user_id=\$1 FOR UPDATE/.test(sql)) { locked = true; return { rows: [{ id: 'v1', telegram_chat_id: '-1001', index_bootstrap_pending: true }] }; }
    if (/SELECT 1 FROM library_quota_state/.test(sql)) return { rows: [] };
  } });
  const transport = { getPinnedMessage: async () => { external.push('pinned'); return null; }, publishIndexBuffer: async () => { external.push('publish'); return { messageId: 1 }; },
    downloadMessageBuffer: async () => { external.push('download'); return Buffer.alloc(0); } };
  const pub = createLibraryIndexPublication({ pool, transport });
  const manifest = { schema: 'beatgaler.telegram.library', version: 2, beats: [], trash: [], deleted: [] };
  await assert.rejects(pub.publish({ userId: 'u1', chatId: '-1001', manifest, expectedMessageId: 0 }), (e) => e.code === 'LEGACY_CLIENT_UNSUPPORTED');
  assert.deepEqual(external, ['pinned'], 'solo la lectura del pin previa al lock (sin estado de cuota); nada tras el lock');
  assert.ok(pool.statements.some((s) => /^ROLLBACK/.test(s)));
  assert.deepEqual(pool.writes(), []);
});

test('capa 1 en puntero INDEX, pin authority y capacidades INDEX (PASS 7)', async () => {
  const pool = fakePool({ catalogUsers: ['native'], catalogChats: ['-1009'] });
  const store = createVaultIndexPointerStore(pool);
  await assert.rejects(store.getForChat('-1009'), (e) => e.status === 410);
  await assert.rejects(store.compareAndSetForChat({ telegramChatId: '-1009', messageId: 3 }), (e) => e.status === 410);
  assert.deepEqual(pool.writes(), []);
  let restricted = 0;
  const pin = createDirectIndexPinAuthority({ pool: fakePool({ catalogChats: ['-1009'], onQuery: (sql) => {
    if (/SELECT transport_bot_id,index_pin_restricted_bot_id/.test(sql)) return { rows: [{ transport_bot_id: 'Bot20', index_pin_restricted_bot_id: null, project_media_restricted_bot_id: null }] };
  } }), transport: { restrictBotPinRights: async () => { restricted += 1; } } });
  await assert.rejects(pin.ensure({ chatId: '-1009', botId: 'Bot20', membershipState: 'ready' }), (e) => e.status === 410);
  assert.equal(restricted, 0);

  const routes = new Map();
  const express = { application: { post(route, ...handlers) { routes.set(route, handlers); return this; } } };
  installDirectCapabilityBoundary(express, { pool, env: {}, store: { async issue() {}, async revokeMissingOperations() { return 0; } } });
  let handlerRan = 0;
  express.application.post('/transport/operation/begin', (req, res) => { handlerRan += 1; res.json({ ok: true, operation_id: 'op1' }); });
  const run = (kind, scope) => new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { resolve({ status: this.statusCode, payload: p }); return this; } };
    const req = { headers: { authorization: 'Bearer t' }, beatgalerAuthorizedUserId: 'native', beatgalerAuthorizedTenantId: 'native', beatgalerAuthorizedInstallationId: 'i', body: { kind, scope } };
    const handlers = routes.get('/transport/operation/begin'); let i = 0;
    const next = () => { const h = handlers[i++]; return h ? h(req, res, next) : undefined; };
    next();
  });
  for (const kind of authority.INDEX_OPERATION_TYPES) {
    const r = await run(kind, { objectType: kind === 'delete_messages' ? 'message' : 'index', objectIds: [kind === 'delete_messages' ? '5' : 'pinned'] });
    assert.deepEqual([r.status, r.payload.code], [410, 'LEGACY_CLIENT_UNSUPPORTED'], kind);
  }
  assert.equal(handlerRan, 0, 'el handler nunca crea la operación Direct');
  const ok = await run('download', { objectType: 'message', objectIds: ['5'] });
  assert.equal(ok.status, 200, 'las operaciones de datos no cambian en T05');
});

test('respondLegacyFence solo responde a errores del cerco', () => {
  const sent = [];
  const res = { status(c) { sent.push(c); return this; }, json(p) { sent.push(p.code); return this; } };
  assert.equal(fence.respondLegacyFence(res, new Error('x')), false);
  assert.equal(fence.respondLegacyFence(res, new fence.CatalogLegacyFenceError('fenced')), true);
  assert.deepEqual(sent, [410, 'LEGACY_CLIENT_UNSUPPORTED']);
});

test('guardas §12: json + pool con activación/bibliotecas no arranca; re-cutover con activación se niega (PASS 13)', async () => {
  const activated = { async query(sql) { return /catalog_native_activation\)::int/.test(sql) ? { rows: [{ activations: 1, libraries: 0 }] } : { rows: [{ environment_id: 'lab' }] }; } };
  await assert.rejects(authority.assertNativeStartupCompatible({ pool: activated, authority: 'json' }), /CATALOG_NATIVE_STARTUP_REFUSED/);
  const libs = { async query() { return { rows: [{ activations: 0, libraries: 2 }] }; } };
  await assert.rejects(authority.assertNativeStartupCompatible({ pool: libs, authority: 'json' }), /CATALOG_NATIVE_STARTUP_REFUSED/);
  const clean = { async query() { return { rows: [{ activations: 0, libraries: 0 }] }; } };
  assert.deepEqual(await authority.assertNativeStartupCompatible({ pool: clean, authority: 'json' }), { checked: true, activations: 0, libraries: 0 });
  assert.deepEqual(await authority.assertNativeStartupCompatible({ pool: activated, authority: 'postgres' }), { checked: false });
  await assert.rejects(authority.assertNoNativeActivation(activated), /CATALOG_NATIVE_RECUTOVER_REFUSED/);
  await authority.assertNoNativeActivation({ async query() { return { rows: [] }; } });
  // stagePostgresCutover consulta la activación antes de cualquier escritura.
  const { stagePostgresCutover } = require('../../postgres-cutover-preparation.js');
  const statements = [];
  const pool = { async query(sql) { statements.push(String(sql)); return /catalog_native_activation/.test(sql) ? { rows: [{ environment_id: 'lab' }] } : { rows: [] }; }, async connect() { throw new Error('no debe conectar'); } };
  await assert.rejects(stagePostgresCutover(pool, { authRaw: JSON.stringify({ users: [], sessions: {} }), persistentRaw: JSON.stringify({}), cryptoConfig: { key: Buffer.alloc(32, 1), keyVersion: 1 } }),
    /CATALOG_NATIVE_RECUTOVER_REFUSED/);
  assert.equal(statements.filter((s) => /^(INSERT|UPDATE|DELETE)/i.test(s.trim())).length, 0);
});

test('flush §6.2: cuarentena por usuario, los demás hacen COMMIT y el respaldo del trigger reintenta una sola vez (PASS 7c)', async () => {
  const base = { users: [{ id: 'a', storageChatId: '-1001', storageCreatedAt: 1 }, { id: 'b', storageChatId: '-1002', storageCreatedAt: 1 }], sessions: {} };
  const changed = JSON.parse(JSON.stringify(base));
  changed.users[0].storageChatId = '-1009'; // a es nativo: conflicto
  changed.users[1].storageChatId = '-1008'; // b no es nativo: se vuelca
  const statements = [];
  const client = { async query(sql, params) {
    statements.push({ sql: String(sql), params });
    if (/flush-quarantine/.test(sql)) return { rows: [{ user_id: 'a', id: 'a', telegram_chat_id: '-1001', native: true, open_rebind_to: null }, { user_id: 'b', id: 'b', telegram_chat_id: '-1002', native: false, open_rebind_to: null }] };
    if (/count\(DISTINCT user_id\)/.test(sql)) return { rows: [{ n: 1 }] };
    return { rows: [], rowCount: 0 };
  }, release() {} };
  const result = await mergeAuthSnapshotDelta({ async connect() { return client; } }, changed, { key: Buffer.alloc(32, 7), keyVersion: 1 }, base);
  assert.deepEqual(result.quarantined, ['a']);
  const vaultInserts = statements.filter((s) => /INSERT INTO vaults/.test(s.sql)).map((s) => s.params[1]);
  assert.deepEqual(vaultInserts, ['b']);
  const q = statements.find((s) => /INSERT INTO control_plane_flush_quarantine/.test(s.sql));
  assert.deepEqual([q.params[0], q.params[1]], ['a', 'telegram_chat_id']);
  assert.ok(statements.findIndex((s) => /INSERT INTO control_plane_flush_quarantine/.test(s.sql)) < statements.findIndex((s) => s.sql === 'BEGIN'), 'cuarentena antes de BEGIN');
  assert.ok(statements.some((s) => s.sql === 'COMMIT'));

  // Respaldo del trigger: la pre-comprobación no ve el conflicto, el trigger lo rechaza con BGR03 y DETAIL user_id.
  let attempts = 0; const log = [];
  const client2 = { async query(sql, params) {
    log.push({ sql: String(sql), params });
    if (/flush-quarantine/.test(sql)) return { rows: [] };
    if (/INSERT INTO vaults/.test(sql) && params[1] === 'a') { attempts += 1; throw Object.assign(new Error('CATALOG_VAULT_REBIND_FORBIDDEN'), { code: 'BGR03', detail: 'user_id=a' }); }
    if (/count\(DISTINCT user_id\)/.test(sql)) return { rows: [{ n: 1 }] };
    return { rows: [], rowCount: 0 };
  }, release() {} };
  const r2 = await mergeAuthSnapshotDelta({ async connect() { return client2; } }, changed, { key: Buffer.alloc(32, 7), keyVersion: 1 }, base);
  assert.equal(attempts, 1, 'un solo reintento sin el usuario');
  assert.deepEqual(r2.quarantined, ['a']);
  assert.equal(log.filter((s) => s.sql === 'ROLLBACK').length, 1);
  assert.equal(log.filter((s) => s.sql === 'COMMIT').length, 1);
  // El primer intento aborta en 'a' (primera fila); el reintento vuelca solo 'b'.
  assert.deepEqual(log.filter((s) => /INSERT INTO vaults/.test(s.sql)).map((s) => s.params[1]), ['a', 'b']);
  // Si vuelve a fallar en el reintento, el flush se detiene (fail-closed sistémico).
  const client3 = { async query(sql, params) {
    if (/flush-quarantine/.test(sql)) return { rows: [] };
    if (/INSERT INTO vaults/.test(sql)) throw Object.assign(new Error('x'), { code: 'BGR03', detail: `user_id=${params[1]}` });
    return { rows: [], rowCount: 0 };
  }, release() {} };
  await assert.rejects(mergeAuthSnapshotDelta({ async connect() { return client3; } }, changed, { key: Buffer.alloc(32, 7), keyVersion: 1 }, base), /CONTROL_PLANE_FLUSH_HALTED/);
  assert.equal(quarantine.triggerQuarantineUser({ code: 'BGR03', detail: 'user_id=zz' }), 'zz');
  assert.equal(quarantine.triggerQuarantineUser({ code: '23505' }), null);
});

test('rechazo en origen §6.2.1: recoverMissing no verifica ni toca Telegram si el rebind está prohibido (PASS 10)', async () => {
  let verified = 0;
  const lifecycle = createUserStorageLifecycle({
    validateStoredChatId: (v) => v, createPrivateUserStorageGroup: async () => ({ botApiChatId: '-2', title: 't' }),
    verifyPrivateUserStorageGroup: async () => { verified += 1; return { status: 'missing', definitive: true }; },
    ensurePrivateUserStorageBotAbsent: async () => {}, masterStorageReady: () => true, storageGroupLimit: 10, getProvisionedStorageCount: () => 0,
    saveAuthData: () => {}, clearStorageBindingsForUser: () => {}, rebindStorageBindingsForUser: () => {}, ensureEmptyIndexForStorage: async () => {},
    assertVaultRebindAllowed: async ({ userId }) => { if (userId === 'native') throw new authority.CatalogAuthorityError('CATALOG_VAULT_REBIND_FORBIDDEN', 409, 'rebind'); return { native: false }; },
  });
  const user = { id: 'native', storageChatId: '-1001' };
  await assert.rejects(lifecycle.recoverMissing(user, { expectedStorageChatId: '-1001' }), /CATALOG_VAULT_REBIND_FORBIDDEN/);
  assert.equal(verified, 0);
  assert.equal(user.storageChatId, '-1001');
  assert.deepEqual(await authority.assertVaultRebindAllowedIfConfigured({ userId: 'x' }), { native: false, configured: false });
});

test('§6.1 deshabilitado: la autoridad no expone ninguna ruta de borrado de cuenta', () => {
  const a = authority.createCatalogAuthority({ pool: fakePool(), env: ENV_ON, controlPlaneAuthority: 'postgres' });
  assert.deepEqual(Object.keys(a).filter((k) => /delet|purge|remove/i.test(k)), []);
  const src = require('fs').readFileSync(require.resolve('../../catalog/authority.js'), 'utf8');
  assert.equal(/INSERT INTO catalog_account_deletions/.test(src), false);
});
