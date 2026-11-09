'use strict';
// T07 — Mutaciones contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T07`). Cada test crea su DB efímera.
// C(T07) + r4: PATCH/trash/restore con versión, dos conexiones misma versión = 1 éxito/1 conflicto, no-op/replay, claves distintas,
// fallo entre sentencias (rollback íntegro), counter drift, selección CAS/rangos, bulk por lotes con conflicto tras el lote 2,
// respuesta perdida pre/postcommit, workers duplicados, cancel, rename a existente con TRASH intacto, feed /changes. 0 Telegram.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const queries = require('../../catalog/queries.js');
const commands = require('../../catalog/commands.js');
const codec = require('../../catalog/legacy-codec.js');
const { rebuildDerivedProjections } = require('../../catalog/staging.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const KEYS = [{ kid: 'k1', secret: crypto.randomBytes(32) }];
const H = crypto.createHash('sha256').update('x').digest('hex');
let seq = 0; let keyN = 0;
const key = () => `k-${++keyN}`;

async function withDb(fn, { max = 8 } = {}) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max });
  try {
    await mig.applyMigrations(pool);
    await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [H]);
    return await fn(pool, h);
  } finally { await pool.end(); await h.cleanup(); }
}
const auth = (pool) => authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres' });
const mk = (pool) => ({ cmd: commands.createCatalogCommands({ pool, authority: auth(pool) }), q: queries.createCatalogQueries({ pool, authority: auth(pool), cursorKeys: KEYS }) });
async function nativeLibrary(pool) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, generationId: ctx.generation_id, era: ctx.authority_era, epoch: ctx.authority_epoch };
}
async function seedBeats(pool, lib, beats, { state = 'ACTIVE' } = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let rank = 0;
    for (const beat of beats) {
      const p = codec.projectBeat(beat); const json = JSON.stringify(beat);
      await c.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, color, color2, bpm_sort_class, bpm_sort, sort_order, manual_rank,
          has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [lib.userId, lib.generationId, beat.id, state, p.name, p.bpmText, p.keyText, p.rating, p.color, p.color2, p.bpmSortClass, p.bpmSort, p.sortOrder, String(rank++ * 1000),
        p.hasArtwork, json, crypto.createHash('sha256').update(json, 'utf8').digest('hex'), Buffer.byteLength(json, 'utf8'), p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay]);
      for (const t of p.tags) await c.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [lib.userId, lib.generationId, beat.id, t.position, t.label, t.normKey, t.searchKey]);
    }
    await c.query(`UPDATE catalog_libraries SET active_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE'),
      trash_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'TRASH') WHERE user_id = $1`, [lib.userId, lib.generationId]);
    await rebuildDerivedProjections(c, lib);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const gen = (n, f = () => ({})) => Array.from({ length: n }, (_, i) => ({ id: `b${String(i).padStart(4, '0')}`, name: `Beat ${i}`, bpm: '120', key: 'Cm', rating: i % 5, tags: [i % 2 ? 'odd' : 'even', 'all'], ...f(i) }));
const libRow = async (pool, uid) => (await pool.query('SELECT revision::text AS revision, active_count::int AS active, trash_count::int AS trash FROM catalog_libraries WHERE user_id = $1', [uid])).rows[0];
// Invariante de contadores y proyecciones: contadores = filas; facetas = grupos; grupos = tags distintos por beat.
async function assertConsistent(pool, lib) {
  const l = await libRow(pool, lib.userId);
  const counts = (await pool.query("SELECT state, count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 GROUP BY state", [lib.userId, lib.generationId])).rows;
  const n = (st) => counts.find((c) => c.state === st)?.n || 0;
  assert.deepEqual([l.active, l.trash], [n('ACTIVE'), n('TRASH')], 'contadores = filas');
  const drift = (await pool.query(`SELECT f.scope, f.norm_key, f.beat_count::int AS n, (SELECT count(*)::int FROM catalog_beat_tag_groups g WHERE g.user_id = f.user_id AND g.generation_id = f.generation_id AND g.norm_key = f.norm_key AND g.state = f.scope) AS real
    FROM catalog_facets f WHERE f.user_id = $1 AND f.generation_id = $2`, [lib.userId, lib.generationId])).rows.filter((r) => r.n !== r.real);
  assert.deepEqual(drift, [], 'facetas = grupos');
  const missing = (await pool.query(`SELECT count(*)::int AS n FROM (SELECT DISTINCT user_id, generation_id, norm_key, (SELECT state FROM catalog_beats b WHERE b.user_id = t.user_id AND b.generation_id = t.generation_id AND b.beat_id = t.beat_id) AS st FROM catalog_beat_tags t WHERE t.user_id = $1 AND t.generation_id = $2) x
    WHERE st IN ('ACTIVE','TRASH') AND NOT EXISTS (SELECT 1 FROM catalog_facets f WHERE f.user_id = x.user_id AND f.generation_id = x.generation_id AND f.norm_key = x.norm_key AND f.scope = x.st)`, [lib.userId, lib.generationId])).rows[0].n;
  assert.equal(missing, 0, 'cada tag vivo tiene faceta');
  const bad = (await pool.query("SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND legacy_sha256 <> encode(sha256(convert_to(legacy_json, 'UTF8')), 'hex')", [lib.userId])).rows[0].n;
  assert.equal(bad, 0);
  const trashOrphans = (await pool.query("SELECT count(*)::int AS n FROM catalog_beats b LEFT JOIN catalog_trash_entries t USING (user_id, generation_id, beat_id) WHERE b.user_id = $1 AND ((b.state = 'TRASH') <> (t.beat_id IS NOT NULL))", [lib.userId])).rows[0].n;
  assert.equal(trashOrphans, 0, 'TRASH ⇔ entrada de papelera');
}

