'use strict';
// T03 — Esquema base del catálogo contra PostgreSQL real aislado (solo vía `node scripts/catalog-check.cjs T03`).
// Cada test crea su propia DB efímera verificada y la borra con cleanup seguro. Sin skip.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const { createCatalogRepository } = require('../../catalog/repository.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget(); // sin destino aprobado el archivo falla, no se salta
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const H = sha('source');

async function withDb(fn) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max: 6 });
  try { return await fn(pool, h); } finally { await pool.end(); await h.cleanup(); }
}
// Ejecuta en una transacción y devuelve 'OK' o el SQLSTATE (incluye fallos diferidos en COMMIT).
async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    try { await fn(c); await c.query('COMMIT'); return 'OK'; } catch (e) { await c.query('ROLLBACK').catch(() => {}); return e.code || e.message; }
  } finally { c.release(); }
}
const one = (pool, sql, params) => tx(pool, (c) => c.query(sql, params));
async function legacyDigest(pool) {
  const r = await pool.query(`SELECT md5(string_agg(t, '|' ORDER BY t)) AS d, count(*)::int AS n FROM (
    SELECT 'u:' || id || ':' || coalesce(email, '') AS t FROM users
    UNION ALL SELECT 'v:' || id || ':' || user_id || ':' || telegram_chat_id FROM vaults
    UNION ALL SELECT 'q:' || user_id || ':' || index_message_id || ':' || index_sha256 FROM library_quota_state
    UNION ALL SELECT 'b:' || user_id || ':' || beat_id || ':' || state FROM library_beats) x`);
  return r.rows[0];
}
const beatSql = `INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, manual_rank, legacy_json, legacy_sha256, legacy_export_bytes, bpm_sort_class, bpm_sort, rating)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
const beatArgs = (u, g, id, o = {}) => { const j = o.json ?? JSON.stringify({ id }); return [u, g, id, o.state ?? 'ACTIVE', o.rank ?? 1, j, o.hash ?? sha(Buffer.from(j, 'utf8')), o.bytes ?? Buffer.byteLength(j), o.cls ?? 3, o.bpm ?? null, o.rating ?? null]; };

async function seedUsers(pool) {
  await pool.query("INSERT INTO users(id, email) VALUES ('u1','u1@fake.invalid'), ('u2','u2@fake.invalid')");
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id) VALUES ('v1','u1','-1001'), ('v2','u2','-1002')");
}

// T05-N: 0027_catalog_native.sql se aplica junto con 0026; las guardas de 0027 no actúan sin activación ni origin nativo,
// así que estas pruebas (bibliotecas LEGACY, LEGACY→POSTGRES y DELETE de LEGACY) conservan su resultado.
const MIGRATIONS = mig.listMigrations().length;
test('fresh: todas las migraciones (0001–0027), idempotente y catálogo vacío en LEGACY', (t) => withDb(async (pool) => {
  const first = await mig.applyMigrations(pool);
  assert.equal(MIGRATIONS, 27);
  assert.equal(first.applied.length, MIGRATIONS); assert.equal(first.applied.at(-1), '0027');
  const again = await mig.applyMigrations(pool);
  assert.equal(again.applied.length, 0); assert.equal(again.skipped.length, MIGRATIONS);
  const tables = await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'catalog\\_%'");
  assert.equal(tables.rows[0].n, mig.CATALOG_REQUIRED_TABLES.length);
  const types = await pool.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name LIKE 'catalog\\_%' AND data_type IN ('jsonb','json')");
  assert.deepEqual(types.rows, [], 'ninguna columna JSON binaria en el catálogo');
  const size = await pool.query("SELECT sum(pg_total_relation_size(c.oid))::bigint AS bytes, count(*)::int AS rels FROM pg_class c WHERE c.relname LIKE 'catalog\\_%' AND c.relkind IN ('r','i')");
  t.diagnostic(`tamaño inicial catálogo: ${size.rows[0].bytes} bytes en ${size.rows[0].rels} relaciones (no es benchmark T20)`);
}));

test('aplicación concurrente desde DB vacía: un solo ledger, sin duplicados', () => withDb(async (pool, h) => {
  const pool2 = new Pool({ ...h.config, max: 2 });
  try {
    const [a, b] = await Promise.all([mig.applyMigrations(pool), mig.applyMigrations(pool2)]);
    assert.equal(a.applied.length + b.applied.length, MIGRATIONS);
    assert.equal(a.skipped.length + b.skipped.length, MIGRATIONS);
    const r = await pool.query('SELECT count(*)::int AS n, count(DISTINCT version)::int AS d FROM schema_migrations');
    assert.deepEqual(r.rows[0], { n: MIGRATIONS, d: MIGRATIONS });
  } finally { await pool2.end(); }
}));

test('upgrade 0001-0025 → 0026 conserva datos legacy y no importa nada', () => withDb(async (pool) => {
  const all = mig.listMigrations();
  assert.equal((await mig.applyMigrations(pool, all.slice(0, 25))).applied.length, 25);
  await seedUsers(pool);
  await pool.query(`INSERT INTO library_quota_state(user_id, index_message_id, index_sha256) VALUES ('u1', 77, $1)`, [H]);
  await pool.query("INSERT INTO library_beats(user_id, beat_id, state) VALUES ('u1','b1','ACTIVE'), ('u1','b2','TRASH'), ('u2','b1','ACTIVE')");
  const before = await legacyDigest(pool);
  const up = await mig.applyMigrations(pool, all);
  assert.deepEqual(up.applied, ['0026', '0027']);
  assert.deepEqual(await legacyDigest(pool), before);
  const cat = await pool.query('SELECT (SELECT count(*) FROM catalog_libraries)::int + (SELECT count(*) FROM catalog_generations)::int + (SELECT count(*) FROM catalog_beats)::int AS n');
  assert.equal(cat.rows[0].n, 0, 'la migración no crea bibliotecas ni importa');
  assert.equal(await one(pool, "INSERT INTO vaults(id, user_id, telegram_chat_id) VALUES ('v3','u1','-1003')"), '23505', 'vaults sigue con un vault por usuario');
}));

test('restricciones de biblioteca, generación y autoridad', () => withDb(async (pool) => {
  await mig.applyMigrations(pool); await seedUsers(pool);
  const repo = createCatalogRepository({ pool });
  const lib = await repo.withTransaction((t) => t.createLibrary({ userId: 'u1', vaultId: 'v1' }));
  assert.deepEqual([lib.authority, lib.migration_state, lib.cleanup_enabled, lib.restore_hold, lib.revision], ['LEGACY', 'IDLE', false, true, '1']);
  assert.equal(await one(pool, "INSERT INTO catalog_libraries(user_id, vault_id) VALUES ('u2','v1')"), '23505', 'vault ya asignado');
  assert.equal(await one(pool, "INSERT INTO catalog_libraries(user_id, vault_id) VALUES ('u2','vX')"), '23503', 'vault inexistente/ajeno');
  await pool.query("DELETE FROM catalog_libraries WHERE user_id='u1'");
  assert.equal(await one(pool, "INSERT INTO catalog_libraries(user_id, vault_id) VALUES ('u1','v2')"), '23503', 'vault de otro usuario');
  await pool.query("INSERT INTO catalog_libraries(user_id, vault_id) VALUES ('u1','v1'), ('u2','v2')");
  assert.equal(await one(pool, "UPDATE catalog_libraries SET cleanup_enabled = true WHERE user_id='u1'"), '23514', 'cleanup bajo LEGACY');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET authority='POSTGRES' WHERE user_id='u1'"), '23514', 'POSTGRES sin generación');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET revision = 0 WHERE user_id='u1'"), '23514');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET trash_count = -1 WHERE user_id='u1'"), '23514');

  const s1 = { userId: 'u1', generationId: 'g1' };
  await repo.withTransaction((t) => t.createGeneration(s1, { snapshotId: 'snap-1', rawIndex: Buffer.from('{"schema":"beatgaler.telegram.library"}') }));
  await repo.withTransaction((t) => t.createGeneration({ userId: 'u2', generationId: 'g9' }, { snapshotId: 'snap-9' }));
  assert.equal(await one(pool, "INSERT INTO catalog_generations(user_id, generation_id, snapshot_id, raw_index, raw_index_sha256) VALUES ('u1','g2','s', '\\x00'::bytea, $1)", [H]), '23514', 'hash raw no coincide');
  assert.equal(await one(pool, "UPDATE catalog_generations SET raw_index = '\\x01'::bytea, raw_index_sha256 = encode(sha256('\\x01'::bytea),'hex') WHERE generation_id='g1'"), '23514', 'raw inmutable');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET active_generation_id='g1' WHERE user_id='u1'"), '23503', 'generación STAGING como activa');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET active_generation_id='g9' WHERE user_id='u1'"), '23503', 'generación de otro usuario');
  assert.equal(await one(pool, "UPDATE catalog_generations SET status='ACTIVE' WHERE generation_id='g1'"), '23514', 'STAGING→ACTIVE');
  assert.equal(await one(pool, "UPDATE catalog_generations SET status='VALIDATED' WHERE generation_id='g1'"), '23514', 'VALIDATED sin source_hash');
  await repo.withTransaction((t) => t.setGenerationStatus(s1, { status: 'VALIDATED', sourceHash: H }));
  assert.equal(await tx(pool, async (c) => {
    await c.query("UPDATE catalog_generations SET status='ACTIVE' WHERE user_id='u1' AND generation_id='g1'");
    await c.query("UPDATE catalog_libraries SET active_generation_id='g1', authority='POSTGRES' WHERE user_id='u1'");
  }), 'OK');
  assert.equal(await one(pool, "UPDATE catalog_generations SET status='VALIDATED' WHERE generation_id='g1'"), '23514', 'ACTIVE→VALIDATED');
  assert.equal(await one(pool, "UPDATE catalog_generations SET status='RETIRED' WHERE generation_id='g1'"), '23503', 'retirar la activa sin mover el puntero');
  await pool.query("INSERT INTO catalog_generations(user_id, generation_id, snapshot_id, source_hash, validated_at, status) VALUES ('u1','g3','s3',$1, now(),'STAGING')", [H]);
  await pool.query("UPDATE catalog_generations SET status='VALIDATED' WHERE generation_id='g3'");
  assert.equal(await one(pool, "UPDATE catalog_generations SET status='ACTIVE' WHERE generation_id='g3'"), '23505', 'dos generaciones ACTIVE');
  assert.equal(await one(pool, "UPDATE catalog_libraries SET cleanup_enabled = true WHERE user_id='u1'"), 'OK', 'cleanup solo posible ya en POSTGRES');
}));

test('restricciones de beats, tags, papelera, tombstones, archivos y conjuntos', () => withDb(async (pool) => {
  await mig.applyMigrations(pool); await seedUsers(pool);
  await pool.query("INSERT INTO catalog_libraries(user_id, vault_id) VALUES ('u1','v1'), ('u2','v2')");
  await pool.query("INSERT INTO catalog_generations(user_id, generation_id, snapshot_id) VALUES ('u1','g1','s1'), ('u1','g2','s2'), ('u2','g9','s9')");
  const ok = (id, o) => one(pool, beatSql, beatArgs('u1', 'g1', id, o));
  assert.equal(await ok('b1', { rank: 10 }), 'OK');
  assert.equal(await one(pool, beatSql, beatArgs('u1', 'g9', 'bx')), '23503', 'generación de otro usuario');
  assert.equal(await ok(' x'), '23514'); assert.equal(await ok('x '), '23514');
  assert.equal(await ok('a'.repeat(257)), '23514');
  assert.equal(await ok('😀'.repeat(129)), '23514', 'UTF-16 > 256');
  assert.equal(await ok('a'.repeat(255) + '😀'), '23514', '256 code points pero 257 UTF-16');
  assert.equal(await ok('😀'.repeat(128)), 'OK');
  const scope = await pool.query("SELECT beat_id, direct_scope_compatible FROM catalog_beats WHERE generation_id='g1'");
  const dsc = Object.fromEntries(scope.rows.map((r) => [r.beat_id, r.direct_scope_compatible]));
  assert.deepEqual([dsc.b1, dsc['😀'.repeat(128)]], [true, false]);
  assert.equal(await ok('b-hash', { hash: H }), '23514', 'legacy_sha256 no corresponde a legacy_json');
  assert.equal(await ok('b-neg', { bytes: -1 }), '23514');
  assert.equal(await ok('b-rate', { rating: 300 }), '23514');
  assert.equal(await ok('b-cls', { cls: 1 }), '23514', 'clase finita sin valor');
  assert.equal(await ok('b-inf', { cls: 1, bpm: 'Infinity' }), '23514');
  assert.equal(await ok('b-state', { state: 'DELETED' }), '23514');
  assert.equal(await ok('b-nul', { json: JSON.stringify({ id: 'b-nul', x: 'a\u0000b' }) }), 'OK', 'TEXT con escape \\u0000 se conserva');
  const nul = await pool.query("SELECT legacy_json FROM catalog_beats WHERE beat_id='b-nul'");
  assert.equal(JSON.parse(nul.rows[0].legacy_json).x, 'a\u0000b');
  assert.equal(await ok('b1'), '23505', 'beat duplicado');

  // tags y grupos denormalizados
  await pool.query("INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key) VALUES ('u1','g1','b1',0,'Trap','trap'), ('u1','g1','b1',1,' trap','trap')");
  assert.equal(await one(pool, "INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key) VALUES ('u1','g1','b1',1,'x','x')"), '23505');
  assert.equal(await one(pool, "INSERT INTO catalog_beat_tag_groups VALUES ('u1','g1','b1','trap',1,'TRASH',10,0,'Trap')"), '23503', 'estado denormalizado distinto');
  assert.equal(await one(pool, "INSERT INTO catalog_beat_tag_groups VALUES ('u1','g1','b1','trap',1,'ACTIVE',10,5,'Trap')"), '23503', 'first_position inexistente');
  assert.equal(await one(pool, "INSERT INTO catalog_beat_tag_groups VALUES ('u1','g1','b1','trap',1,'ACTIVE',10,0,'Trap')"), 'OK');
  await pool.query("UPDATE catalog_beats SET manual_rank = 3 WHERE beat_id='b1'");
  assert.equal((await pool.query("SELECT manual_rank::text AS r FROM catalog_beat_tag_groups WHERE beat_id='b1'")).rows[0].r, '3', 'rank en cascada');
  assert.equal(await one(pool, "INSERT INTO catalog_facets VALUES ('u1','g1','ACTIVE','trap',1,0,'b1',0,'Trap',1)"), '23514', 'count 0 con representante');
  assert.equal(await one(pool, "INSERT INTO catalog_facets VALUES ('u1','g1','ACTIVE','nope',1,1,'b1',0,'Nope',1)"), '23503', 'representante sin grupo');
  assert.equal(await one(pool, "INSERT INTO catalog_facets VALUES ('u1','g1','ACTIVE','trap',1,1,'b1',0,'Trap',1)"), 'OK');

  // papelera: solo beats en TRASH/PURGING/PURGED; restaurar exige quitar la entrada
  assert.equal(await one(pool, "INSERT INTO catalog_trash_entries VALUES ('u1','g1','b1','ACTIVE',true,'t1',now(),null,'{}',0)"), '23514');
  await pool.query("UPDATE catalog_beats SET state='TRASH' WHERE beat_id='b1'");
  assert.equal((await pool.query("SELECT state FROM catalog_beat_tag_groups WHERE beat_id='b1'")).rows[0].state, 'TRASH', 'estado en cascada');
  assert.equal(await one(pool, "INSERT INTO catalog_trash_entries VALUES ('u1','g1','b1','TRASH',false,'t1',null,null,null,0)"), '23514', 'sin wrapper no hay trash_id');
  assert.equal(await one(pool, "INSERT INTO catalog_trash_entries VALUES ('u1','g1','b1','TRASH',true,'t1',now(),null,'{}',0)"), 'OK');
  assert.equal(await ok('b2'), 'OK'); await pool.query("UPDATE catalog_beats SET state='TRASH' WHERE beat_id='b2'");
  assert.equal(await one(pool, "INSERT INTO catalog_trash_entries VALUES ('u1','g1','b2','TRASH',true,'t1',now(),null,'{}',1)"), '23505', 'trash_id repetido');
  assert.equal(await one(pool, "UPDATE catalog_beats SET state='ACTIVE' WHERE beat_id='b1'"), '23514', 'restore con entrada de papelera');
  assert.equal(await tx(pool, async (c) => { await c.query("DELETE FROM catalog_trash_entries WHERE beat_id='b1'"); await c.query("UPDATE catalog_beats SET state='ACTIVE' WHERE beat_id='b1'"); }), 'OK');

  // tombstones: vivo vs tombstone imposible en ambos sentidos
  assert.equal(await one(pool, "INSERT INTO catalog_tombstones(user_id, generation_id, beat_id, source, sql_state) VALUES ('u1','g1','b1','SQL','CONFIRMED')"), '23514');
  assert.equal(await one(pool, "INSERT INTO catalog_tombstones(user_id, generation_id, beat_id, source) VALUES ('u1','g1','gone','INDEX')"), '23514', 'INDEX sin original_json');
  assert.equal(await one(pool, "INSERT INTO catalog_tombstones(user_id, generation_id, beat_id, source, sql_state, beat_sha256) VALUES ('u1','g1','gone','SQL','CONFIRMED',$1)", [H]), 'OK');
  assert.equal(await ok('gone'), '23514', 'beat vivo con tombstone');

  // archivos, partes, objetos y ubicaciones
  const fv = "INSERT INTO catalog_file_versions(user_id, generation_id, file_id, beat_id, role, legacy_path, size_bytes) VALUES ";
  assert.equal(await one(pool, `${fv}('u1','g1','f1','b1','MASTER','$.beats[0].master',10), ('u1','g1','f2','b2','STEMS','$.trash[0].beat.files[0]',null)`), 'OK');
  assert.equal(await one(pool, `${fv}('u1','g1','f3','b1','MASTER','x',-1)`), '23514');
  assert.equal(await one(pool, `${fv}('u1','g1','f3','b1','VIDEO','x',1)`), '23514');
  await pool.query("INSERT INTO catalog_file_parts(user_id, generation_id, file_id, part_index, size_bytes) VALUES ('u1','g1','f1',0,5), ('u1','g1','f1',1,5)");
  assert.equal(await one(pool, "INSERT INTO catalog_file_parts(user_id, generation_id, file_id, part_index) VALUES ('u1','g1','f1',1)"), '23505', 'parte duplicada');
  assert.equal(await one(pool, "INSERT INTO catalog_file_parts(user_id, generation_id, file_id, part_index) VALUES ('u1','g1','f1',-1)"), '23514');
  await pool.query("INSERT INTO catalog_media_objects(user_id, object_id, provider, chat_id, message_id) VALUES ('u1','o1','telegram','-1001',501), ('u2','o9','telegram','-1002',501)");
  assert.equal(await one(pool, "INSERT INTO catalog_media_objects(user_id, object_id, provider, chat_id, message_id) VALUES ('u1','o2','telegram','-1001',501)"), '23505', 'mismo mensaje físico');
  const loc = "INSERT INTO catalog_part_locations(user_id, generation_id, file_id, part_index, location, reference_class, object_id, provider, locator) VALUES ";
  assert.equal(await one(pool, `${loc}('u1','g1','f1',0,'PRIMARY','KNOWN','o1','telegram','direct:501')`), 'OK');
  assert.equal(await one(pool, `${loc}('u1','g1','f1',1,'PRIMARY','KNOWN','o9','telegram','direct:501')`), '23503', 'objeto de otro usuario');
  assert.equal(await one(pool, `${loc}('u1','g1','f1',1,'PRIMARY','KNOWN',null,'telegram','direct:502')`), '23514', 'KNOWN sin objeto');
  assert.equal(await one(pool, `${loc}('u1','g1','f1',1,'PRIMARY','OPAQUE',null,'telegram','AgAC-opaque')`), 'OK');
  assert.equal(await one(pool, "DELETE FROM catalog_media_objects WHERE object_id='o1'"), '23503', 'objeto físico referenciado no se borra');
  assert.equal(await one(pool, "INSERT INTO catalog_current_files VALUES ('u1','g1','b1','MASTER','f2')"), '23503', 'archivo de otro beat');
  assert.equal(await one(pool, "INSERT INTO catalog_current_files VALUES ('u1','g1','b1','THUMB','f1')"), '23514');
  assert.equal(await one(pool, "INSERT INTO catalog_current_files VALUES ('u1','g1','b1','MASTER','f1'), ('u1','g1','b2','FILES:0','f2')"), 'OK');
  assert.equal(await one(pool, "INSERT INTO catalog_legacy_fields VALUES ('u1','g1','root','x_root_nul',0,$1,'NONE')", [JSON.stringify('r\u0000')]), 'OK');
  assert.equal(await one(pool, "INSERT INTO catalog_legacy_fields VALUES ('u1','g1','beats','x',0,'1','NONE')"), '23514');

  // conjuntos de consulta
  const qs = (id, status = 'BUILDING', g = 'g1', h = H, rev = 1) => one(pool, `INSERT INTO catalog_query_sets(user_id, set_id, generation_id, authority_era, authority_epoch, scope, predicate_json, predicate_version, predicate_hash, base_revision, status)
    VALUES ('u1',$1,$2,gen_random_uuid(),1,'ACTIVE','{}',1,$3,$4,$5)`, [id, g, h, rev, status]);
  assert.equal(await qs('s1'), 'OK');
  assert.equal(await qs('s2', 'BUILDING', 'g1', sha('other')), '23505', 'una preparación por cuenta');
  assert.equal(await qs('s3', 'READY', 'g9'), '23503', 'generación de otro usuario');
  await pool.query("INSERT INTO catalog_query_members VALUES ('u1','s1',0,'g1','b1',1), ('u1','s1',1,'g1','b2',1)");
  assert.equal(await one(pool, "INSERT INTO catalog_query_members VALUES ('u1','s1',2,'g2','b-nul',1)"), '23503', 'miembro de otra generación');
  assert.equal(await one(pool, "INSERT INTO catalog_query_members VALUES ('u1','s1',2,'g1','b1',1)"), '23505', 'beat repetido');
  assert.equal(await one(pool, "UPDATE catalog_query_sets SET status='READY', member_count=3 WHERE set_id='s1'"), '23514', 'READY con conteo incorrecto');
  assert.equal(await one(pool, "UPDATE catalog_query_sets SET status='READY', member_count=2 WHERE set_id='s1'"), 'OK');
  assert.equal(await one(pool, "UPDATE catalog_query_sets SET status='BUILDING' WHERE set_id='s1'"), '23514', 'READY→BUILDING');
  assert.equal(await one(pool, "UPDATE catalog_query_sets SET base_revision=2 WHERE set_id='s1'"), '23514', 'identidad inmutable');
  assert.equal(await one(pool, "UPDATE catalog_query_sets SET status='FAILED' WHERE set_id='s1'"), '23514', 'READY→FAILED');
  assert.equal(await one(pool, "INSERT INTO catalog_query_set_leases VALUES ('u1','s1','c1','SHUFFLE', now() + interval '30 minutes')"), 'OK');
  assert.equal(await one(pool, "DELETE FROM catalog_beats WHERE beat_id='b2'"), '23503', 'beat miembro no se borra físicamente');
}));

test('repositorio sobre PostgreSQL: rollback y release medidos', () => withDb(async (pool) => {
  await mig.applyMigrations(pool); await seedUsers(pool);
  const ip = db.instrumentPool(pool);
  const repo = createCatalogRepository({ pool: ip.pool });
  await repo.withTransaction((t) => t.createLibrary({ userId: 'u1', vaultId: 'v1' }));
  await repo.withTransaction((t) => t.createGeneration({ userId: 'u1', generationId: 'g1' }, { snapshotId: 's1' }));
  await assert.rejects(repo.withTransaction(async (t) => {
    await t.insertBeat({ userId: 'u1', generationId: 'g1' }, { beatId: 'b1', manualRank: 1, legacyJson: '{"id":"b1"}' });
    await t.insertBeat({ userId: 'u1', generationId: 'g1' }, { beatId: ' bad', manualRank: 2, legacyJson: '{}' });
  }), (e) => e.code === '23514');
  const b = await repo.withTransaction((t) => t.getBeat({ userId: 'u1', generationId: 'g1' }, 'b1'));
  assert.equal(b, null, 'rollback completo');
  const ins = await repo.withTransaction((t) => t.insertBeat({ userId: 'u1', generationId: 'g1' }, { beatId: 'b1', manualRank: 1, legacyJson: '{"id":"b1","x":"\\u0000"}' }));
  assert.equal(ins.version, '1');
  const s = ip.stats();
  assert.equal(s.open, 0); assert.equal(s.acquired, 5);
  assert.deepEqual([s.begin, s.commit, s.rollback], [5, 4, 1]);
}));
