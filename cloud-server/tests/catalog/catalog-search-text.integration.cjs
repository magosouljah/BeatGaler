'use strict';
// T20-N / 0037 — search_text (un único LIKE) frente al predicado por campos, contra PostgreSQL real aislado.
//  1. Equivalencia exacta sobre un corpus aleatorio con semilla (límites de campo, %, _, \, mayúsculas, Unicode, emoji, separador):
//     listBeats con search_text poblado == listBeats con search_text = NULL (predicado antiguo), por q, en total y en la primera página.
//  2. Los escritores (PATCH, bulk tags, import/replace vía operations no aplica aquí) mantienen search_text == recomputo desde tags.
//  3. La guarda de 0037 invalida (NULL) un search_text que un escritor ajeno dejaría obsoleto; q lo sigue encontrando.
//  4. Backfill de 0037 sobre datos preexistentes == proyección calculada por el código.
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
const key = () => `st-${++keyN}`;

async function withDb(fn, { upTo = null } = {}) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max: 6 });
  try {
    await mig.applyMigrations(pool, upTo ? mig.listMigrations().filter((m) => m.version <= upTo) : undefined);
    await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [H]);
    return await fn(pool, h);
  } finally { await pool.end(); await h.cleanup(); }
}
const auth = (pool) => authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres' });
const mk = (pool) => ({ cmd: commands.createCatalogCommands({ pool, authority: auth(pool) }), q: queries.createCatalogQueries({ pool, authority: auth(pool), cursorKeys: KEYS }) });
async function nativeLibrary(pool) {
  const id = `su${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, generationId: ctx.generation_id, era: ctx.authority_era, epoch: ctx.authority_epoch };
}
const COLS = 'user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, color, color2, bpm_sort_class, bpm_sort, sort_order, manual_rank, has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display';
async function insertRaw(c, lib, beat, rank, { withText = false } = {}) {
  const p = codec.projectBeat(beat); const json = JSON.stringify(beat);
  await c.query(`INSERT INTO catalog_beats(${COLS}${withText ? ', search_text' : ''}) VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23${withText ? ',$24' : ''})`,
    [lib.userId, lib.generationId, beat.id, p.name, p.bpmText, p.keyText, p.rating, p.color, p.color2, p.bpmSortClass, p.bpmSort, p.sortOrder, String(rank * 1000),
      p.hasArtwork, json, crypto.createHash('sha256').update(json, 'utf8').digest('hex'), Buffer.byteLength(json, 'utf8'), p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay, ...(withText ? [p.searchText] : [])]);
  for (const t of p.tags) await c.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [lib.userId, lib.generationId, beat.id, t.position, t.label, t.normKey, t.searchKey]);
}
async function seedBeats(pool, lib, beats, opts) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let rank = 0; for (const b of beats) await insertRaw(c, lib, b, rank++, opts);
    await c.query(`UPDATE catalog_libraries SET active_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE') WHERE user_id = $1`, [lib.userId, lib.generationId]);
    if (!opts?.skipRebuild) await rebuildDerivedProjections(c, lib);
    await c.query('COMMIT');
    await c.query('ANALYZE catalog_beats, catalog_beat_tags');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// recomputo independiente en SQL desde las columnas almacenadas; cuenta filas con search_text distinto
const MISMATCH_SQL = `SELECT count(*)::int AS n FROM catalog_beats b WHERE b.user_id = $1 AND b.search_text IS DISTINCT FROM
  (b.name_search || chr(31) || b.key_search || chr(31) || b.bpm_display || coalesce((SELECT chr(31) || string_agg(t.search_key, chr(31) ORDER BY t.position) FROM catalog_beat_tags t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id), ''))`;
const mismatches = async (pool, lib) => (await pool.query(MISMATCH_SQL, [lib.userId])).rows[0].n;

const ALPHA = ['a', 'B', 'c', '%', '_', '\\', 'é', 'É', 'İ', 'ß', 'Ω', '😀', ' ', '-', '1', '2', 'x', 'm', 'i', "'"];