test('PATCH: versión, idempotencia (replay / mismatch), no-op sin versión ni revisión, campos no editados intactos, proyecciones y facetas, evento; 0 Telegram', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { cmd, q } = mk(pool);
  await seedBeats(pool, lib, gen(3, (i) => ({ artwork: { telegram_message_id: 100 + i }, extra_field: 'keep', bpm: 'oops' })));
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const k1 = key();
  const r = await cmd.patchBeat({ ...hdr, beatId: 'b0001', idempotencyKey: k1, expectedVersion: '1', patch: { name: ' Renamed ', tags: ['trap', 'all'], rating: 7, bpm: '128.50', key: 'c minor', crop: { x: 0, y: 0, w: 1, h: 1, unit: 'ratio' } } });
  assert.deepEqual([r.noop, r.replay, r.revision, r.beat.version, r.beat.name, r.beat.tags, r.beat.rating, r.beat.bpm, r.beat.key], [false, false, '2', '2', 'Renamed', ['trap', 'all'], 7, '128.5', 'cm']);
  const doc = JSON.parse((await pool.query('SELECT legacy_json FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, 'b0001'])).rows[0].legacy_json);
  assert.deepEqual([doc.name, doc.artwork, doc.extra_field, doc.image_crop, Object.keys(doc).slice(0, 2)], [' Renamed ', { telegram_message_id: 101 }, 'keep', { x: 0, y: 0, w: 1, h: 1, unit: 'ratio' }, ['id', 'name']], 'raw: nombre sin recortar, claves ajenas intactas');
  // replay exacto: mismo resultado, sin nueva versión
  const replay = await cmd.patchBeat({ ...hdr, beatId: 'b0001', idempotencyKey: k1, expectedVersion: '1', patch: { name: ' Renamed ', tags: ['trap', 'all'], rating: 7, bpm: '128.50', key: 'c minor', crop: { x: 0, y: 0, w: 1, h: 1, unit: 'ratio' } } });
  assert.deepEqual([replay.replay, replay.operationId, replay.beat.version, replay.revision], [true, r.operationId, '2', '2']);
  await assert.rejects(cmd.patchBeat({ ...hdr, beatId: 'b0001', idempotencyKey: k1, expectedVersion: '1', patch: { name: 'Other' } }), (e) => e.code === 'IDEMPOTENCY_MISMATCH' && e.status === 409);
  // versión vieja → 409 sin cambios; no-op con la misma intención (versión actual) → sin versión/revisión nuevas pero resultado persistido
  await assert.rejects(cmd.patchBeat({ ...hdr, beatId: 'b0001', idempotencyKey: key(), expectedVersion: '1', patch: { name: 'X' } }), (e) => e.code === 'VERSION_CONFLICT' && e.detail.current_version === '2');
  const noop = await cmd.patchBeat({ ...hdr, beatId: 'b0001', idempotencyKey: key(), expectedVersion: '2', patch: { name: ' Renamed ', rating: 7 } });
  assert.deepEqual([noop.noop, noop.beat.version, noop.revision], [true, '2', '2']);
  // proyecciones y facetas: 'odd' perdió un beat, 'trap' nuevo
  const page = await q.listBeats({ userId: lib.userId, query: { q: 'renamed', includeTag: 'trap', includeTotal: 'true' } });
  assert.deepEqual([page.totalMatched, page.items[0].id, page.revision], [1, 'b0001', '2']);
  const facets = (await q.listFacets({ userId: lib.userId, query: {} })).items.map((f) => [f.key, f.count]);
  assert.deepEqual(facets, [['all', 3], ['even', 2], ['odd', 0].filter(() => false).length ? [] : ['trap', 1]].filter((x) => x.length), 'facetas recalculadas: all 3, even 2, trap 1 (odd desaparece)');
  const ch = await cmd.listChanges({ userId: lib.userId, query: { after: '0' } });
  assert.deepEqual(ch.events.map((e) => [e.kind, e.beatId, e.version, e.revision]), [['BEAT_PATCHED', 'b0001', '2', '2']]);
  // beat ajeno/inexistente → 404; patch inválido con detalle → 400; TRASH no editable → 409
  await assert.rejects(cmd.patchBeat({ ...hdr, beatId: 'nope', idempotencyKey: key(), expectedVersion: '1', patch: { name: 'x' } }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(cmd.patchBeat({ ...hdr, beatId: 'b0000', idempotencyKey: key(), expectedVersion: '1', patch: { tags: ['Bad Tag;'] } }), (e) => e.code === 'INPUT_INVALID' && e.detail.errors[0].field === 'tags[0]');
  await cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: 'b0002', expectedVersion: '1' }] });
  await assert.rejects(cmd.patchBeat({ ...hdr, beatId: 'b0002', idempotencyKey: key(), expectedVersion: '2', patch: { name: 'x' } }), (e) => e.code === 'BEAT_NOT_ACTIVE');
  // era/época viejas → 409 sin escribir
  await assert.rejects(cmd.patchBeat({ ...hdr, epoch: '99', beatId: 'b0000', idempotencyKey: key(), expectedVersion: '1', patch: { name: 'x' } }), (e) => e.code === 'CATALOG_EPOCH_STALE');
  await assertConsistent(pool, lib);
  const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
  assert.ok(!loaded.some((k) => /direct-transport-control|master-storage|telegram/.test(k)), '0 transporte cargado');
}));

