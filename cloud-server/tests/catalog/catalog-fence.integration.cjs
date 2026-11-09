'use strict';
// T16 — Cercado y arranque contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T16`): "dos bibliotecas" según NATIVO r2.1
// (nativa + RESET_REQUIRED + flag apagado) más una legacy sin catálogo; capa 1 (410 en entradas C10 por usuario y por chat, también con el flag
// apagado), capa 2 (session/start exige catalog-v1 solo con el flag encendido), interruptor no destructivo (flag apagado → 503
// NATIVE_FLAG_DISABLED en la API nativa sin tocar datos), Telegram caído (gateway nulo → 503 TRANSFER_UNAVAILABLE / job en reintento;
// la metadata sigue), REVIEW aislada (LIBRARY_FROZEN solo en esa biblioteca), reinicio del worker (lease vencido → otro worker termina,
// el viejo queda fenced) y guarda hacia delante (versión desconocida en schema_migrations → CATALOG_SCHEMA_AHEAD). FAKE: sin proveedor real.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const operations = require('../../catalog/operations.js');
const queries = require('../../catalog/queries.js');
const commands = require('../../catalog/commands.js');
const { createCatalogWorker } = require('../../catalog/worker.js');
const { createCatalogTransport } = require('../../catalog/transport.js');
const { createLegacyFence } = require('../../catalog/legacy-fence.js');
const guard = require('../../catalog/session-guard.js');
const { CATALOG_SESSION_PROTOCOL } = require('../../catalog/authority.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const H = crypto.createHash('sha256').update('x').digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t16-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let seq = 0; let keyN = 0; const key = () => `k-${++keyN}`;

async function withDb(fn, { max = 10 } = {}) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max });
  try {
    await mig.applyMigrations(pool);
    await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [H]);
    return await fn(pool, h);
  } finally { await pool.end(); await h.cleanup(); }
}
const authOn = (pool) => authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' });
const authOff = (pool) => authority.createCatalogAuthority({ pool, env: {}, controlPlaneAuthority: 'postgres' });
async function user(pool, { native = true } = {}) {
  const id = `u${++seq}`; const chat = `-100${seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, chat]);
  if (!native) return { userId: id, chatId: chat };
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await authOn(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, chatId: chat, era: ctx.authority_era, epoch: ctx.authority_epoch, generationId: ctx.generation_id };
}
const rejects = (p, code, extra = () => true) => assert.rejects(p, (e) => { assert.equal(e.code, code, `código esperado ${code}, recibido ${e.code}: ${e.message}`); return extra(e); });
const C10_ENTRIES = ['index/publish', 'index/commit', 'index/bootstrap-state', 'index/recover', 'index/ensure-bootstrap', 'quota/reserve', 'quota/renew', 'quota/cancel', 'trash/purge', 'topic/delete', 'topic/ensure', 'project/authorize', 'project/upload', 'routing/reconcile', 'capability/get_index', 'capability/replace_index', 'capability/delete_messages'];

test('dos bibliotecas (nativa + RESET_REQUIRED + flag apagado) y una legacy: capa 1 → 410 en todas las entradas C10 por usuario y por chat para la nativa, nunca para las legacy (RESET_REQUIRED sigue siendo legacy hasta su reinicio); flag apagado → API nativa 503 NATIVE_FLAG_DISABLED sin tocar datos (interruptor no destructivo)', () => withDb(async (pool) => {
  const native = await user(pool); const legacy = await user(pool, { native: false }); const reset = await user(pool, { native: false });
  // RESET_REQUIRED: vault con historial legacy (no elegible: index_bootstrap_pending=false por defecto y ledger legacy presente) y sin fila de catálogo.
  // 0027 prohíbe filas LEGACY en un entorno nativo: el "reinicio requerido" lo declara la provisión nativa, no una fila.
  await pool.query("INSERT INTO library_quota_state(user_id, index_message_id) VALUES ($1, 77)", [reset.userId]).catch(() => {});
  const fence = createLegacyFence({ pool });
  for (const entry of C10_ENTRIES) {
    await rejects(fence.assertLegacyEntryAllowed({ userId: native.userId, entry }), 'LEGACY_CLIENT_UNSUPPORTED', (e) => e.status === 410 && e.detail.by === 'user' && e.detail.entry === entry);
    await rejects(fence.assertLegacyEntryAllowed({ chatId: native.chatId, entry }), 'LEGACY_CLIENT_UNSUPPORTED', (e) => e.detail.by === 'chat');
    await fence.assertLegacyEntryAllowed({ userId: legacy.userId, chatId: legacy.chatId, entry }); // la biblioteca legacy conserva su flujo
    await fence.assertLegacyEntryAllowed({ userId: reset.userId, chatId: reset.chatId, entry }); // RESET_REQUIRED aún es legacy: su flujo no se corta
  }
  // flag apagado: la API nativa responde 503 y nada cambia en SQL; la capa 1 sigue activa (comprobado arriba con el mismo pool)
  const off = authOff(pool);
  await rejects(off.availability(), 'CATALOG_UNAVAILABLE', (e) => e.detail.reason === 'NATIVE_FLAG_DISABLED');
  const before = (await pool.query('SELECT revision::text AS r, active_count::text AS a FROM catalog_libraries WHERE user_id = $1', [native.userId])).rows[0];
  await rejects(queries.createCatalogQueries({ pool, authority: off, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] }).listBeats({ userId: native.userId, query: {} }), 'CATALOG_UNAVAILABLE');
  await rejects(off.resolveContext({ userId: reset.userId }), 'CATALOG_UNAVAILABLE');
  assert.deepEqual((await pool.query('SELECT revision::text AS r, active_count::text AS a FROM catalog_libraries WHERE user_id = $1', [native.userId])).rows[0], before);
  // flag encendido: nativa lista; el vault no elegible se declara RESET_REQUIRED en la provisión (nunca LEGACY silencioso ni fila creada)
  const on = authOn(pool);
  assert.equal((await on.resolveContext({ userId: native.userId })).authority, 'POSTGRES');
  await rejects(on.resolveContext({ userId: reset.userId }), 'LIBRARY_RESET_REQUIRED'); // la lectura ya declara el reinicio requerido (sin crear nada)
  await rejects(on.provisionLibrary({ userId: reset.userId }), 'LIBRARY_RESET_REQUIRED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_libraries WHERE user_id = $1', [reset.userId])).rows[0].n, 0, '0 escrituras');
}));

test('capa 2: session/start exige catalog-v1 solo para dueños con catálogo y flag encendido (410 antes de Direct); flag apagado → FLAG_OFF; legacy → LEGACY; la respuesta catalog-v1 lleva era/época y nunca credenciales', () => withDb(async (pool) => {
  const native = await user(pool); const legacy = await user(pool, { native: false });
  const on = guard.createCatalogSessionGuard({ pool, authority: authOn(pool) }); const off = guard.createCatalogSessionGuard({ pool, authority: authOff(pool) });
  await rejects(on.assertProtocol({ userId: native.userId, protocol: null }), 'LEGACY_CLIENT_UNSUPPORTED', (e) => e.status === 410 && e.detail.required === CATALOG_SESSION_PROTOCOL);
  await rejects(on.assertProtocol({ userId: native.userId, protocol: 'direct-v4' }), 'LEGACY_CLIENT_UNSUPPORTED');
  const ok = await on.assertProtocol({ userId: native.userId, protocol: CATALOG_SESSION_PROTOCOL });
  assert.deepEqual([ok.catalog, ok.outcome, ok.authority, ok.authority_era, ok.authority_epoch], [true, 'CATALOG', 'POSTGRES', native.era, native.epoch]);
  assert.ok(!/token|api_id|api_hash|bot/i.test(JSON.stringify(ok)));
  assert.deepEqual(await on.assertProtocol({ userId: legacy.userId, protocol: null }), { catalog: false, outcome: 'LEGACY' });
  assert.equal((await off.assertProtocol({ userId: native.userId, protocol: null })).outcome, 'FLAG_OFF');
}));

test('Telegram caído (gateway nulo): capacidades de subida → 503 TRANSFER_UNAVAILABLE, jobs de verificación en reintento visible, metadata y mutaciones siguen; cuarentena aislada: solo esa biblioteca queda cerrada; reinicio del worker: lease vencido → otro worker termina y el viejo queda fenced', () => withDb(async (pool) => {
  const a = authOn(pool); const libA = await user(pool); const libB = await user(pool);
  const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats: null }) });
  const q = queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  const cmd = commands.createCatalogCommands({ pool, authority: a });
  const transport = createCatalogTransport({ pool, authority: a, operations: ops, gateway: null, tempDir: TMP });
  const hdrA = { userId: libA.userId, era: libA.era, epoch: libA.epoch }; const hdrB = { userId: libB.userId, era: libB.era, epoch: libB.epoch };
  // metadata OK sin transporte
  assert.equal((await q.listBeats({ userId: libA.userId, query: {} })).items.length, 0);
  const op = await ops.createOperation({ ...hdrA, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [{ partKey: 'm0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: 10 }], metadata: { name: 'Offline' } } });
  await rejects(transport.issueUploadCapability({ ...hdrA, operationId: op.operationId, partKey: 'm0' }), 'TRANSFER_UNAVAILABLE', (e) => e.status === 503 && e.detail.reason === 'NO_GATEWAY');
  // un recibo externo (p. ej. reconciliado) deja un job de verificación que, sin gateway, reintenta de forma visible (nunca se da por verificado)
  await ops.markDispatched({ ...hdrA, operationId: op.operationId, partKey: 'm0' });
  await ops.putReceipt({ ...hdrA, operationId: op.operationId, partKey: 'm0', receipt: { messageId: 5, size: 10 } });
  const w1 = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: null, owner: 'w1', options: { renewEveryMs: 100_000 } });
  const r1 = await w1.runOnce();
  assert.deepEqual(r1.map((x) => [x.outcome, x.error]), [['retry', 'TRANSPORT_UNAVAILABLE']]);
  assert.equal((await pool.query("SELECT state FROM catalog_jobs WHERE user_id = $1 AND kind = 'TRANSFER_VERIFY'", [libA.userId])).rows[0].state, 'QUEUED');
  assert.equal((await ops.getOperation({ userId: libA.userId, operationId: op.operationId })).parts[0].dispatchState, 'RECEIPT', 'sin proveedor no hay VERIFIED');
  // biblioteca aislada por cuarentena del flush (NATIVO §6.2; REVIEW no existe en nativo: 0027 exige IDLE): solo B queda cerrada
  await pool.query("INSERT INTO control_plane_flush_quarantine(user_id, field, value_sha256) VALUES ($1, 'telegram_chat_id', $2)", [libB.userId, crypto.createHash('sha256').update(libB.chatId).digest('hex')]);
  await rejects(cmd.createSelection({ ...hdrB, setId: 'qs-x', sort: 'rating', defaultSelected: true, consumerId: 'c' }), 'VAULT_QUARANTINED');
  await rejects(q.listBeats({ userId: libB.userId, query: {} }), 'VAULT_QUARANTINED');
  const sel = await q.createQuerySet({ userId: libA.userId, query: { state: 'ACTIVE' }, consumer: { id: 'c', kind: 'SELECTION' } });
  assert.ok(sel.setId, 'la biblioteca sana sigue aceptando mutaciones');
  // reinicio del worker: w1 reclama (lease), "muere" (lease vencido), w2 lo termina; w1 no confirma
  await pool.query('UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1', [libA.userId]); // el backoff del reintento no se espera en pruebas
  const [job] = await ops.claimJobs({ owner: 'w1', kinds: ['TRANSFER_VERIFY'] });
  await pool.query("UPDATE catalog_jobs SET lease_until = now() - interval '1 second' WHERE job_id = $1", [job.jobId]);
  const w2 = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: { async verifyMessage() { return { size: 10, sha256: null }; }, async searchByRandomId() { return []; } }, owner: 'w2', options: { renewEveryMs: 100_000 } });
  const r2 = await w2.runOnce();
  assert.equal(r2.find((x) => x.jobId === job.jobId)?.outcome, 'done');
  await rejects(ops.completeJob({ jobId: job.jobId, lease: job.lease }), 'LEASE_FENCED');
  assert.equal((await ops.getOperation({ userId: libA.userId, operationId: op.operationId })).parts[0].dispatchState, 'VERIFIED');
}));

test('guarda hacia delante: la DB con una versión desconocida en schema_migrations no arranca (CATALOG_SCHEMA_AHEAD); sin ella, ok; la guarda no modifica la DB', () => withDb(async (pool) => {
  const ok = await mig.assertKnownMigrations(pool);
  assert.equal(ok.unknown.length, 0); assert.equal(ok.applied, mig.listMigrations().length);
  await pool.query("INSERT INTO schema_migrations(version, checksum_sha256) VALUES ('0099', $1)", ['f'.repeat(64)]);
  await rejects(mig.assertKnownMigrations(pool), 'CATALOG_SCHEMA_AHEAD', (e) => e.unknown.includes('0099'));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schema_migrations WHERE version = '0099'")).rows[0].n, 1, 'la guarda solo lee');
}));
