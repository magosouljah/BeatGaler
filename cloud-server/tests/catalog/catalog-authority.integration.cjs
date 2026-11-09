'use strict';
// T05-N — Autoridad nativa, 0027 y cerco contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T05`).
// Cubre los criterios PASS de NATIVO r2.1 §15 (1–13). Cada test crea su DB efímera y la borra. Sin skips.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const { createLegacyFence } = require('../../catalog/legacy-fence.js');
const { createLibraryIndexPublication } = require('../../library-index-publication.js');
const { createVaultIndexPointerStore } = require('../../vault-index-pointer-store.js');
const { mergeAuthSnapshotDelta } = require('../../postgres-auth-multiprocess-compat.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const H = crypto.createHash('sha256').update('x').digest('hex');
const BOTS = '["Bot20","Bot21"]';

async function withDb(fn, { max = 8 } = {}) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max });
  try { await mig.applyMigrations(pool); return await fn(pool, h); } finally { await pool.end(); await h.cleanup(); }
}
async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    try { await fn(c); await c.query('COMMIT'); return 'OK'; } catch (e) { await c.query('ROLLBACK').catch(() => {}); return e.code || e.message; }
  } finally { c.release(); }
}
const one = (pool, sql, params) => tx(pool, (c) => c.query(sql, params));
async function activate(pool, env = 'lab') {
  await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20'), ('Bot21'), ('Bot99') ON CONFLICT DO NOTHING");
  await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory)
    VALUES ($1, 'run-1', $2, 'FRESH_BOTS', $3, '[]')`, [env, BOTS, H]);
}
async function user(pool, id, chat, extra = '') {
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query(`INSERT INTO vaults(id, user_id, telegram_chat_id ${extra ? ',' + extra.split('=')[0] : ''}) VALUES ($1, $2, $3 ${extra ? ',' + extra.split('=')[1] : ''})`, [`v-${id}`, id, chat]);
  return id;
}
const snapshot = async (pool) => (await pool.query(`SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) AS d FROM (
  SELECT 'L' || user_id || authority || coalesce(active_generation_id, '') || authority_epoch AS t FROM catalog_libraries
  UNION ALL SELECT 'G' || user_id || generation_id || status || origin FROM catalog_generations
  UNION ALL SELECT 'C' || chat_id || user_id || state FROM catalog_library_chats
  UNION ALL SELECT 'V' || id || user_id || telegram_chat_id || index_bootstrap_pending::text || catalog_native_eligible::text FROM vaults
  UNION ALL SELECT 'M' || user_id || object_id || status FROM catalog_media_objects
  UNION ALL SELECT 'Q' || user_id || index_message_id::text FROM library_quota_state
  UNION ALL SELECT 'B' || user_id || beat_id FROM library_beats
  UNION ALL SELECT 'P' || vault_id || index_message_id::text FROM vault_index_pointers
  UNION ALL SELECT 'D' || capability_hash || status FROM direct_capabilities) x`)).rows[0].d;
const count = async (pool, table) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
const auth = (pool, overrides = {}) => authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres', ...overrides });

test('PASS 1+2: vault elegible, GET /context nunca escribe y 20 provisiones concurrentes crean una sola biblioteca', () => withDb(async (pool, h) => {
  await activate(pool);
  const uid = await user(pool, 'u1', '-1001', 'transport_bot_id=\'Bot20\'');
  assert.deepEqual((await pool.query('SELECT catalog_native_eligible, index_bootstrap_pending FROM vaults WHERE id=$1', ['v-u1'])).rows[0], { catalog_native_eligible: true, index_bootstrap_pending: false });
  await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE id=$1', ['v-u1']); // las rutas de upsert lo ponen en true en INSERT nuevo (§3.2)
  await pool.query(`INSERT INTO direct_capabilities(capability_hash, internal_operation_id, user_id, tenant_id, installation_id, auth_session_hash, session_id, generation, vault_scope, operation_type, object_scope, status, issued_at, expires_at)
    VALUES ($1, 'op-1', $2, $2, 'inst', $3, 'sess', 1, 'v-u1', 'download', '{}', 'ACTIVE', now(), now() + interval '1 hour')`, [H, uid, H]);
  const a = auth(pool);
  const before = await snapshot(pool);
  await assert.rejects(a.resolveContext({ userId: uid }), (e) => e.code === 'LIBRARY_NOT_PROVISIONED' && e.status === 404);
  assert.equal(await snapshot(pool), before, 'GET /context: 0 filas nuevas');

  const pools = Array.from({ length: 4 }, () => new Pool({ ...h.config, max: 5 }));
  try {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => auth(pools[i % 4]).provisionLibrary({ userId: uid })));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(results.filter((r) => !r.created).length, 19);
    const gens = new Set(results.map((r) => r.context.generation_id)); assert.equal(gens.size, 1);
    const eras = new Set(results.map((r) => r.context.authority_era)); assert.equal(eras.size, 1);
  } finally { await Promise.all(pools.map((p) => p.end())); }
  assert.equal(await count(pool, 'catalog_libraries'), 1);
  const g = (await pool.query('SELECT status, origin, raw_index, source_hash, snapshot_id FROM catalog_generations')).rows;
  assert.equal(g.length, 1); assert.deepEqual([g[0].status, g[0].origin, g[0].raw_index], ['ACTIVE', 'NATIVE', null]);
  assert.match(g[0].snapshot_id, /^native:/);
  const lib = (await pool.query('SELECT authority, migration_state, authority_epoch, cleanup_enabled, restore_hold, active_count FROM catalog_libraries')).rows[0];
  assert.deepEqual(lib, { authority: 'POSTGRES', migration_state: 'IDLE', authority_epoch: '1', cleanup_enabled: false, restore_hold: true, active_count: '0' });
  assert.deepEqual((await pool.query('SELECT chat_id, state FROM catalog_library_chats')).rows, [{ chat_id: '-1001', state: 'CURRENT' }]);
  assert.deepEqual((await pool.query('SELECT status, revoke_reason FROM direct_capabilities')).rows, [{ status: 'REVOKED', revoke_reason: 'CATALOG_NATIVE' }]);
  assert.equal((await pool.query('SELECT index_bootstrap_pending FROM vaults WHERE id=$1', ['v-u1'])).rows[0].index_bootstrap_pending, false);
  const ctx = await a.resolveContext({ userId: uid });
  assert.deepEqual([ctx.authority, ctx.chat_id, ctx.generation_origin, ctx.counts.active], ['POSTGRES', '-1001', 'NATIVE', 0]);
  assert.equal(await count(pool, 'catalog_account_deletions'), 0, '§6.1: nada crea filas de borrado');
}));

test('PASS 3+4+5: no elegibles → RESET_REQUIRED con 0 escrituras; LEGACY → RESET; LEGACY tras activación y POSTGRES→LEGACY rechazados en DB; 503 sin flag/activación', () => withDb(async (pool) => {
  // Vault existente antes de la activación y re-upsertado después: la marca sigue en false (§3.2).
  const old = await user(pool, 'old', '-1000');
  await activate(pool);
  await pool.query(`INSERT INTO vaults(id,user_id,telegram_chat_id,index_bootstrap_pending,updated_at) VALUES('v-old2','old','-1000',true,now())
    ON CONFLICT(user_id) DO UPDATE SET telegram_chat_id=EXCLUDED.telegram_chat_id,updated_at=now()`);
  const a = auth(pool);
  const expectReset = async (uid, reason) => {
    const before = await snapshot(pool);
    const err = await a.provisionLibrary({ userId: uid }).then(() => null, (e) => e);
    assert.equal(err?.code, 'LIBRARY_RESET_REQUIRED', `${uid}: ${reason}`);
    assert.ok(err.detail.reasons.includes(reason), `${uid}: ${JSON.stringify(err.detail.reasons)} debe incluir ${reason}`);
    assert.equal(await snapshot(pool), before, `${uid}: 0 escrituras`);
    await assert.rejects(a.resolveContext({ userId: uid }), (e) => e.code === 'LIBRARY_RESET_REQUIRED');
  };
  await expectReset(old, 'NOT_MARKED_ELIGIBLE');
  // Nuevos vaults (marcados) con cada rastro legacy.
  const traces = [
    ['pointer', (u) => pool.query(`INSERT INTO vault_index_pointers(vault_id,index_message_id,source) VALUES ($1, 5, 'publish')`, [`v-${u}`]), 'LEGACY_TRACE:vault_index_pointers'],
    ['quota', (u) => pool.query('INSERT INTO library_quota_state(user_id,index_message_id,index_sha256) VALUES ($1,5,$2)', [u, H]), 'LEGACY_TRACE:library_quota_state'],
    ['beats', (u) => pool.query("INSERT INTO library_beats(user_id,beat_id,state) VALUES ($1,'b','ACTIVE')", [u]), 'LEGACY_TRACE:library_beats'],
    ['purges', (u) => pool.query("INSERT INTO library_trash_purges(user_id,beat_id,operation_id,state,asset_message_ids,beat_sha256) VALUES ($1,'b','p','PENDING','{}',$2)", [u, H]), 'LEGACY_TRACE:library_trash_purges'],
    ['reservations', (u) => pool.query("INSERT INTO library_beat_reservations(id,user_id,beat_id,state,expires_at) VALUES ('r',$1,'b','PENDING',now()+interval '1 hour')", [u]), 'LEGACY_TRACE:library_beat_reservations'],
    ['uploads', (u) => pool.query("INSERT INTO library_project_uploads(user_id,beat_id,sha256,message_id,telegram_document_id,size_bytes) VALUES ($1,'b',$2,9,'d',1)", [u, H]), 'LEGACY_TRACE:library_project_uploads'],
    ['copies', (u) => pool.query("INSERT INTO library_legacy_project_copies(user_id,beat_id,part_index,source_message_id,message_id,telegram_document_id,size_bytes) VALUES ($1,'b',0,1,2,'d',1)", [u]), 'LEGACY_TRACE:library_legacy_project_copies'],
    ['pin', (u) => pool.query("UPDATE vaults SET index_pin_restricted_bot_id='Bot20' WHERE user_id=$1", [u]), 'LEGACY_TRACE:pin_authority'],
    ['garbage', (u) => pool.query(`INSERT INTO garbage_journal(id,idempotency_key,vault_id,object_kind,object_id,reason,state,index_commit_ref) VALUES ('g-'||$1,'k-'||$1,$2,'media','1','orphan_upload','pending','c')`, [u, `v-${u}`]), 'LEGACY_TRACE:garbage_journal'],
    ['observations', (u) => pool.query('INSERT INTO index_observations(vault_id) VALUES ($1)', [`v-${u}`]), 'LEGACY_TRACE:index_observations'],
    ['operations', (u) => pool.query(`INSERT INTO direct_operations(id,idempotency_key,vault_id,operation_type,state) VALUES ('o-'||$1,'ok-'||$1,$2,'upload','PREPARED')`, [u, `v-${u}`]), 'LEGACY_TRACE:direct_operations_live'],
    ['capability', (u) => pool.query(`INSERT INTO direct_capabilities(capability_hash,internal_operation_id,user_id,tenant_id,installation_id,auth_session_hash,session_id,generation,vault_scope,operation_type,object_scope,status,issued_at,expires_at)
      VALUES (encode(sha256(convert_to($1,'UTF8')),'hex'),'op-'||$1,$1,$1,'i',$2,'s',1,'v','get_index','{}','EXPIRED',now()-interval '1 hour',now())`, [u, H]), 'LEGACY_TRACE:direct_capabilities_index'],
  ];
  let n = 0;
  for (const [name, seed, reason] of traces) {
    const u = await user(pool, `t${++n}`, `-20${String(n).padStart(2, '0')}`);
    await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [u]);
    await seed(u);
    await expectReset(u, reason);
  }
  // Chat ya registrado por otra biblioteca y bot fuera de la lista de activación.
  const owner = await user(pool, 'owner', '-3001'); await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [owner]);
  assert.equal((await a.provisionLibrary({ userId: owner })).created, true);
  const other = await user(pool, 'other', '-3002'); await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [other]);
  await pool.query(`INSERT INTO catalog_library_chats(provider,chat_id,user_id,vault_id,state,retired_at) VALUES ('telegram','-3002',$1,'v-owner','LEGACY_ABANDONED',now())`, [owner]);
  await expectReset(other, 'CHAT_ALREADY_REGISTERED');
  const bot = await user(pool, 'bot', '-3003', "transport_bot_id='Bot99'"); await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [bot]);
  await expectReset(bot, 'TRANSPORT_BOT_NOT_ALLOWED');
  // Sin bootstrap pendiente.
  const nb = await user(pool, 'nb', '-3004');
  await expectReset(nb, 'BOOTSTRAP_NOT_PENDING');
  // PASS 4: INSERT LEGACY con activación y POSTGRES→LEGACY rechazados en DB; fila LEGACY → RESET_REQUIRED.
  assert.equal(await one(pool, "INSERT INTO catalog_libraries(user_id, vault_id) VALUES ('nb','v-nb')"), 'BGA05');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET authority='LEGACY', active_generation_id=NULL WHERE user_id='owner'"), 'BGA05');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET migration_state='SHADOW' WHERE user_id='owner'"), 'BGA05');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET authority_epoch=0 WHERE user_id='owner'"), 'BGA05', 'la época nunca decrece (guarda nativa antes del CHECK de 0026)');
  // PASS 5: sin flag, sin activación → 503 y 0 efectos.
  const before = await snapshot(pool);
  await assert.rejects(authority.createCatalogAuthority({ pool, env: {}, controlPlaneAuthority: 'postgres' }).provisionLibrary({ userId: nb }), (e) => e.status === 503);
  await pool.query('DELETE FROM catalog_native_activation');
  await assert.rejects(a.provisionLibrary({ userId: nb }), (e) => e.status === 503 && e.detail.reason === 'NOT_ACTIVATED');
  assert.equal(await snapshot(pool), before);
}));

test('PASS 4 (LEGACY staging) + regresión T03/T04 por construcción: una fila LEGACY sin activación sigue libre; con fila LEGACY el contexto es RESET_REQUIRED', () => withDb(async (pool) => {
  const u = await user(pool, 'leg', '-4001');
  await pool.query("INSERT INTO catalog_libraries(user_id, vault_id) VALUES ('leg','v-leg')");
  await pool.query("INSERT INTO catalog_generations(user_id, generation_id, snapshot_id) VALUES ('leg','g1','s1')");
  // Sin activación ni origin nativo, 0027 no interfiere con T03/T04 (DELETE de LEGACY, LEGACY→POSTGRES, library_* libres).
  assert.equal(await one(pool, "INSERT INTO library_beats(user_id,beat_id,state) VALUES ('leg','b','ACTIVE')"), 'OK');
  assert.equal(await one(pool, "DELETE FROM library_beats WHERE user_id='leg'"), 'OK');
  assert.equal(await one(pool, "UPDATE catalog_generations SET status='VALIDATED', source_hash=$1, validated_at=now() WHERE generation_id='g1'", [H]), 'OK');
  assert.equal(await tx(pool, async (c) => {
    await c.query("UPDATE catalog_generations SET status='ACTIVE' WHERE generation_id='g1'");
    await c.query("UPDATE catalog_libraries SET active_generation_id='g1', authority='POSTGRES' WHERE user_id='leg'");
  }), 'OK');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET authority='LEGACY', active_generation_id=NULL WHERE user_id='leg'"), 'OK', 'sin activación ni origin nativo no hay guarda');
  assert.equal(await one(pool, "DELETE FROM catalog_libraries WHERE user_id='leg'"), 'OK');
  // Fila LEGACY con activación: RESET_REQUIRED, nunca se lee ni promociona.
  await pool.query("INSERT INTO catalog_libraries(user_id, vault_id) VALUES ('leg','v-leg')");
  await activate(pool);
  await assert.rejects(auth(pool).resolveContext({ userId: u }), (e) => e.code === 'LIBRARY_RESET_REQUIRED' && e.detail.reasons.includes('LIBRARY_LEGACY'));
  await assert.rejects(auth(pool).provisionLibrary({ userId: u }), (e) => e.code === 'LIBRARY_RESET_REQUIRED');
  assert.equal(await count(pool, 'catalog_generations'), 0);
}));

test('PASS 6: capa 0: cada tabla legacy rechaza escrituras (BGL01) para un usuario POSTGRES nativo; pin authority también', () => withDb(async (pool) => {
  await activate(pool);
  const u = await user(pool, 'n', '-5001'); await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [u]);
  const legacy = await user(pool, 'l', '-5002');
  assert.equal((await auth(pool).provisionLibrary({ userId: u })).created, true);
  const cases = {
    vault_index_pointers: (x) => pool.query("INSERT INTO vault_index_pointers(vault_id,index_message_id,source) VALUES ($1,5,'publish')", [`v-${x}`]),
    library_quota_state: (x) => pool.query('INSERT INTO library_quota_state(user_id,index_message_id,index_sha256) VALUES ($1,5,$2)', [x, H]),
    library_beats: (x) => pool.query("INSERT INTO library_beats(user_id,beat_id,state) VALUES ($1,'b','ACTIVE')", [x]),
    library_trash_purges: (x) => pool.query("INSERT INTO library_trash_purges(user_id,beat_id,operation_id,state,asset_message_ids,beat_sha256) VALUES ($1,'b','p','PENDING','{}',$2)", [x, H]),
    library_beat_reservations: (x) => pool.query("INSERT INTO library_beat_reservations(id,user_id,beat_id,state,expires_at) VALUES ('r',$1,'b','PENDING',now()+interval '1 hour')", [x]),
    library_project_uploads: (x) => pool.query("INSERT INTO library_project_uploads(user_id,beat_id,sha256,message_id,telegram_document_id,size_bytes) VALUES ($1,'b',$2,9,'d',1)", [x, H]),
    library_legacy_project_copies: (x) => pool.query("INSERT INTO library_legacy_project_copies(user_id,beat_id,part_index,source_message_id,message_id,telegram_document_id,size_bytes) VALUES ($1,'b',0,1,2,'d',1)", [x]),
    garbage_journal: (x) => pool.query("INSERT INTO garbage_journal(id,idempotency_key,vault_id,object_kind,object_id,reason,state,index_commit_ref) VALUES ('g'||$1,'k'||$1,$2,'media','1','orphan_upload','pending','c')", [x, `v-${x}`]),
    direct_operations_index: (x) => pool.query("INSERT INTO direct_operations(id,idempotency_key,vault_id,operation_type,state) VALUES ('o'||$1,'ok'||$1,$2,'replace_index','PREPARED')", [x, `v-${x}`]),
    direct_capabilities_index: (x) => pool.query(`INSERT INTO direct_capabilities(capability_hash,internal_operation_id,user_id,tenant_id,installation_id,auth_session_hash,session_id,generation,vault_scope,operation_type,object_scope,status,issued_at,expires_at)
      VALUES (encode(sha256(convert_to('c'||$1,'UTF8')),'hex'),'cop'||$1,$1,$1,'i',$2,'s',1,'v','get_index','{}','ACTIVE',now(),now()+interval '1 hour')`, [x, H]),
    pin_authority: (x) => pool.query("UPDATE vaults SET index_pin_restricted_bot_id='Bot20', index_pin_restricted_at=now() WHERE user_id=$1", [x]),
  };
  for (const [name, run] of Object.entries(cases)) {
    const err = await run(u).then(() => null, (e) => e);
    assert.equal(err?.code, 'BGL01', `${name}: nativo rechazado`);
    assert.equal(err.detail, `user_id=${u}`);
    await run(legacy); // el usuario legacy sigue escribiendo normalmente
  }
  // Operaciones y capacidades de datos (no INDEX) sí se permiten para el nativo (T12/T14 las usan con el gateway).
  await pool.query("INSERT INTO direct_operations(id,idempotency_key,vault_id,operation_type,state) VALUES ('od','okd','v-n','upload','PREPARED')");
  // DELETE/UPDATE de filas legacy preexistentes de un nativo también se rechazan (defensa del ledger, no cerco).
  assert.equal(await one(pool, "UPDATE library_beats SET state='TRASH' WHERE user_id='l'"), 'OK');
  assert.equal(await count(pool, 'library_beats'), 1);
}));

test('PASS 8: carrera provision contra publicación legacy: gana exactamente una y la otra falla cerrada sin efectos externos', () => withDb(async (pool, h) => {
  await activate(pool);
  const manifest = { schema: 'beatgaler.telegram.library', version: 2, beats: [], trash: [], deleted: [] };
  const raw = Buffer.from(JSON.stringify(manifest));
  for (const [winner, u, chat] of [['provision', 'race-a', '-6001'], ['publish', 'race-b', '-6002']]) {
    await user(pool, u, chat); await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [u]);
    const pool2 = new Pool({ ...h.config, max: 4 });
    const external = [];
    let publishedId = 0;
    const transport = {
      getPinnedMessage: async () => { external.push('pinned'); return publishedId ? { message_id: publishedId, caption: 'BEATGALER_LIBRARY_INDEX_V1' } : null; },
      readPinnedIndexBuffer: async () => { external.push('pinned'); return publishedId ? { message_id: publishedId, caption: 'BEATGALER_LIBRARY_INDEX_V1', raw } : null; },
      downloadMessageBuffer: async () => { external.push('download'); return raw; },
      publishIndexBuffer: async () => { external.push('publish'); publishedId = 7; return { messageId: 7 }; },
    };
    try {
      const pub = createLibraryIndexPublication({ pool: pool2, transport });
      // Serialización real por el lock del vault: un cliente retiene FOR UPDATE mientras ambos entran en orden.
      const holder = await pool.connect();
      await holder.query('BEGIN'); await holder.query('SELECT 1 FROM vaults WHERE user_id=$1 FOR UPDATE', [u]);
      const provision = () => auth(pool).provisionLibrary({ userId: u });
      const publish = () => pub.publish({ userId: u, chatId: chat, manifest, expectedMessageId: 0 });
      const first = winner === 'provision' ? provision() : publish();
      await new Promise((r) => setTimeout(r, 200));
      const second = winner === 'provision' ? publish() : provision();
      await new Promise((r) => setTimeout(r, 200));
      await holder.query('COMMIT'); holder.release();
      const [r1, r2] = await Promise.allSettled([first, second]);
      if (winner === 'provision') {
        assert.equal(r1.status, 'fulfilled', r1.reason?.message); assert.equal(r1.value.created, true);
        assert.equal(r2.status, 'rejected'); assert.equal(r2.reason.code, 'LEGACY_CLIENT_UNSUPPORTED');
        assert.equal(external.includes('publish'), false, 'la publicación legacy no llegó a Telegram');
        assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM library_quota_state WHERE user_id=$1', [u])).rows[0].n), 0);
      } else {
        assert.equal(r1.status, 'fulfilled', r1.reason?.message); assert.equal(r1.value.status, 'published');
        assert.equal(r2.status, 'rejected'); assert.equal(r2.reason.code, 'LIBRARY_RESET_REQUIRED');
        assert.ok(r2.reason.detail.reasons.includes('LEGACY_TRACE:library_quota_state'), JSON.stringify(r2.reason.detail));
        assert.equal(Number((await pool.query('SELECT count(*)::int AS n FROM catalog_libraries WHERE user_id=$1', [u])).rows[0].n), 0);
      }
    } finally { await pool2.end(); }
  }
}));

test('PASS 9+7d: cascadas y TRUNCATE rechazados; DELETE users sin §6.1 autorizado se rechaza; con GUC+MEDIA_DELETED pasa', () => withDb(async (pool) => {
  await activate(pool);
  const u = await user(pool, 'cas', '-7001'); await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [u]);
  await auth(pool).provisionLibrary({ userId: u });
  await pool.query("INSERT INTO catalog_media_objects(user_id,object_id,provider,chat_id,message_id,status) VALUES ('cas','m1','telegram','-7001',10,'PRESENT')");
  const before = await snapshot(pool);
  for (const [sql, code] of [
    ["DELETE FROM users WHERE id='cas'", 'BGC02'], ["DELETE FROM vaults WHERE user_id='cas'", 'BGC02'], ["DELETE FROM catalog_libraries WHERE user_id='cas'", 'BGC02'],
    ["DELETE FROM catalog_generations WHERE user_id='cas'", 'BGC02'], ["DELETE FROM catalog_media_objects WHERE user_id='cas'", 'BGC02'],
    ['TRUNCATE users CASCADE', 'BGC02'], ['TRUNCATE vaults CASCADE', 'BGC02'], ['TRUNCATE catalog_libraries CASCADE', 'BGC02'], ['TRUNCATE catalog_generations CASCADE', 'BGC02'],
    ["INSERT INTO catalog_media_objects(user_id,object_id,provider,chat_id,message_id,status) VALUES ('cas','m2','telegram','-9999',11,'PRESENT')", 'BGN04'],
  ]) assert.equal(await one(pool, sql), code, sql);
  assert.equal(await snapshot(pool), before, 'catálogo intacto');
  // §6.1 deshabilitado: ningún código inserta; solo esta prueba simula el job autorizado para verificar la excepción.
  assert.equal(await one(pool, "INSERT INTO catalog_account_deletions(deletion_id,user_id,state,actor) VALUES ('d1','cas','REQUESTED','OPERATOR')"), 'OK');
  assert.equal(await one(pool, "UPDATE catalog_account_deletions SET state='REQUESTED' WHERE deletion_id='d1'"), 'OK');
  assert.equal(await tx(pool, async (c) => { await c.query("SET LOCAL beatgaler.account_deletion_id='d1'"); await c.query("DELETE FROM users WHERE id='cas'"); }), 'BGC02', 'sin MEDIA_DELETED no basta la GUC');
  assert.equal(await one(pool, "UPDATE catalog_account_deletions SET state='MEDIA_DELETED' WHERE deletion_id='d1'"), 'OK');
  assert.equal(await one(pool, "UPDATE catalog_account_deletions SET state='FROZEN' WHERE deletion_id='d1'"), '23514', 'los estados solo avanzan');
  assert.equal(await one(pool, "DELETE FROM users WHERE id='cas'"), 'BGC02', 'sin GUC no basta MEDIA_DELETED');
  assert.equal(await one(pool, "UPDATE catalog_media_objects SET status='DELETED' WHERE user_id='cas'"), 'OK');
  assert.equal(await tx(pool, async (c) => { await c.query("SET LOCAL beatgaler.account_deletion_id='d1'"); await c.query("DELETE FROM users WHERE id='cas'"); }), 'OK');
  assert.equal(await count(pool, 'catalog_libraries'), 0);
  assert.equal(await count(pool, 'catalog_account_deletions'), 1, 'la evidencia mínima se conserva');
}));

test('PASS 10+7c: rebind en origen, trigger de respaldo, cuarentena del flush y rebind autorizado con el chat anterior RETIRED', () => withDb(async (pool) => {
  await activate(pool);
  const u = await user(pool, 'rb', '-8001'); await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [u]);
  const other = await user(pool, 'plain', '-8002');
  await auth(pool).provisionLibrary({ userId: u });
  await pool.query("INSERT INTO catalog_media_objects(user_id,object_id,provider,chat_id,message_id,status) VALUES ('rb','m1','telegram','-8001',10,'PRESENT')");
  // Origen: sin rebind abierto → CATALOG_VAULT_REBIND_FORBIDDEN; usuario sin catálogo → permitido.
  await assert.rejects(auth(pool).assertVaultRebindAllowed({ userId: u, fromChatId: '-8001' }), (e) => e.code === 'CATALOG_VAULT_REBIND_FORBIDDEN');
  assert.deepEqual(await auth(pool).assertVaultRebindAllowed({ userId: other, fromChatId: '-8002' }), { native: false });
  // Trigger de respaldo: UPDATE directo del chat, id o user_id → BGR03 con DETAIL user_id.
  for (const sql of ["UPDATE vaults SET telegram_chat_id='-8009' WHERE user_id='rb'", "UPDATE vaults SET id='v-x' WHERE user_id='rb'"]) {
    const err = await pool.query(sql).then(() => null, (e) => e);
    assert.equal(err?.code, 'BGR03', sql); assert.equal(err.detail, 'user_id=rb');
  }
  assert.equal(await one(pool, "UPDATE vaults SET title='t' WHERE user_id='rb'"), 'OK', 'otros campos siguen libres');
  // Flush del control-plane: el nativo en conflicto queda en cuarentena, el otro hace COMMIT y la base no avanza para él.
  const base = { users: [{ id: 'rb', storageChatId: '-8001', storageCreatedAt: 1 }, { id: 'plain', storageChatId: '-8002', storageCreatedAt: 1 }], sessions: {} };
  const changed = JSON.parse(JSON.stringify(base)); changed.users[0].storageChatId = '-8009'; changed.users[1].storageChatId = '-8010';
  const r = await mergeAuthSnapshotDelta(pool, changed, { key: Buffer.alloc(32, 7), keyVersion: 1 }, base);
  assert.deepEqual(r.quarantined, ['rb']);
  assert.equal((await pool.query("SELECT telegram_chat_id FROM vaults WHERE user_id='plain'")).rows[0].telegram_chat_id, '-8010');
  assert.equal((await pool.query("SELECT telegram_chat_id FROM vaults WHERE user_id='rb'")).rows[0].telegram_chat_id, '-8001');
  const q = (await pool.query("SELECT field, attempts, resolved_at FROM control_plane_flush_quarantine WHERE user_id='rb'")).rows;
  assert.deepEqual(q, [{ field: 'telegram_chat_id', attempts: 1, resolved_at: null }]);
  // §6.2.3 Fail-closed por usuario: el catálogo responde 409 VAULT_QUARANTINED mientras la cuarentena esté abierta.
  await assert.rejects(auth(pool).resolveContext({ userId: u }), (e) => e.code === 'VAULT_QUARANTINED' && e.status === 409);
  await assert.rejects(auth(pool).provisionLibrary({ userId: u }), (e) => e.code === 'VAULT_QUARANTINED');
  assert.equal((await auth(pool).resolveContext({ userId: other }).catch((e) => e)).code, 'LIBRARY_RESET_REQUIRED', 'el otro usuario no se ve afectado');
  // Un segundo flush con el mismo delta reintenta y acumula intentos sin perderse.
  const r2 = await mergeAuthSnapshotDelta(pool, changed, { key: Buffer.alloc(32, 7), keyVersion: 1 }, base);
  assert.deepEqual(r2.quarantined, ['rb']);
  assert.equal((await pool.query("SELECT attempts FROM control_plane_flush_quarantine WHERE user_id='rb'")).rows[0].attempts, 2);
  // Rebind autorizado (T17-N rebind-chat): ventana OPEN → el UPDATE pasa, el chat anterior queda RETIRED y las ubicaciones intactas.
  await pool.query("INSERT INTO catalog_chat_rebinds(rebind_id,user_id,vault_id,from_chat_id,to_chat_id) VALUES ('rb1','rb','v-rb','-8001','-8009')");
  assert.equal(await one(pool, "UPDATE vaults SET telegram_chat_id='-8008' WHERE user_id='rb'"), 'BGR03', 'solo hacia el chat del rebind');
  assert.equal(await tx(pool, async (c) => {
    await c.query("UPDATE vaults SET telegram_chat_id='-8009' WHERE user_id='rb'");
    await c.query("UPDATE catalog_library_chats SET state='RETIRED', retired_at=now() WHERE chat_id='-8001'");
    await c.query("INSERT INTO catalog_library_chats(provider,chat_id,user_id,vault_id,state) VALUES ('telegram','-8009','rb','v-rb','CURRENT')");
    await c.query("UPDATE catalog_chat_rebinds SET state='APPLIED', closed_at=now() WHERE rebind_id='rb1'");
    await c.query("UPDATE catalog_libraries SET authority_epoch = authority_epoch + 1 WHERE user_id='rb'");
    await c.query("UPDATE control_plane_flush_quarantine SET resolved_at=now(), resolution='REBIND' WHERE user_id='rb'");
  }), 'OK');
  assert.deepEqual((await pool.query('SELECT chat_id, state FROM catalog_library_chats ORDER BY chat_id')).rows, [{ chat_id: '-8001', state: 'RETIRED' }, { chat_id: '-8009', state: 'CURRENT' }]);
  assert.deepEqual((await pool.query("SELECT chat_id FROM catalog_media_objects WHERE user_id='rb'")).rows, [{ chat_id: '-8001' }], 'las ubicaciones no se reescriben');
  assert.equal(await one(pool, "INSERT INTO catalog_media_objects(user_id,object_id,provider,chat_id,message_id,status) VALUES ('rb','m2','telegram','-8001',12,'PRESENT')"), 'BGN04', 'sin subidas nuevas al RETIRED');
  assert.equal(await one(pool, "INSERT INTO catalog_media_objects(user_id,object_id,provider,chat_id,message_id,status) VALUES ('rb','m3','telegram','-8009',12,'PRESENT')"), 'OK');
  assert.equal(await one(pool, "UPDATE catalog_chat_rebinds SET state='OPEN', closed_at=NULL WHERE rebind_id='rb1'"), '23514', 'un rebind cerrado no se reabre');
  const ctx = await auth(pool).resolveContext({ userId: u });
  assert.deepEqual([ctx.chat_id, ctx.authority_epoch], ['-8009', '2']);
}));

test('PASS 11+12: reglas DB §7 en generaciones nativas; era/época ausente o vieja, tenant ajeno y cambio entre check y commit', () => withDb(async (pool) => {
  await activate(pool);
  const u = await user(pool, 'rules', '-9001'); await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [u]);
  const u2 = await user(pool, 'rules2', '-9002'); await pool.query('UPDATE vaults SET index_bootstrap_pending=true WHERE user_id=$1', [u2]);
  const a = auth(pool);
  const ctx = (await a.provisionLibrary({ userId: u })).context; await a.provisionLibrary({ userId: u2 });
  const g = ctx.generation_id;
  const beat = (id) => `INSERT INTO catalog_beats(user_id,generation_id,beat_id,state,manual_rank,legacy_json,legacy_sha256,legacy_export_bytes,name_display,name_search,key_display,key_search,bpm_display,rating_display) VALUES ('rules','${g}','${id}','ACTIVE',1,'{}',encode(sha256(convert_to('{}','UTF8')),'hex'),2,'Untitled','untitled','','','',0)`;
  assert.equal(await one(pool, beat('ok.beat_1')), 'OK');
  assert.equal(await one(pool, beat('con espacio')), 'BGN04', 'beat_id fuera del alcance Direct');
  assert.equal(await one(pool, `UPDATE catalog_generations SET raw_index='\\x01'::bytea, raw_index_sha256=encode(sha256('\\x01'::bytea),'hex') WHERE generation_id='${g}'`), 'BGN04');
  assert.equal(await one(pool, `UPDATE catalog_generations SET origin='LEGACY_IMPORT' WHERE generation_id='${g}'`), 'BGN04', 'origin inmutable');
  assert.equal(await one(pool, `INSERT INTO catalog_legacy_fields(user_id,generation_id,scope,key,ordinal,value_json) VALUES ('rules','${g}','root','k',0,'1')`), 'BGN04');
  assert.equal(await one(pool, `INSERT INTO catalog_file_versions(user_id,generation_id,file_id,beat_id,role,legacy_path) VALUES ('rules','${g}','f1','ok.beat_1','METADATA','p')`), 'BGN04');
  assert.equal(await one(pool, `INSERT INTO catalog_file_versions(user_id,generation_id,file_id,beat_id,role,legacy_path) VALUES ('rules','${g}','f1','ok.beat_1','MASTER','p')`), 'OK');
  assert.equal(await one(pool, `INSERT INTO catalog_current_files(user_id,generation_id,beat_id,slot_key,file_id) VALUES ('rules','${g}','ok.beat_1','METADATA','f1')`), 'BGN04');
  assert.equal(await one(pool, `INSERT INTO catalog_current_files(user_id,generation_id,beat_id,slot_key,file_id) VALUES ('rules','${g}','ok.beat_1','MASTER','f1')`), 'OK');
  assert.equal(await one(pool, `INSERT INTO catalog_tombstones(user_id,generation_id,beat_id,source,sql_state) VALUES ('rules','${g}','gone','SQL','CONFIRMED')`), 'BGN04');
  assert.equal(await one(pool, `INSERT INTO catalog_tombstones(user_id,generation_id,beat_id,source) VALUES ('rules','${g}','gone','CATALOG')`), 'OK');
  assert.equal(await one(pool, `INSERT INTO catalog_generations(user_id,generation_id,snapshot_id,origin,raw_index,raw_index_sha256) VALUES ('rules','native-2','native:2','NATIVE','\\x01'::bytea,encode(sha256('\\x01'::bytea),'hex'))`), 'BGN04');
  // La generación ACTIVE nativa no se borra; una RETIRED reciente tampoco (retención C9).
  assert.equal(await one(pool, `DELETE FROM catalog_generations WHERE generation_id='${g}'`), 'BGC02');
  assert.equal(await one(pool, `INSERT INTO catalog_generations(user_id,generation_id,snapshot_id,origin,status,source_hash,validated_at) VALUES ('rules','native-old','native:old','NATIVE','STAGING',$1,now())`, [H]), 'OK');
  assert.equal(await one(pool, "UPDATE catalog_generations SET status='RETIRED' WHERE generation_id='native-old'"), 'OK');
  assert.ok((await pool.query("SELECT retired_at FROM catalog_generations WHERE generation_id='native-old'")).rows[0].retired_at);
  assert.equal(await one(pool, "DELETE FROM catalog_generations WHERE generation_id='native-old'"), 'BGC02', 'dentro de la retención');
  // PASS 12: guard de mutación reutilizable.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await assert.rejects(a.requireLibraryForMutation(c, { userId: u }), (e) => e.code === 'CATALOG_ERA_REQUIRED' && e.status === 400);
    await assert.rejects(a.requireLibraryForMutation(c, { userId: u, era: crypto.randomUUID(), epoch: '1' }), (e) => e.code === 'CATALOG_ERA_MISMATCH');
    await assert.rejects(a.requireLibraryForMutation(c, { userId: u, era: ctx.authority_era, epoch: '0' }), (e) => e.code === 'CATALOG_EPOCH_STALE');
    await assert.rejects(a.requireLibraryForMutation(c, { userId: 'nobody', era: ctx.authority_era, epoch: '1' }), (e) => e.code === 'LIBRARY_RESET_REQUIRED');
    await assert.rejects(a.requireLibraryForMutation(c, { userId: u2, era: ctx.authority_era, epoch: '1' }), (e) => e.code === 'CATALOG_ERA_MISMATCH', 'tenant ajeno con era de otro');
    const ok = await a.requireLibraryForMutation(c, { userId: u, era: ctx.authority_era, epoch: '1' });
    assert.equal(ok.generation_id, g);
    await c.query('COMMIT');
  } finally { c.release(); }
  // Cambio de estado entre check y commit: la época avanza en otra transacción tras una lectura sin lock.
  const stale = await a.resolveContext({ userId: u });
  await pool.query("UPDATE catalog_libraries SET authority_epoch = authority_epoch + 1 WHERE user_id='rules'");
  const c2 = await pool.connect();
  try {
    await c2.query('BEGIN');
    await assert.rejects(a.requireLibraryForMutation(c2, { userId: u, era: stale.authority_era, epoch: stale.authority_epoch }), (e) => e.code === 'CATALOG_EPOCH_STALE' && e.detail.current_epoch === '2');
    await c2.query('ROLLBACK');
  } finally { c2.release(); }
  // Puntero INDEX legacy del chat nativo: cercado por chat.
  const store = createVaultIndexPointerStore(pool);
  await assert.rejects(store.compareAndSetForChat({ telegramChatId: '-9001', messageId: 3 }), (e) => e.status === 410);
  await assert.rejects(createLegacyFence({ pool }).assertLegacyEntryAllowed({ userId: u }), (e) => e.status === 410);
  await createLegacyFence({ pool }).assertLegacyEntryAllowed({ userId: 'nobody', chatId: '-1' });
}));

test('PASS 13: json + pool con activación no arranca; re-cutover JSON→PG con activación se niega sin escribir', () => withDb(async (pool) => {
  assert.deepEqual(await authority.assertNativeStartupCompatible({ pool, authority: 'json' }), { checked: true, activations: 0, libraries: 0 });
  await activate(pool);
  await assert.rejects(authority.assertNativeStartupCompatible({ pool, authority: 'json' }), /CATALOG_NATIVE_STARTUP_REFUSED/);
  await assert.rejects(authority.assertNoNativeActivation(pool), /CATALOG_NATIVE_RECUTOVER_REFUSED/);
  const { stagePostgresCutover } = require('../../postgres-cutover-preparation.js');
  const before = await snapshot(pool);
  await assert.rejects(stagePostgresCutover(pool, { authRaw: JSON.stringify({ users: [{ id: 'z', storageChatId: '-1' }], sessions: {} }), persistentRaw: JSON.stringify({}), cryptoConfig: { key: Buffer.alloc(32, 1), keyVersion: 1 } }),
    /CATALOG_NATIVE_RECUTOVER_REFUSED/);
  assert.equal(await snapshot(pool), before);
  assert.equal(await count(pool, 'users'), 0);
  // La activación es idempotente por environment_id y única por entorno.
  assert.equal(await one(pool, `INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('other','r',$1,'ROTATED',$2,'[]')`, [BOTS, H]), '23505');
}));