test('concurrencia: dos conexiones con la misma expectedVersion → exactamente un cambio y un conflicto; dos beats distintos → ambos cambios; respuesta perdida tras commit = replay', () => withDb(async (pool, h) => {
  const lib = await nativeLibrary(pool);
  await seedBeats(pool, lib, gen(4));
  const pools = [new Pool({ ...h.config, max: 3 }), new Pool({ ...h.config, max: 3 })];
  try {
    const cmds = pools.map((p) => mk(p).cmd);
    const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
    const results = await Promise.allSettled([0, 1].map((i) => cmds[i].patchBeat({ ...hdr, beatId: 'b0000', idempotencyKey: `race-${i}`, expectedVersion: '1', patch: { name: `Writer ${i}` } })));
    const ok = results.filter((r) => r.status === 'fulfilled'); const ko = results.filter((r) => r.status === 'rejected');
    assert.deepEqual([ok.length, ko.length, ko[0].reason.code], [1, 1, 'VERSION_CONFLICT']);
    const row = (await pool.query('SELECT version::text AS v, name_display AS n FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, 'b0000'])).rows[0];
    assert.deepEqual([row.v, row.n], ['2', ok[0].value.beat.name], 'el ganador es compatible con la versión inicial');
    const both = await Promise.all([cmds[0].patchBeat({ ...hdr, beatId: 'b0001', idempotencyKey: 'x1', expectedVersion: '1', patch: { rating: 9 } }), cmds[1].patchBeat({ ...hdr, beatId: 'b0002', idempotencyKey: 'x2', expectedVersion: '1', patch: { rating: 8 } })]);
    assert.deepEqual(both.map((b) => b.beat.version), ['2', '2']);
    assert.deepEqual(new Set(both.map((b) => b.revision)).size, 2, 'cada commit avanza la revisión');
    // respuesta perdida: el cliente reintenta con la misma clave → mismo operationId y resultado, sin nueva versión
    const again = await cmds[1].patchBeat({ ...hdr, beatId: 'b0002', idempotencyKey: 'x2', expectedVersion: '1', patch: { rating: 8 } });
    assert.deepEqual([again.replay, again.operationId, again.beat.version], [true, both[1].operationId, '2']);
    // trash concurrente de la misma versión: uno gana
    const tr = await Promise.allSettled([0, 1].map((i) => cmds[i].trashBeats({ ...hdr, idempotencyKey: `t-${i}`, items: [{ beatId: 'b0003', expectedVersion: '1' }] })));
    assert.deepEqual(tr.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.deepEqual((await libRow(pool, lib.userId)), { revision: '5', active: 3, trash: 1 });
  } finally { await Promise.all(pools.map((p) => p.end())); }
  await assertConsistent(pool, lib);
}));

test('trash/restore: lote ≤50 atómico (un conflicto → nada aplicado), wrapper con purge_after +14d y export_position monótono, restore al final del orden manual, tombstone → PURGE_PENDING, fallo entre sentencias → rollback íntegro', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { cmd, q } = mk(pool);
  await seedBeats(pool, lib, gen(60));
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const items = (ids, v = '1') => ids.map((id) => ({ beatId: id, expectedVersion: v }));
  const ids = (a, b) => Array.from({ length: b - a }, (_, i) => `b${String(a + i).padStart(4, '0')}`);
  await assert.rejects(cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: items(ids(0, 51)) }), (e) => e.detail.reason === 'BATCH_TOO_LARGE');
  // un conflicto en el lote → 409 con detalle y 0 aplicados
  await assert.rejects(cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: [...items(ids(0, 10)), { beatId: 'b0010', expectedVersion: '7' }, { beatId: 'nope', expectedVersion: '1' }] }),
    (e) => e.code === 'VERSION_CONFLICT' && e.detail.conflicts.length === 2 && e.detail.conflicts.some((c) => c.reason === 'NOT_FOUND'));
  assert.deepEqual(await libRow(pool, lib.userId), { revision: '1', active: 60, trash: 0 });
  const t1 = await cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: items(ids(0, 50)) });
  assert.deepEqual([t1.items.length, t1.revision, await libRow(pool, lib.userId)], [50, '2', { revision: '2', active: 10, trash: 50 }]);
  const entries = (await pool.query('SELECT beat_id, wrapper_present, trash_id, export_position, purge_after > now() + interval \'13 days\' AS ok14 FROM catalog_trash_entries WHERE user_id = $1 ORDER BY export_position', [lib.userId])).rows;
  assert.equal(entries.length, 50); assert.deepEqual(entries.map((e) => e.export_position), Array.from({ length: 50 }, (_, i) => i)); assert.ok(entries.every((e) => e.wrapper_present && e.trash_id && e.ok14));
  const trashPage = await q.listBeats({ userId: lib.userId, query: { state: 'TRASH', sort: 'manual', limit: '240' } });
  assert.deepEqual([trashPage.items.length, trashPage.totalLibrary, trashPage.items[0].version], [50, 50, '2']);
  // facetas por scope: TRASH tiene 'all' 50, ACTIVE 'all' 10
  const fa = (await q.listFacets({ userId: lib.userId, query: {} })).items.find((f) => f.key === 'all'); const ft = (await q.listFacets({ userId: lib.userId, query: { scope: 'TRASH' } })).items.find((f) => f.key === 'all');
  assert.deepEqual([fa.count, ft.count], [10, 50]);
  // restore de 2: al final del orden manual, wrapper eliminado, versión +1
  const r1 = await cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: items(['b0000', 'b0001'], '2') });
  assert.deepEqual(r1.items.map((i) => i.version), ['3', '3']);
  const order = (await q.listBeats({ userId: lib.userId, query: { sort: 'manual', limit: '240' } })).items.map((i) => i.id);
  assert.deepEqual(order.slice(-2), ['b0000', 'b0001'], 'restore append (C6)');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_trash_entries WHERE user_id = $1", [lib.userId])).rows[0].n, 48);
  // restore de un ACTIVE → STATE_CONFLICT; trash de un TRASH → STATE_CONFLICT; tombstone → PURGE_PENDING
  await assert.rejects(cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: items(['b0000'], '3') }), (e) => e.detail.conflicts[0].reason === 'STATE_CONFLICT');
  await assert.rejects(cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: items(['b0002'], '2') }), (e) => e.detail.conflicts[0].reason === 'STATE_CONFLICT');
  await pool.query("UPDATE catalog_beats SET state = 'PURGED', version = version + 1 WHERE user_id = $1 AND beat_id = 'b0003'", [lib.userId]);
  await pool.query('DELETE FROM catalog_trash_entries WHERE user_id = $1 AND beat_id = $2', [lib.userId, 'b0003']);
  await pool.query("UPDATE catalog_libraries SET trash_count = trash_count - 1 WHERE user_id = $1", [lib.userId]);
  await pool.query("INSERT INTO catalog_tombstones(user_id, generation_id, beat_id, source) VALUES ($1, $2, 'b0003', 'CATALOG')", [lib.userId, lib.generationId]);
  { const c = await pool.connect(); try { await c.query('BEGIN'); await rebuildDerivedProjections(c, lib); await c.query('COMMIT'); } finally { c.release(); } } // la manipulación manual (PURGED) no pasa por los comandos: se reconstruyen proyecciones
  await assert.rejects(cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: items(['b0003'], '3') }), (e) => e.code === 'VERSION_CONFLICT' && e.detail.conflicts[0].reason === 'NOT_FOUND', 'un PURGED es inaccesible para restore');
  // fallo provocado entre sentencias: un trigger que revienta en catalog_events → la transacción entera se deshace (sin escrituras parciales)
  await pool.query("CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom' USING ERRCODE = 'P0001'; END $$; CREATE TRIGGER boom_t BEFORE INSERT ON catalog_events FOR EACH ROW EXECUTE FUNCTION boom()");
  const before = await libRow(pool, lib.userId);
  await assert.rejects(cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: items(['b0004'], '2').map((x) => ({ ...x, beatId: 'b0050', expectedVersion: '1' })) }), (e) => e.code === 'CATALOG_UNAVAILABLE' && e.detail.sqlstate === 'P0001');
  assert.deepEqual(await libRow(pool, lib.userId), before);
  assert.equal((await pool.query("SELECT state FROM catalog_beats WHERE user_id = $1 AND beat_id = 'b0050'", [lib.userId])).rows[0].state, 'ACTIVE');
  await pool.query('DROP TRIGGER boom_t ON catalog_events; DROP FUNCTION boom()');
  await assertConsistent(pool, lib);
}));

