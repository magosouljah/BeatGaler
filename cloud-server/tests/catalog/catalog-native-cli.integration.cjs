'use strict';
// T17-N — CLI nativa contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T17`): activate (precondiciones §3.1 y §5.0
// verificables en SQL, idempotencia, no-op), rebind-chat (vault sin catálogo, con biblioteca LEGACY de staging y con biblioteca
// POSTGRES: OPEN→APPLIED, RETIRED/CURRENT, época +1, auditoría, cuarentena resuelta, JSON-compat) y reset (TOCTOU, chat por
// rebind-chat, generaciones RETIRED sin DELETE, reset-<uuid> RESET, LEGACY_ABANDONED, capacidades revocadas, ALREADY_APPLIED,
// LIBRARY_ALREADY_NATIVE: nunca vacía una biblioteca nativa). Dry-run demostrado sin efectos por diff de tablas. FAKE: sin Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const { createLegacyFence } = require('../../catalog/legacy-fence.js');
const { deterministicId } = require('../../legacy-import-executor.js');
const cli = require('../../catalog/native-cli.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const H = crypto.createHash('sha256').update('x').digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t17-int-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let fileN = 0;
const write = (value) => { const p = path.join(TMP, `m-${++fileN}.json`); fs.writeFileSync(p, JSON.stringify(value)); return p; };
let seq = 0;

async function withDb(fn, { activate = true } = {}) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max: 6 });
  try {
    await mig.applyMigrations(pool);
    await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO control_plane_cutovers(id, snapshot_sha256, state) VALUES ('legacy-json-v1', $1, 'READY')", [H]);
    if (activate) await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [H]);
    return await fn(pool, h);
  } finally { await pool.end(); await h.cleanup(); }
}
const authOn = (pool) => authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' });
// Vault legacy de prueba con rastros (puntero, cuota, beats) y el id determinista del importador (R12 sin divergencia).
async function legacyVault(pool, { traces = true } = {}) {
  const id = `u${++seq}`; const chat = `-100${seq}`; const vaultId = deterministicId('vlt', id, chat);
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [vaultId, id, chat]);
  if (traces) {
    await pool.query("INSERT INTO vault_index_pointers(vault_id, index_message_id, revision, source) VALUES ($1, 77, 1, 'publish')", [vaultId]);
    await pool.query('INSERT INTO library_quota_state(user_id, index_message_id, index_sha256) VALUES ($1, 77, $2)', [id, H]);
    await pool.query("INSERT INTO library_beats(user_id, beat_id, state) VALUES ($1, 'b1', 'ACTIVE'), ($1, 'b2', 'ACTIVE')", [id]);
  }
  return { userId: id, chatId: chat, vaultId };
}
const authJsonFor = (users) => write({ users: users.map((u) => ({ id: u.userId, storageChatId: u.chatId })) });
const rejects = (p, code, stop = null) => assert.rejects(p, (e) => { assert.equal(e.code, code, `código esperado ${code}, recibido ${e.code}: ${e.message}`); if (stop) assert.equal(e.stop, stop); return true; });
const snapshot = async (pool, userId) => {
  const tables = ['vaults', 'catalog_libraries', 'catalog_generations', 'catalog_library_chats', 'catalog_chat_rebinds', 'catalog_vault_rebind_audit', 'catalog_native_activation', 'direct_capabilities', 'library_quota_state', 'vault_index_pointers', 'control_plane_flush_quarantine'];
  const out = {};
  for (const t of tables) out[t] = (await pool.query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM ${t} x`)).rows[0];
  return JSON.stringify(out);
};
const inspectSha = async (c, userId) => (await c.run(['inspect', '--environment', 'lab', '--allow-write-role', '--user', userId])).result.vaults[0].inventory_sha256;

test('activate: inspect aprobado + JSON-compat = SQL + rol antiguo NOLOGIN con 0 backends + bots listos → dry-run sin filas, apply inserta la única fila, repetir = no-op, otro manifiesto = STOP; cada precondición fallida se nombra y no escribe', () => withDb(async (pool, h) => {
  const a = await legacyVault(pool); const b = await legacyVault(pool, { traces: false });
  // El rol de la DB efímera no tiene CREATEROLE: el "rol antiguo" es un rol NOLOGIN existente del clúster (0 backends), como exige §5.0.2.
  const oldRole = 'pg_signal_backend';
  const c = cli.createNativeCli({ pool });
  const inspect = (await c.run(['inspect', '--environment', 'lab', '--allow-write-role', '--auth-json', authJsonFor([a, b])])).result;
  assert.equal(inspect.activation, null); assert.equal(inspect.control_plane.mode, 'postgres'); assert.equal(inspect.counts.vaults, 2); assert.equal(inspect.counts.diverging_vaults, 0);
  assert.equal(inspect.vaults.find((v) => v.user_id === a.userId).pointer.index_message_id, '77');
  await rejects(c.run(['inspect', '--environment', 'lab']), 'INSPECT_ROLE_CAN_WRITE', 'STOP-ENV'); // el admin del LAB puede escribir
  const manifest = { environment_id: 'lab', run_id: 'run-act-1', transport_bot_ids: ['Bot20'], direct_token_exposure: 'ROTATED', instance_inventory: [{ id: 'cloud-old-1', stopped: true }, { id: 'worker-old-1', stopped: true }],
    inspect: { inventory_sha256: inspect.inventory_sha256, approval_ref: 'sol-2026-11-09-lab' }, credential_fence: { old_db_role: oldRole, token_rotation_proof_ref: 'E29-lab', transport_fence_proof_ref: 'E29-b-lab' } };
  const before = await snapshot(pool);
  const dry = (await c.run(['activate', '--manifest', write(manifest), '--auth-json', authJsonFor([a, b])])).result;
  assert.equal(dry.outcome, 'WOULD_ACTIVATE'); assert.equal(dry.writes, 0);
  assert.equal(await snapshot(pool), before, 'dry-run sin efectos');
  // precondiciones fallidas, cada una sin escribir
  await rejects(c.run(['activate', '--manifest', write(manifest), '--auth-json', authJsonFor([a])]), 'JSON_SQL_MISMATCH', 'STOP-DATA');
  await rejects(c.run(['activate', '--manifest', write({ ...manifest, inspect: { ...manifest.inspect, inventory_sha256: H } }), '--auth-json', authJsonFor([a, b])]), 'INVENTORY_CHANGED', 'STOP-DATA');
  await rejects(c.run(['activate', '--manifest', write({ ...manifest, credential_fence: { ...manifest.credential_fence, old_db_role: 'nadie_' + oldRole } }), '--auth-json', authJsonFor([a, b])]), 'OLD_ROLE_MISSING', 'STOP-ENV');
  await rejects(c.run(['activate', '--manifest', write({ ...manifest, credential_fence: { ...manifest.credential_fence, old_db_role: h.config.user } }), '--auth-json', authJsonFor([a, b])]), 'OLD_ROLE_IN_USE', 'STOP-ENV');
  await rejects(c.run(['activate', '--manifest', write({ ...manifest, transport_bot_ids: ['Bot99'] }), '--auth-json', authJsonFor([a, b])]), 'TRANSPORT_BOT_UNKNOWN', 'STOP-ENV');
  await pool.query("INSERT INTO control_plane_flush_quarantine(user_id, field, value_sha256) VALUES ($1, 'telegram_chat_id', $2)", [b.userId, H]);
  await rejects(c.run(['activate', '--manifest', write(manifest), '--auth-json', authJsonFor([a, b])]), 'VAULTS_PENDING_FLUSH', 'STOP-DATA');
  await pool.query("UPDATE control_plane_flush_quarantine SET resolved_at = now(), resolution = 'REVERTED' WHERE user_id = $1", [b.userId]);
  // divergencia R12: el JSON apunta a otro chat para b → id de vault distinto
  await rejects(c.run(['activate', '--manifest', write(manifest), '--auth-json', write({ users: [{ id: a.userId, storageChatId: a.chatId }, { id: b.userId, storageChatId: '-100999' }] })]), 'JSON_SQL_MISMATCH', 'STOP-DATA');
  assert.equal((await snapshot(pool)).replace(/"control_plane_flush_quarantine":\{[^}]*\}/, ''), before.replace(/"control_plane_flush_quarantine":\{[^}]*\}/, ''), 'ningún STOP escribe');
  // apply
  const applied = (await c.run(['activate', '--manifest', write(manifest), '--auth-json', authJsonFor([a, b]), '--apply'])).result;
  assert.equal(applied.outcome, 'ACTIVATED'); assert.equal(applied.activation.environment_id, 'lab'); assert.deepEqual(applied.activation.transport_bot_ids, ['Bot20']);
  const row = (await pool.query('SELECT environment_id, run_id, direct_token_exposure, manifest_sha256, instance_inventory FROM catalog_native_activation')).rows[0];
  assert.equal(row.run_id, 'run-act-1'); assert.equal(row.direct_token_exposure, 'ROTATED'); assert.equal(JSON.parse(row.instance_inventory).length, 2);
  assert.equal((await c.run(['activate', '--manifest', write(manifest), '--auth-json', authJsonFor([a, b]), '--apply'])).result.outcome, 'ALREADY_ACTIVATED');
  await rejects(c.run(['activate', '--manifest', write({ ...manifest, run_id: 'run-act-2' }), '--auth-json', authJsonFor([a, b]), '--apply']), 'ENVIRONMENT_ALREADY_ACTIVATED', 'STOP-CONTRACT');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_native_activation')).rows[0].n, 1);
  // tras la activación, un vault nuevo nace elegible y la autoridad lo provisiona; los existentes no (RESET_REQUIRED)
  await rejects(authOn(pool).provisionLibrary({ userId: a.userId }), 'LIBRARY_RESET_REQUIRED');
  const fresh = await legacyVault(pool, { traces: false });
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [fresh.vaultId]);
  assert.equal((await authOn(pool).provisionLibrary({ userId: fresh.userId })).context.authority, 'POSTGRES');
}, { activate: false }));

test('rebind-chat + reset de un vault legacy sin catálogo: reset exige rebind previo y hash posterior; rebind deja auditoría y cambia el chat por la ruta del control-plane (JSON-compat incluido); reset crea la biblioteca POSTGRES con generación RESET, chat legacy LEGACY_ABANDONED, capacidades revocadas, filas legacy intactas; repetir = ALREADY_APPLIED; otro manifiesto = LIBRARY_ALREADY_NATIVE; después solo rebind-chat puede cambiar el chat', () => withDb(async (pool) => {
  const v = await legacyVault(pool); const other = await legacyVault(pool);
  await pool.query("INSERT INTO direct_capabilities(capability_hash, internal_operation_id, user_id, tenant_id, installation_id, auth_session_hash, session_id, generation, vault_scope, operation_type, object_scope, status, issued_at, expires_at) VALUES ($1, 'op-1', $2, $2, 'inst', 'sess', 's1', 1, $3, 'get_index', '{}', 'ACTIVE', now(), now() + interval '1 hour')", [H, v.userId, v.vaultId]).catch(() => {});
  const c = cli.createNativeCli({ pool });
  const auth = authJsonFor([v, other]);
  const newChat = '-100555';
  const sha0 = await inspectSha(c, v.userId);
  const resetManifest = (sha) => ({ environment_id: 'lab', run_id: 'run-reset-1', user_id: v.userId, vault_id: v.vaultId, inventory_sha256: sha, legacy_chat_id: v.chatId, new_chat_id: newChat, approval: { marked_discardable: true, ref: 'purp-marca-2026-11-09' } });
  await rejects(c.run(['reset', '--manifest', write(resetManifest(sha0)), '--apply']), 'VAULT_CHAT_NOT_REBOUND', 'STOP-DATA');
  // rebind: dry-run sin efectos; manifiesto con vault_id ajeno (R12) → STOP; chat en uso por otro vault → STOP
  const rb = { environment_id: 'lab', user_id: v.userId, vault_id: v.vaultId, from_chat_id: v.chatId, to_chat_id: newChat, approval_ref: 'purp-rebind-1' };
  const before = await snapshot(pool);
  assert.equal((await c.run(['rebind-chat', '--manifest', write(rb), '--auth-json', auth])).result.outcome, 'WOULD_REBIND');
  assert.equal(await snapshot(pool), before);
  await rejects(c.run(['rebind-chat', '--manifest', write({ ...rb, vault_id: 'v-otro' }), '--apply']), 'VAULT_ID_MISMATCH', 'STOP-DATA');
  await rejects(c.run(['rebind-chat', '--manifest', write({ ...rb, to_chat_id: other.chatId }), '--apply']), 'TO_CHAT_IN_USE', 'STOP-DATA');
  await pool.query("INSERT INTO direct_operations(id, idempotency_key, vault_id, lease_id, operation_type, state) VALUES ('d1', 'k1', $1, 'l1', 'get_index', 'PREPARED')", [v.vaultId]).catch(() => {});
  if ((await pool.query("SELECT 1 FROM direct_operations WHERE id = 'd1'")).rows.length) {
    await rejects(c.run(['rebind-chat', '--manifest', write(rb), '--apply']), 'OPERATIONS_IN_FLIGHT', 'STOP-DATA');
    await pool.query("UPDATE direct_operations SET state = 'FAILED' WHERE id = 'd1'");
  }
  const applied = (await c.run(['rebind-chat', '--manifest', write(rb), '--auth-json', auth, '--apply'])).result;
  assert.equal(applied.outcome, 'REBOUND'); assert.equal(applied.authority_epoch, null);
  assert.equal((await pool.query('SELECT telegram_chat_id FROM vaults WHERE id = $1', [v.vaultId])).rows[0].telegram_chat_id, newChat);
  assert.equal(JSON.parse(fs.readFileSync(auth, 'utf8')).users.find((u) => u.id === v.userId).storageChatId, newChat, 'JSON-compat actualizado antes del COMMIT');
  const audit = (await pool.query('SELECT * FROM catalog_vault_rebind_audit WHERE user_id = $1', [v.userId])).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].from_chat_id, v.chatId); assert.equal(audit[0].to_chat_id, newChat); assert.equal(audit[0].library_authority, null);
  await assert.rejects(pool.query('DELETE FROM catalog_vault_rebind_audit'), /append-only/);
  assert.equal((await c.run(['rebind-chat', '--manifest', write(rb), '--apply'])).result.outcome, 'ALREADY_APPLIED');
  // reset: el hash de inspect anterior al rebind ya no vale (TOCTOU); el posterior sí
  await rejects(c.run(['reset', '--manifest', write(resetManifest(sha0)), '--apply']), 'INVENTORY_CHANGED', 'STOP-DATA');
  const sha1 = await inspectSha(c, v.userId);
  const beforeReset = await snapshot(pool);
  const dry = (await c.run(['reset', '--manifest', write(resetManifest(sha1))])).result;
  assert.equal(dry.outcome, 'WOULD_RESET'); assert.equal(dry.plan.library, 'INSERT POSTGRES'); assert.equal(dry.plan.abandoned.pointer.index_message_id, '77');
  assert.equal(await snapshot(pool), beforeReset, 'dry-run sin efectos');
  const legacyBefore = (await pool.query('SELECT (SELECT count(*) FROM library_quota_state WHERE user_id = $1)::int AS q, (SELECT count(*) FROM vault_index_pointers WHERE vault_id = $2)::int AS p, (SELECT count(*) FROM library_beats WHERE user_id = $1)::int AS b', [v.userId, v.vaultId])).rows[0];
  const done = (await c.run(['reset', '--manifest', write(resetManifest(sha1)), '--apply'])).result;
  assert.equal(done.outcome, 'RESET_APPLIED'); assert.equal(done.context.authority, 'POSTGRES'); assert.equal(done.context.authority_epoch, '1'); assert.match(done.context.generation_id, /^reset-/);
  const gen = (await pool.query('SELECT origin, status, snapshot_id, descriptor_json, raw_index FROM catalog_generations WHERE user_id = $1', [v.userId])).rows;
  assert.equal(gen.length, 1); assert.equal(gen[0].origin, 'RESET'); assert.equal(gen[0].status, 'ACTIVE'); assert.match(gen[0].snapshot_id, /^reset:/); assert.equal(gen[0].raw_index, null);
  const descriptor = JSON.parse(gen[0].descriptor_json);
  assert.equal(descriptor.abandoned.legacy_chat_id, v.chatId); assert.equal(descriptor.abandoned.pointer.index_message_id, '77'); assert.equal(descriptor.inventory_sha256, sha1); assert.ok(descriptor.rebind_id);
  const chats = (await pool.query('SELECT chat_id, state FROM catalog_library_chats WHERE user_id = $1 ORDER BY chat_id', [v.userId])).rows;
  assert.deepEqual(chats.map((r) => [r.chat_id, r.state]).sort(), [[newChat, 'CURRENT'], [v.chatId, 'LEGACY_ABANDONED']].sort());
  assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM library_quota_state WHERE user_id = $1)::int AS q, (SELECT count(*) FROM vault_index_pointers WHERE vault_id = $2)::int AS p, (SELECT count(*) FROM library_beats WHERE user_id = $1)::int AS b', [v.userId, v.vaultId])).rows[0], legacyBefore, 'filas legacy inertes, sin DELETE');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM direct_capabilities WHERE user_id = $1 AND status IN ('ACTIVE', 'AUTHORIZED')", [v.userId])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT index_bootstrap_pending FROM vaults WHERE id = $1', [v.vaultId])).rows[0].index_bootstrap_pending, false);
  // idempotencia y protección: mismo manifiesto no-op; otro manifiesto nunca vacía la biblioteca nativa
  assert.equal((await c.run(['reset', '--manifest', write(resetManifest(sha1)), '--apply'])).result.outcome, 'ALREADY_APPLIED');
  await rejects(c.run(['reset', '--manifest', write({ ...resetManifest(sha1), run_id: 'run-reset-2' }), '--apply']), 'LIBRARY_ALREADY_NATIVE', 'STOP-DATA');
  // la autoridad ve POSTGRES; la capa 1 cerca al usuario y al chat legacy; el chat solo cambia por rebind-chat
  const ctx = await authOn(pool).resolveContext({ userId: v.userId });
  assert.equal(ctx.authority, 'POSTGRES'); assert.equal(ctx.chat_id, newChat); assert.equal(ctx.generation_origin, 'RESET');
  const fence = createLegacyFence({ pool });
  await rejects(fence.assertLegacyEntryAllowed({ userId: v.userId, entry: 'index/publish' }), 'LEGACY_CLIENT_UNSUPPORTED');
  await rejects(fence.assertLegacyEntryAllowed({ chatId: v.chatId, entry: 'index/publish' }), 'LEGACY_CLIENT_UNSUPPORTED');
  await fence.assertLegacyEntryAllowed({ userId: other.userId, chatId: other.chatId, entry: 'index/publish' });
  await assert.rejects(pool.query('UPDATE vaults SET telegram_chat_id = $1 WHERE id = $2', ['-100777', v.vaultId]), (e) => e.code === 'BGR03');
  const rb2 = { environment_id: 'lab', user_id: v.userId, vault_id: v.vaultId, from_chat_id: newChat, to_chat_id: '-100777', approval_ref: 'purp-rebind-2' };
  await pool.query("INSERT INTO control_plane_flush_quarantine(user_id, field, value_sha256) VALUES ($1, 'telegram_chat_id', $2)", [v.userId, H]);
  await rejects(authOn(pool).resolveContext({ userId: v.userId }), 'VAULT_QUARANTINED');
  const rebound = (await c.run(['rebind-chat', '--manifest', write(rb2), '--apply'])).result;
  assert.equal(rebound.outcome, 'REBOUND'); assert.equal(rebound.quarantine_resolved, 1); assert.equal(rebound.authority_epoch, '2');
  assert.deepEqual((await pool.query('SELECT chat_id, state FROM catalog_library_chats WHERE user_id = $1 ORDER BY chat_id', [v.userId])).rows.map((r) => [r.chat_id, r.state]).sort(), [['-100777', 'CURRENT'], [newChat, 'RETIRED'], [v.chatId, 'LEGACY_ABANDONED']].sort());
  assert.deepEqual((await pool.query('SELECT state, closed_at IS NOT NULL AS closed FROM catalog_chat_rebinds WHERE user_id = $1', [v.userId])).rows, [{ state: 'APPLIED', closed: true }]);
  assert.equal((await authOn(pool).resolveContext({ userId: v.userId })).authority_epoch, '2');
  await rejects(c.run(['rebind-chat', '--manifest', write({ ...rb2, from_chat_id: '-100777', to_chat_id: v.chatId, approval_ref: 'x' }), '--apply']), 'TO_CHAT_IN_USE', 'STOP-DATA'); // un chat abandonado nunca vuelve
}));

test('reset de una biblioteca LEGACY de staging (T04, anterior a la activación): generaciones RETIRED sin DELETE, generación RESET nueva, autoridad POSTGRES con era nueva y época +1, chat legacy CURRENT→LEGACY_ABANDONED; sin activación la CLI se detiene (NOT_ACTIVATED)', () => withDb(async (pool) => {
  const v = await legacyVault(pool);
  await pool.query("INSERT INTO catalog_libraries(user_id, vault_id, authority, migration_state) VALUES ($1, $2, 'LEGACY', 'IDLE')", [v.userId, v.vaultId]);
  await pool.query("INSERT INTO catalog_generations(user_id, generation_id, snapshot_id, status, source_hash, validated_at, origin) VALUES ($1, 'gen-legacy-1', 'snap:1', 'ACTIVE', $2, now(), 'LEGACY_IMPORT'), ($1, 'gen-legacy-0', 'snap:0', 'RETIRED', $2, now(), 'LEGACY_IMPORT')", [v.userId, H]);
  await pool.query("UPDATE catalog_libraries SET active_generation_id = 'gen-legacy-1', active_count = 2 WHERE user_id = $1", [v.userId]);
  await pool.query("INSERT INTO catalog_library_chats(provider, chat_id, user_id, vault_id, state) VALUES ('telegram', $1, $2, $3, 'CURRENT')", [v.chatId, v.userId, v.vaultId]);
  const c = cli.createNativeCli({ pool });
  const newChat = '-100666';
  await rejects(c.run(['reset', '--manifest', write({ environment_id: 'lab', run_id: 'r', user_id: v.userId, vault_id: v.vaultId, inventory_sha256: H, legacy_chat_id: v.chatId, new_chat_id: newChat, approval: { marked_discardable: true, ref: 'ok' } }), '--apply']), 'NOT_ACTIVATED', 'STOP-ENV');
  await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [H]);
  const rb = (await c.run(['rebind-chat', '--manifest', write({ environment_id: 'lab', user_id: v.userId, vault_id: v.vaultId, from_chat_id: v.chatId, to_chat_id: newChat, approval_ref: 'purp-rebind-staging' }), '--apply'])).result;
  assert.equal(rb.outcome, 'REBOUND'); assert.equal(rb.plan.library_authority, 'LEGACY');
  assert.deepEqual((await pool.query('SELECT state FROM catalog_chat_rebinds WHERE user_id = $1', [v.userId])).rows, [{ state: 'APPLIED' }]);
  const sha = await inspectSha(c, v.userId);
  const m = { environment_id: 'lab', run_id: 'run-reset-staging', user_id: v.userId, vault_id: v.vaultId, inventory_sha256: sha, legacy_chat_id: v.chatId, new_chat_id: newChat, approval: { marked_discardable: true, ref: 'purp-marca-staging' } };
  const dry = (await c.run(['reset', '--manifest', write(m)])).result;
  assert.equal(dry.outcome, 'WOULD_RESET'); assert.deepEqual(dry.plan.retire_generations, ['gen-legacy-1']); assert.match(dry.plan.library, /^UPDATE \(LEGACY → POSTGRES, epoch 1\+1\)/);
  const eraBefore = (await pool.query('SELECT authority_era::text AS era FROM catalog_libraries WHERE user_id = $1', [v.userId])).rows[0].era;
  const done = (await c.run(['reset', '--manifest', write(m), '--apply'])).result;
  assert.equal(done.outcome, 'RESET_APPLIED'); assert.equal(done.context.authority_epoch, '2'); assert.notEqual(done.context.authority_era, eraBefore);
  const gens = (await pool.query('SELECT generation_id, status, origin, retired_at IS NOT NULL AS retired FROM catalog_generations WHERE user_id = $1 ORDER BY generation_id', [v.userId])).rows;
  assert.equal(gens.length, 3, 'sin DELETE');
  assert.deepEqual(gens.filter((g) => g.origin === 'LEGACY_IMPORT').map((g) => g.status), ['RETIRED', 'RETIRED']);
  assert.equal(gens.find((g) => g.origin === 'RESET').status, 'ACTIVE');
  const lib = (await pool.query('SELECT authority, migration_state, active_count::text AS a FROM catalog_libraries WHERE user_id = $1', [v.userId])).rows[0];
  assert.deepEqual(lib, { authority: 'POSTGRES', migration_state: 'IDLE', a: '0' });
  assert.deepEqual((await pool.query('SELECT chat_id, state FROM catalog_library_chats WHERE user_id = $1 ORDER BY chat_id', [v.userId])).rows.map((r) => [r.chat_id, r.state]).sort(), [[newChat, 'CURRENT'], [v.chatId, 'LEGACY_ABANDONED']].sort());
  await assert.rejects(pool.query("UPDATE catalog_libraries SET authority = 'LEGACY' WHERE user_id = $1", [v.userId]), (e) => e.code === 'BGA05', 'sin retorno a LEGACY');
  assert.equal((await authOn(pool).resolveContext({ userId: v.userId })).generation_origin, 'RESET');
}, { activate: false }));