test('equivalencia exacta: listBeats con search_text == predicado por campos (corpus aleatorio, semilla fija, límites de campo y metacaracteres LIKE)', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { q } = mk(pool);
  const rnd = mulberry32(777001);
  const rstr = (max) => Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => ALPHA[Math.floor(rnd() * ALPHA.length)]).join('');
  const beats = Array.from({ length: 220 }, (_, i) => ({
    id: `s${String(i).padStart(4, '0')}`, name: rnd() < 0.05 ? '' : rstr(7), bpm: rnd() < 0.2 ? '' : rnd() < 0.5 ? String(60 + Math.floor(rnd() * 200)) : rstr(3),
    key: rnd() < 0.3 ? '' : ['C', 'cm', 'Ab', 'F#m', rstr(3)][Math.floor(rnd() * 5)], rating: Math.floor(rnd() * 6),
    tags: Array.from({ length: Math.floor(rnd() * 5) }, () => rstr(5)).filter(Boolean),
  }));
  await seedBeats(pool, lib, beats);
  assert.equal(await mismatches(pool, lib), 0, 'rebuildDerivedProjections proyecta search_text de todos los beats');
  const SEP = codec.SEARCH_TEXT_SEP;
  const fields = (b) => { const p = codec.projectBeat(b); return [p.nameSearch, p.keySearch, p.bpmDisplay, ...p.tags.map((t) => t.searchKey)]; };
  const qs = new Set(['%', '_', '\\', '%%', '\\%', '_a', 'a_', 'İ', 'i̇', 'ß', '😀', 'ω', 'é', 'É'.toLowerCase(), 'untitled', `a${SEP}b`, SEP, `${SEP}${SEP}`]);
  for (const a of ALPHA) { if (a.trim()) qs.add(a); for (const b2 of ALPHA) if ((a + b2).trim() === a + b2) qs.add(a + b2); }
  for (let i = 0; i < 160; i++) {
    const b = beats[Math.floor(rnd() * beats.length)]; const f = fields(b);
    const piece = f[Math.floor(rnd() * f.length)];
    if (piece.length) { const s = Math.floor(rnd() * piece.length); qs.add(piece.slice(s, s + 1 + Math.floor(rnd() * 4))); }
    // cruce de límites de campo: cola de un campo + cabeza del siguiente (nunca debe coincidir por sí solo con el separador fuera de q)
    for (let k = 0; k + 1 < f.length; k++) if (f[k].length && f[k + 1].length) qs.add(f[k].slice(-1) + f[k + 1].slice(0, 1));
    if (f[0].length && f[1].length) qs.add(f[0].slice(-2) + f[1].slice(0, 2));
  }
  const queryList = [...qs].filter((s) => s.trim() && Buffer.byteLength(s, 'utf8') <= 256);
  assert.ok(queryList.length > 350, `corpus de q suficiente (${queryList.length})`);
  const run = async (s) => { const r = await q.listBeats({ userId: lib.userId, query: { q: s, includeTotal: 'true', limit: '240' } }); return [r.totalMatched, r.items.map((x) => x.id)]; };
  const withText = []; for (const s of queryList) withText.push(await run(s));
  await pool.query('UPDATE catalog_beats SET search_text = NULL WHERE user_id = $1', [lib.userId]);
  const old = []; for (const s of queryList) old.push(await run(s));
  let nonEmpty = 0;
  queryList.forEach((s, i) => { assert.deepEqual(withText[i], old[i], `q=${JSON.stringify(s)}`); if (old[i][0] > 0) nonEmpty++; });
  assert.ok(nonEmpty > 100, `muchas q con coincidencias (${nonEmpty}/${queryList.length})`);
}));