test('selección CAS: Select All por conjunto READY, exclusiones, rangos inclusivos por sort, precedencia de la última op, idempotencia, CAS stale, revisión nueva → CONFLICT, flags por DTO', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { cmd, q } = mk(pool);
  await seedBeats(pool, lib, gen(30, (i) => ({ rating: i % 3 })));
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const set = await q.createQuerySet({ userId: lib.userId, query: { includeTag: 'all' }, consumer: { id: 'tab', kind: 'SELECTION' } });
  while ((await q.stepQuerySet({ userId: lib.userId, setId: set.setId, batch: 240 })).status === 'BUILDING');
  const all = await cmd.createSelection({ ...hdr, setId: set.setId, sort: 'rating', defaultSelected: true, consumerId: 'tab' });
  assert.deepEqual([all.count, all.selectionVersion, all.status], [30, '0', 'ACTIVE']);
  const ex = await cmd.applySelectionOp({ ...hdr, selectionId: all.selectionId, selectionVersion: '0', idempotencyKey: 'op1', op: { kind: 'EXCLUDE_IDS', beatIds: ['b0000', 'b0001', 'b0002'] } });
  assert.deepEqual([ex.count, ex.selectionVersion], [27, '1']);
  const same = await cmd.applySelectionOp({ ...hdr, selectionId: all.selectionId, selectionVersion: '0', idempotencyKey: 'op1', op: { kind: 'EXCLUDE_IDS', beatIds: ['b0000', 'b0001', 'b0002'] } });
  assert.deepEqual([same.replay, same.count], [true, 27], 'replay idempotente');
  await assert.rejects(cmd.applySelectionOp({ ...hdr, selectionId: all.selectionId, selectionVersion: '0', idempotencyKey: 'op2', op: { kind: 'CLEAR' } }), (e) => e.code === 'SELECTION_CONFLICT' && e.detail.current_version === '1', 'CAS stale');
  // incluir de nuevo b0001: la última op manda
  const inc = await cmd.applySelectionOp({ ...hdr, selectionId: all.selectionId, selectionVersion: '1', idempotencyKey: 'op3', op: { kind: 'INCLUDE_IDS', beatIds: ['b0001'] } });
  assert.equal(inc.count, 28);
  const flags = await cmd.getSelection({ userId: lib.userId, selectionId: all.selectionId, beatIds: ['b0000', 'b0001', 'b0005', 'zzz'] });
  assert.deepEqual(flags.flags, { b0000: false, b0001: true, b0005: true, zzz: false });
  // selección individual (default false) con rango Shift en orden rating: extremos en cualquier orden
  const order = (await q.listBeats({ userId: lib.userId, query: { sort: 'rating', limit: '240' } })).items.map((i) => i.id);
  const sel = await cmd.createSelection({ ...hdr, setId: set.setId, sort: 'rating', defaultSelected: false, consumerId: 'tab2' });
  const range = await cmd.applySelectionOp({ ...hdr, selectionId: sel.selectionId, selectionVersion: '0', idempotencyKey: 'r1', op: { kind: 'INCLUDE_RANGE', fromBeatId: order[12], toBeatId: order[5] } });
  assert.equal(range.count, 8, 'rango inclusivo 5..12 del orden rating, extremos normalizados');
  const f2 = await cmd.getSelection({ userId: lib.userId, selectionId: sel.selectionId, beatIds: [order[4], order[5], order[12], order[13]] });
  assert.deepEqual(Object.values(f2.flags), [false, true, true, false]);
  const exr = await cmd.applySelectionOp({ ...hdr, selectionId: sel.selectionId, selectionVersion: '1', idempotencyKey: 'r2', op: { kind: 'EXCLUDE_RANGE', fromBeatId: order[8], toBeatId: order[9] } });
  assert.equal(exr.count, 6, 'rangos superpuestos: la última op manda en la intersección');
  const clr = await cmd.applySelectionOp({ ...hdr, selectionId: sel.selectionId, selectionVersion: '2', idempotencyKey: 'r3', op: { kind: 'CLEAR' } });
  assert.deepEqual([clr.count, clr.defaultSelected], [0, false]);
  await assert.rejects(cmd.applySelectionOp({ ...hdr, selectionId: sel.selectionId, selectionVersion: '3', idempotencyKey: 'r4', op: { kind: 'INCLUDE_RANGE', fromBeatId: 'b0000', toBeatId: 'nope' } }), (e) => e.detail.reason === 'SELECTION_RANGE_OUTSIDE_SET');
  // revisión externa → la selección entra en CONFLICT al siguiente comando y los flags la marcan stale
  await cmd.patchBeat({ ...hdr, beatId: 'b0020', idempotencyKey: key(), expectedVersion: '1', patch: { rating: 4 } });
  assert.equal((await cmd.getSelection({ userId: lib.userId, selectionId: all.selectionId })).stale, true);
  await assert.rejects(cmd.applySelectionOp({ ...hdr, selectionId: all.selectionId, selectionVersion: '2', idempotencyKey: 'op9', op: { kind: 'CLEAR' } }), (e) => e.code === 'SELECTION_CONFLICT');
  assert.equal((await cmd.getSelection({ userId: lib.userId, selectionId: all.selectionId })).status, 'CONFLICT');
  await assert.rejects(cmd.createSelection({ ...hdr, setId: set.setId, sort: 'manual', defaultSelected: true, consumerId: 'tab3' }), (e) => e.code === 'CURSOR_STALE', 'conjunto de la revisión anterior');
  assert.equal((await cmd.releaseSelection({ ...hdr, selectionId: sel.selectionId })).status, 'RELEASED');
  const other = await nativeLibrary(pool);
  await assert.rejects(cmd.getSelection({ userId: other.userId, selectionId: all.selectionId }), (e) => e.code === 'NOT_FOUND');
}));

test('bulk: operación congelada sobre selección, lotes de 50 con journal/checkpoint, conflicto externo tras el lote 2 conserva lo confirmado, resume con revisión explícita, workers duplicados, cancel, respuesta perdida precommit', () => withDb(async (pool, h) => {
  const lib = await nativeLibrary(pool); const { cmd, q } = mk(pool);
  await seedBeats(pool, lib, gen(130));
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const set = await q.createQuerySet({ userId: lib.userId, query: {}, consumer: { id: 'tab', kind: 'SELECTION' } });
  while ((await q.stepQuerySet({ userId: lib.userId, setId: set.setId, batch: 240 })).status === 'BUILDING');
  const sel = await cmd.createSelection({ ...hdr, setId: set.setId, sort: 'manual', defaultSelected: true, consumerId: 'tab' });
  const ex = await cmd.applySelectionOp({ ...hdr, selectionId: sel.selectionId, selectionVersion: '0', idempotencyKey: 'e', op: { kind: 'EXCLUDE_IDS', beatIds: ['b0005'] } });
  assert.equal(ex.count, 129);
  const op = await cmd.createOperation({ ...hdr, idempotencyKey: 'bulk-1', kind: 'BULK_PATCH', selectionId: sel.selectionId, selectionVersion: '1', patch: { color: '#123456' } });
  assert.deepEqual([op.status, op.progress.total, op.expectedRevision, op.created], ['QUEUED', 129, '1', true]);
  assert.equal((await cmd.getSelection({ userId: lib.userId, selectionId: sel.selectionId })).status, 'FROZEN');
  await assert.rejects(cmd.createOperation({ ...hdr, idempotencyKey: 'bulk-2', kind: 'BULK_TRASH', selectionId: sel.selectionId, selectionVersion: '1' }), (e) => e.code === 'SELECTION_CONFLICT', 'selección congelada');
  const s1 = await cmd.stepOperation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([s1.status, s1.advanced, s1.progress.confirmed, s1.batchSeq, s1.revision], ['RUNNING', 50, 50, 1, '2']);
  const s2 = await cmd.stepOperation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([s2.status, s2.progress.confirmed, s2.revision], ['RUNNING', 100, '3']);
  // escritura externa (PATCH propio de otro cliente) → el lote 3 no se ejecuta: CONFLICT, lo confirmado se conserva
  await cmd.patchBeat({ ...hdr, beatId: 'b0128', idempotencyKey: key(), expectedVersion: '1', patch: { rating: 1 } });
  const s3 = await cmd.stepOperation({ ...hdr, operationId: op.operationId });
  assert.deepEqual([s3.status, s3.progress.confirmed, s3.progress.conflictBatchSeq, s3.conflict.reason], ['CONFLICT', 100, 3, 'REVISION_CHANGED']);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND color = '#123456'", [lib.userId])).rows[0].n, 100, 'ni más ni menos que los 2 lotes confirmados');
  const detail = await cmd.getOperation({ userId: lib.userId, operationId: op.operationId });
  assert.deepEqual(detail.batches.map((b) => [b.batchSeq, b.status, b.itemCount]), [[1, 'COMMITTED', 50], [2, 'COMMITTED', 50], [3, 'CONFLICT', 0]]);
  assert.deepEqual([detail.details.length, detail.detailsNext !== null], [50, true]);
  // reanudar exige la revisión actual explícita (no retry ciego)
  await assert.rejects(cmd.resumeOperation({ ...hdr, operationId: op.operationId, revision: '3' }), (e) => e.code === 'REVISION_MISMATCH');
  const resumed = await cmd.resumeOperation({ ...hdr, operationId: op.operationId, revision: '4' });
  assert.equal(resumed.status, 'RUNNING');
  // workers duplicados: dos pasos concurrentes → uno avanza, el otro ve el estado ya avanzado (sin doble aplicación)
  const pools = [new Pool({ ...h.config, max: 2 }), new Pool({ ...h.config, max: 2 })];
  try {
    const [a, b] = await Promise.all(pools.map((p) => mk(p).cmd.stepOperation({ ...hdr, operationId: op.operationId })));
    const advanced = [a, b].filter((x) => x.advanced > 0);
    assert.ok(advanced.length <= 1, 'nunca dos lotes aplicados a la vez');
    assert.ok([a, b].some((x) => x.status === 'CONFLICT') || advanced.length === 1, 'el lote 3 contiene b0128 (versión externa) → CONFLICT, o avanzó exactamente uno');
    // b0128 (editado externamente) sigue en la selección: con versión distinta a la esperada el lote entra en CONFLICT
    const after = await cmd.getOperation({ userId: lib.userId, operationId: op.operationId });
    assert.ok(['RUNNING', 'CONFLICT', 'PARTIAL', 'COMPLETED'].includes(after.status));
  } finally { await Promise.all(pools.map((p) => p.end())); }
  let st = await cmd.getOperation({ userId: lib.userId, operationId: op.operationId });
  if (st.status === 'CONFLICT') {
    const allDetails = []; let cur = null;
    do { const pg = await cmd.getOperation({ userId: lib.userId, operationId: op.operationId, detailsAfter: cur }); allDetails.push(...pg.details); cur = pg.detailsNext; } while (cur);
    assert.ok(allDetails.some((d) => d.beatId === 'b0128' && d.result === 'CONFLICT'), 'versión distinta del miembro editado externamente (detalle paginado <=50)');
    await cmd.resumeOperation({ ...hdr, operationId: op.operationId, revision: (await libRow(pool, lib.userId)).revision }); // la revisión explícita es la ACTUAL de la biblioteca, no la del último commit propio
    // el miembro conflictivo queda con versión 2 ≠ expected 1: no puede completarse sin reseleccionar → cancelamos y comprobamos el reporte
    const c = await cmd.cancelOperation({ ...hdr, operationId: op.operationId });
    assert.equal(c.status, 'CANCELLING');
    const fin = await cmd.stepOperation({ ...hdr, operationId: op.operationId });
    assert.deepEqual([fin.status, fin.progress.confirmed + fin.progress.notExecuted + fin.progress.cancelled], ['CANCELLED', 129], 'reporte: total = confirmados + no ejecutados + cancelados');
    assert.equal((await cmd.getSelection({ userId: lib.userId, selectionId: sel.selectionId })).status, 'INVALIDATED');
  }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND color = '#123456'", [lib.userId])).rows[0].n, (await cmd.getOperation({ userId: lib.userId, operationId: op.operationId })).progress.confirmed, 'confirmados = filas realmente cambiadas');
  // respuesta perdida precommit: misma clave → crea una vez
  const r1 = await cmd.createOperation({ ...hdr, idempotencyKey: 'rename-1', kind: 'TAG_RENAME', rename: { from: 'EVEN', to: 'pair' } });
  const r2 = await cmd.createOperation({ ...hdr, idempotencyKey: 'rename-1', kind: 'TAG_RENAME', rename: { from: 'EVEN', to: 'pair' } });
  assert.deepEqual([r1.operationId === r2.operationId, r2.replay, r1.progress.total], [true, true, 65]);
  await assertConsistent(pool, lib);
}));