test('escritores: PATCH (nombre, bpm, key, tags) y bulk add/remove mantienen search_text == recomputo; resultados de q correctos', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { cmd, q } = mk(pool);
  await seedBeats(pool, lib, Array.from({ length: 12 }, (_, i) => ({ id: `w${i}`, name: `Beat ${i}`, bpm: '120', key: 'Cm', rating: 1, tags: ['alfa', i % 2 ? 'odd' : 'even'] })));
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  assert.equal(await mismatches(pool, lib), 0);
  const ver = async (id) => (await pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, id])).rows[0].v;
  await cmd.patchBeat({ ...hdr, beatId: 'w3', idempotencyKey: key(), expectedVersion: await ver('w3'), patch: { name: 'ZEBRA Ünï', tags: ['gamma', 'lo-fi'] } });
  assert.equal(await mismatches(pool, lib), 0, 'PATCH con tags');
  await cmd.patchBeat({ ...hdr, beatId: 'w4', idempotencyKey: key(), expectedVersion: await ver('w4'), patch: { rating: 4, bpm: '99.5', key: 'F# minor' } });
  assert.equal(await mismatches(pool, lib), 0, 'PATCH sin tags (bpm/key)');
  const hit = async (s) => (await q.listBeats({ userId: lib.userId, query: { q: s, includeTotal: 'true' } })).items.map((x) => x.id).sort();
  assert.deepEqual(await hit('zebra'), ['w3']); assert.deepEqual(await hit('lo-fi'), ['w3']); assert.deepEqual(await hit('99.5'), ['w4']); assert.deepEqual(await hit('odd'), ['w1', 'w5', 'w7', 'w9', 'w11'].sort());
  assert.deepEqual(await hit('gamma'), ['w3']); assert.deepEqual(await hit('even'), ['w0', 'w10', 'w2', 'w4', 'w6', 'w8'].sort(), 'w4 conserva even; w3 ya no tiene odd');
  // bulk add
  const set = await q.createQuerySet({ userId: lib.userId, query: {}, consumer: { id: 'tab', kind: 'SELECTION' } });
  while ((await q.stepQuerySet({ userId: lib.userId, setId: set.setId, batch: 240 })).status === 'BUILDING');
  const sel = await cmd.createSelection({ ...hdr, setId: set.setId, sort: 'manual', defaultSelected: false, consumerId: 'tab' });
  await cmd.applySelectionOp({ ...hdr, selectionId: sel.selectionId, selectionVersion: '0', idempotencyKey: key(), op: { kind: 'INCLUDE_IDS', beatIds: ['w0', 'w1', 'w2'] } });
  const op = await cmd.createOperation({ ...hdr, idempotencyKey: key(), kind: 'BULK_PATCH', selectionId: sel.selectionId, selectionVersion: '1', patch: {}, tagsOp: { op: 'add', tags: ['nuevo-tag'] } });
  await cmd.stepOperation({ ...hdr, operationId: op.operationId });
  assert.equal(await mismatches(pool, lib), 0, 'bulk add');
  assert.deepEqual(await hit('nuevo-tag'), ['w0', 'w1', 'w2']);
  const set2 = await q.createQuerySet({ userId: lib.userId, query: {}, consumer: { id: 'tab2', kind: 'SELECTION' } });
  while ((await q.stepQuerySet({ userId: lib.userId, setId: set2.setId, batch: 240 })).status === 'BUILDING');
  const sel2 = await cmd.createSelection({ ...hdr, setId: set2.setId, sort: 'manual', defaultSelected: false, consumerId: 'tab2' });
  await cmd.applySelectionOp({ ...hdr, selectionId: sel2.selectionId, selectionVersion: '0', idempotencyKey: key(), op: { kind: 'INCLUDE_IDS', beatIds: ['w1'] } });
  const op2 = await cmd.createOperation({ ...hdr, idempotencyKey: key(), kind: 'BULK_PATCH', selectionId: sel2.selectionId, selectionVersion: '1', patch: {}, tagsOp: { op: 'remove', tags: ['nuevo-tag'] } });
  await cmd.stepOperation({ ...hdr, operationId: op2.operationId });
  assert.equal(await mismatches(pool, lib), 0, 'bulk remove');
  assert.deepEqual(await hit('nuevo-tag'), ['w0', 'w2']);
  // trash/restore no tocan search_text (los grupos y facetas sí cambian, la búsqueda sigue funcionando por estado)
  const t = await cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: 'w0', expectedVersion: await ver('w0') }] });
  assert.equal(await mismatches(pool, lib), 0, 'trash');
  assert.deepEqual(await hit('nuevo-tag'), ['w2']);
  await cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: 'w0', expectedVersion: t.items[0].version }] });
  assert.equal(await mismatches(pool, lib), 0, 'restore');
}));