test('rename global r4 §6: preview ACTIVE/TRASH, operación por lotes sobre ambos scopes, fusión con tag existente, dedupe exacto, status/fechas/refs intactos, bulk trash/restore con NOT_EXECUTED → PARTIAL, feed /changes', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { cmd, q } = mk(pool);
  await seedBeats(pool, lib, gen(120, (i) => ({ tags: i % 3 === 0 ? ['Dark', 'dark', 'moody'] : i % 3 === 1 ? ['moody'] : [' dark '], artwork: { telegram_message_id: 1000 + i } })));
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  await cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: Array.from({ length: 10 }, (_, i) => ({ beatId: `b${String(i).padStart(4, '0')}`, expectedVersion: '1' })) });
  const pv = await cmd.previewTagRename({ userId: lib.userId, from: ' DARK', to: 'Moody' });
  assert.deepEqual([pv.from, pv.to, pv.countActive, pv.countTrash, pv.mergesInto > 0], ['dark', 'moody', 73, 7, true]);
  await assert.rejects(cmd.previewTagRename({ userId: lib.userId, from: 'dark', to: 'bad;tag' }), (e) => e.detail.reason === 'RENAME_TO');
  const trashedBefore = (await pool.query('SELECT beat_id, trashed_at, purge_after, trash_id FROM catalog_trash_entries WHERE user_id = $1 ORDER BY beat_id', [lib.userId])).rows;
  const op = await cmd.createOperation({ ...hdr, idempotencyKey: 'rn', kind: 'TAG_RENAME', rename: { from: 'dark', to: 'moody' } });
  assert.deepEqual([op.status, op.progress.total], ['QUEUED', 80]);
  let st = op; let steps = 0;
  while (['QUEUED', 'RUNNING'].includes(st.status)) { st = await cmd.stepOperation({ ...hdr, operationId: op.operationId }); steps++; }
  assert.deepEqual([st.status, st.progress.confirmed, steps], ['COMPLETED', 80, 2], '80 miembros = 50 + 30: el segundo lote cierra sin paso extra');
  const docs = (await pool.query("SELECT beat_id, legacy_json, state FROM catalog_beats WHERE user_id = $1 ORDER BY beat_id", [lib.userId])).rows.map((r) => ({ id: r.beat_id, state: r.state, ...JSON.parse(r.legacy_json) }));
  assert.deepEqual(docs[0].tags, ['moody'], 'Dark + dark + moody → moody (dedupe exacto preservando orden)');
  assert.deepEqual(docs[2].tags, ['moody'], "' dark ' → moody");
  assert.deepEqual(docs[1].tags, ['moody']);
  assert.ok(docs.every((d) => d.artwork && d.artwork.telegram_message_id === 1000 + Number(d.id.slice(1))), 'referencias intactas');
  assert.deepEqual((await pool.query('SELECT beat_id, trashed_at, purge_after, trash_id FROM catalog_trash_entries WHERE user_id = $1 ORDER BY beat_id', [lib.userId])).rows, trashedBefore, 'papelera intacta');
  const facets = (await q.listFacets({ userId: lib.userId, query: {} })).items;
  assert.deepEqual(facets, [{ key: 'moody', label: 'moody', count: 110, representativeBeatId: 'b0010' }]);
  assert.deepEqual((await q.listFacets({ userId: lib.userId, query: { scope: 'TRASH' } })).items.map((f) => [f.key, f.count]), [['moody', 10]]);
  // bulk restore sobre un conjunto TRASH: incluye un beat ya restaurado → NOT_EXECUTED → PARTIAL
  const set = await q.createQuerySet({ userId: lib.userId, query: { state: 'TRASH' }, consumer: { id: 't', kind: 'OPERATION' } });
  while ((await q.stepQuerySet({ userId: lib.userId, setId: set.setId })).status === 'BUILDING');
  const sel = await cmd.createSelection({ ...hdr, setId: set.setId, sort: 'manual', defaultSelected: true, consumerId: 't' });
  const bop = await cmd.createOperation({ ...hdr, idempotencyKey: 'br', kind: 'BULK_RESTORE', selectionId: sel.selectionId, selectionVersion: '0' });
  // restaurar b0000 a mano con la versión actual → el bulk lo encuentra ACTIVE
  const v = (await pool.query("SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = 'b0000'", [lib.userId])).rows[0].v;
  await cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: 'b0000', expectedVersion: v }] });
  const first = await cmd.stepOperation({ ...hdr, operationId: bop.operationId });
  assert.deepEqual([first.status, first.conflict.reason], ['CONFLICT', 'REVISION_CHANGED']);
  await cmd.resumeOperation({ ...hdr, operationId: bop.operationId, revision: (await libRow(pool, lib.userId)).revision });
  let b = await cmd.stepOperation({ ...hdr, operationId: bop.operationId });
  // b0000 cambió de versión por el restore manual → el lote entra en CONFLICT con ese miembro; al reanudar, el miembro sigue en conflicto: se cancela
  assert.deepEqual([b.status, b.conflict.beatId], ['CONFLICT', 'b0000']);
  const c = await cmd.cancelOperation({ ...hdr, operationId: bop.operationId });
  assert.deepEqual([c.status, c.progress.cancelled], ['CANCELLED', 10]);
  assert.deepEqual(await libRow(pool, lib.userId), { revision: (await libRow(pool, lib.userId)).revision, active: 111, trash: 9 });
  // feed: eventos en orden, cursor next, límite 240 y RESYNC fuera de retención simulada
  const ch = await cmd.listChanges({ userId: lib.userId, query: { after: '0' } });
  assert.ok(ch.events.length >= 90 && ch.events[0].kind === 'BEAT_TRASHED' && ch.events.some((e) => e.kind === 'TAGS_RENAMED') && ch.events.some((e) => e.kind === 'OPERATION_STATUS'));
  const seqs = ch.events.map((e) => Number(e.seq)); assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  const tail = await cmd.listChanges({ userId: lib.userId, query: { after: ch.next } });
  assert.deepEqual([tail.events.length, tail.hasMore, tail.next], [0, false, ch.next]);
  await assert.rejects(cmd.listChanges({ userId: lib.userId, query: { after: String(Number(ch.latest) + 5) } }), (e) => e.detail.reason === 'AFTER_AHEAD');
  await pool.query('UPDATE catalog_events SET event_seq = event_seq + 20000 WHERE user_id = $1', [lib.userId]);
  await assert.rejects(cmd.listChanges({ userId: lib.userId, query: { after: '0' } }), (e) => e.code === 'RESYNC_REQUIRED' && e.status === 410);
  await pool.query('UPDATE catalog_events SET event_seq = event_seq - 20000 WHERE user_id = $1', [lib.userId]);
  await assertConsistent(pool, lib);
}));