test('guarda 0037: un escritor ajeno que cambia name_search/key_search/bpm_display sin search_text lo invalida (NULL) y q sigue acertando por el predicado por campos', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { q } = mk(pool);
  await seedBeats(pool, lib, [{ id: 'g0', name: 'Alpha', bpm: '100', key: 'Cm', rating: 1, tags: ['uno'] }, { id: 'g1', name: 'Beta', bpm: '110', key: 'Dm', rating: 1, tags: ['dos'] }]);
  assert.equal(await mismatches(pool, lib), 0);
  await pool.query("UPDATE catalog_beats SET name_display = 'Omega', name_search = 'omega' WHERE user_id = $1 AND beat_id = 'g0'", [lib.userId]);
  const t = (await pool.query("SELECT beat_id, search_text IS NULL AS isnull FROM catalog_beats WHERE user_id = $1 ORDER BY beat_id", [lib.userId])).rows;
  assert.deepEqual(t.map((r) => [r.beat_id, r.isnull]), [['g0', true], ['g1', false]], 'solo la fila cambiada se invalida');
  assert.deepEqual((await q.listBeats({ userId: lib.userId, query: { q: 'omega' } })).items.map((x) => x.id), ['g0']);
  assert.deepEqual((await q.listBeats({ userId: lib.userId, query: { q: 'alpha' } })).items.map((x) => x.id), [], 'el nombre antiguo ya no coincide');
  assert.deepEqual((await q.listBeats({ userId: lib.userId, query: { q: 'uno' } })).items.map((x) => x.id), ['g0'], 'tags por el predicado por campos');
}));

test('backfill de 0037 sobre datos preexistentes == proyección calculada por el código (mismatches 0)', () => withDb(async (pool) => {
  // Aplicamos hasta 0036, sembramos y luego aplicamos 0037: el UPDATE de la migración debe proyectar todas las filas.
  const lib = await nativeLibrary(pool);
  const rnd = mulberry32(777002);
  const rstr = (max) => Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => ALPHA[Math.floor(rnd() * ALPHA.length)]).join('');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // columnas sin search_text: la migración 0037 aún no se ha aplicado
    const beats = Array.from({ length: 60 }, (_, i) => ({ id: `k${i}`, name: rstr(6), bpm: rnd() < 0.5 ? '' : String(70 + i), key: rstr(2), rating: 1, tags: Array.from({ length: i % 4 }, () => rstr(4)).filter(Boolean) }));
    let rank = 0; for (const b of beats) await insertRaw(c, lib, b, rank++);
    await c.query('COMMIT');
  } finally { c.release(); }
  const col = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'catalog_beats' AND column_name = 'search_text'");
  assert.equal(col.rows.length, 0);
  const up = await mig.applyMigrations(pool);
  assert.deepEqual(up.applied, ['0037']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND search_text IS NULL', [lib.userId])).rows[0].n, 0, 'todas las filas proyectadas');
  assert.equal(await mismatches(pool, lib), 0, 'backfill == recomputo');
  const withTags = (await pool.query("SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND length(search_text) - length(replace(search_text, chr(31), '')) >= 3", [lib.userId])).rows[0].n;
  assert.ok(withTags > 10, 'hay filas con tags en el corpus');
}, { upTo: '0036' }));
