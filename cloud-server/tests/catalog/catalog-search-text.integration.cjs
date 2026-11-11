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
// 0039: oráculo de contadores de gramas (recomputo completo desde search_text) frente a catalog_search_gram_counts, todas las bibliotecas
const COUNTS_DIFF_SQL = `WITH exp AS (SELECT b.user_id, b.generation_id, b.state, g.gram, count(*)::bigint AS n FROM catalog_beats b
    CROSS JOIN LATERAL unnest(catalog_search_grams(b.search_text)) AS g(gram) WHERE b.search_text IS NOT NULL GROUP BY 1, 2, 3, 4)
  SELECT count(*)::int AS n FROM exp e FULL JOIN catalog_search_gram_counts c USING (user_id, generation_id, state, gram) WHERE e.n IS DISTINCT FROM c.beat_count`;
const countsDiff = async (pool) => (await pool.query(COUNTS_DIFF_SQL)).rows[0].n;
// search_text == recomputo Y contadores == recomputo (cada paso de cada escritor comprueba ambos)
const mismatches = async (pool, lib) => (await pool.query(MISMATCH_SQL, [lib.userId])).rows[0].n + await countsDiff(pool);

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
  assert.deepEqual(up.applied, ['0037', '0038', '0039']);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND search_text IS NULL', [lib.userId])).rows[0].n, 0, 'todas las filas proyectadas');
  assert.equal(await mismatches(pool, lib), 0, 'backfill == recomputo');
  const withTags = (await pool.query("SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND length(search_text) - length(replace(search_text, chr(31), '')) >= 3", [lib.userId])).rows[0].n;
  assert.ok(withTags > 10, 'hay filas con tags en el corpus');
}, { upTo: '0036' }));

// ---------- 0038: índices de subcadena (pg_trgm + 1/2-gramas por campo) ----------
test('0038: modo de búsqueda determinista por q y uso de índice (GRAMS/TRGM/SCAN) verificado con EXPLAIN', () => withDb(async (pool) => {
  const SEP = codec.SEARCH_TEXT_SEP;
  const modes = [['zq', 'GRAMS'], ['ñ', 'GRAMS'], ['😀', 'GRAMS'], ['%', 'GRAMS'], ['_', 'GRAMS'], ['\\', 'GRAMS'], ['😀😀', 'GRAMS'], ['abc', 'TRGM'], ['zqxjk', 'TRGM'],
    ['٣٢١', 'TRGM'], ['a b cde', 'TRGM'], ['---', 'SCAN'], ['a-b', 'SCAN'], ['ab cd', 'SCAN'], ['😀😀😀', 'SCAN'], ['%%%', 'SCAN'], [`a${SEP}b`, 'FIELDS'], [SEP, 'FIELDS']];
  for (const [q, m] of modes) assert.equal(queries.searchMode(q), m, JSON.stringify(q));
  const lib = await nativeLibrary(pool);
  const rnd = mulberry32(778001);
  const rstr = (max) => Array.from({ length: 1 + Math.floor(rnd() * max) }, () => ALPHA[Math.floor(rnd() * ALPHA.length)]).join('');
  await seedBeats(pool, lib, Array.from({ length: 400 }, (_, i) => ({ id: `x${String(i).padStart(4, '0')}`, name: rstr(8), bpm: String(80 + (i % 90)), key: 'Cm', rating: i % 6, tags: [rstr(5), rstr(4)] })));
  const c = await pool.connect();
  try {
    await c.query('SET enable_seqscan = off');
    for (const [q, m] of modes) {
      if (m === 'FIELDS') continue;
      const params = [lib.userId, lib.generationId, 'ACTIVE'];
      const where = queries.filterSql({ q, includeMode: 'any', includeTags: [], excludeTags: [] }, params, m);
      const plan = (await c.query(`EXPLAIN SELECT b.beat_id FROM catalog_beats b WHERE b.user_id = $1 AND b.generation_id = $2 AND b.state = $3${where}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
      const usesGrams = plan.includes('catalog_beats_search_grams_idx'); const usesTrgm = plan.includes('catalog_beats_search_trgm_idx');
      if (m === 'GRAMS') assert.ok(usesGrams && !usesTrgm, `${JSON.stringify(q)} GRAMS debe usar solo el GIN de gramas\n${plan}`);
      if (m === 'TRGM') assert.ok(usesTrgm && !usesGrams, `${JSON.stringify(q)} TRGM debe usar solo el GIN trigram\n${plan}`);
      if (m === 'SCAN') assert.ok(!usesTrgm && !usesGrams, `${JSON.stringify(q)} SCAN no debe usar ningún GIN\n${plan}`);
    }
  } finally { c.release(); }
}));

test('0038: aislamiento por tenant, filtros combinados, estado y COUNT == predicado por campos (q de todas las clases)', () => withDb(async (pool) => {
  const A = await nativeLibrary(pool); const B = await nativeLibrary(pool); const { cmd, q } = mk(pool);
  const rnd = mulberry32(778002);
  const NAMES = ['alpha mix', 'ñandú', 'zzq only', 'mi corazón', 'Éclair', 'a-b c', 'x_y%z', 'tres tristes', '---', 'ab cd ef'];
  const mkBeats = (p, lib) => Array.from({ length: 70 }, (_, i) => ({ id: `${p}${String(i).padStart(3, '0')}`, name: NAMES[Math.floor(rnd() * NAMES.length)] + (rnd() < 0.3 ? ` ${i}` : ''),
    bpm: String(90 + (i % 20)), key: ['Cm', 'F#m', ''][i % 3], rating: i % 6, tags: [['alfa', 'beta', 'gamma', 'ñu'][i % 4], ...(rnd() < 0.4 ? ['zqx'] : [])] }));
  const bBeats = mkBeats('b', B); bBeats[5].name = 'solo-b zzqq';
  await seedBeats(pool, A, mkBeats('a', A)); await seedBeats(pool, B, bBeats);
  const hdr = { userId: A.userId, era: A.era, epoch: A.epoch };
  const v = (await pool.query("SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = 'a003'", [A.userId])).rows[0].v;
  await cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: 'a003', expectedVersion: v }] });
  const QS = ['zq', 'zzq', 'zzqq', 'ñ', 'é', 'É'.toLowerCase(), '_', '%', '\\', 'mi', 'a', 'alp', 'alpha', 'zqx', 'tres', '---', 'a-b', 'ab cd', '%%%', 'x_y%', 'solo-b', 'ñu'];
  const FILTERS = [{}, { includeTag: 'alfa' }, { includeTag: ['alfa', 'zqx'], includeMode: 'all' }, { excludeTag: 'beta' }, { state: 'TRASH' }, { sort: 'name' }];
  const run = async (lib, s, f) => { const r = await q.listBeats({ userId: lib.userId, query: { q: s, includeTotal: 'true', limit: '240', ...f } }); return [r.totalMatched, r.items.map((x) => x.id)]; };
  const snap = async () => { const out = []; for (const lib of [A, B]) for (const s of QS) for (const f of FILTERS) out.push([lib, s, f, await run(lib, s, f)]); return out; };
  const withIdx = await snap();
  await pool.query('UPDATE catalog_beats SET search_text = NULL WHERE user_id = ANY($1)', [[A.userId, B.userId]]);
  const oracle = await snap();
  let nonEmpty = 0;
  withIdx.forEach(([lib, s, f, got], i) => {
    assert.deepEqual(got, oracle[i][3], `lib=${lib === A ? 'A' : 'B'} q=${JSON.stringify(s)} f=${JSON.stringify(f)}`);
    const own = lib === A ? 'a' : 'b'; for (const id of got[1]) assert.ok(id.startsWith(own), `aislamiento: ${id} en biblioteca ${own}`);
    if (got[0] > 0) nonEmpty++;
  });
  assert.ok(nonEmpty > 100, `suficientes q con coincidencias (${nonEmpty})`);
  const solo = (await run(A, 'solo-b', {}))[0]; assert.equal(solo, 0, 'un término exclusivo de B no aparece en A');
}));

// ---------- 0039: contadores exactos de gramas ----------
test('0039: contadores == recomputo tras una secuencia aleatoria de INSERT / UPDATE (search_text, state) / DELETE por sentencias de 1 y N filas (semilla fija)', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const lib2 = await nativeLibrary(pool);
  const rnd = mulberry32(779001);
  const rstr = (max) => Array.from({ length: Math.floor(rnd() * (max + 1)) }, () => ALPHA[Math.floor(rnd() * ALPHA.length)]).join('');
  const STATES = ['ACTIVE', 'TRASH', 'PURGING'];
  await seedBeats(pool, lib, Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, name: rstr(6), bpm: String(80 + i), key: rstr(2), rating: 1, tags: [rstr(4), rstr(3)].filter(Boolean) })));
  await seedBeats(pool, lib2, Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, name: rstr(6), bpm: '', key: '', rating: 1, tags: [rstr(5)].filter(Boolean) })));
  assert.equal(await countsDiff(pool), 0, 'tras sembrar');
  let ranged = 0; let fresh = 100;
  for (let step = 0; step < 80; step++) {
    const L = rnd() < 0.7 ? lib : lib2; const kind = Math.floor(rnd() * 6);
    const ids = (await pool.query('SELECT beat_id FROM catalog_beats WHERE user_id = $1 ORDER BY beat_id', [L.userId])).rows.map((r) => r.beat_id);
    const pick = (n) => Array.from({ length: n }, () => ids[Math.floor(rnd() * ids.length)]);
    if (kind === 0) await pool.query('UPDATE catalog_beats SET state = $3 WHERE user_id = $1 AND beat_id = ANY($2)', [L.userId, pick(1 + Math.floor(rnd() * 6)), STATES[Math.floor(rnd() * 3)]]);
    else if (kind === 1) await pool.query('UPDATE catalog_beats SET search_text = $3 WHERE user_id = $1 AND beat_id = ANY($2)', [L.userId, pick(1 + Math.floor(rnd() * 5)), [rstr(5), rstr(3), rstr(4)].join(codec.SEARCH_TEXT_SEP)]);
    else if (kind === 2) await pool.query('UPDATE catalog_beats SET search_text = NULL WHERE user_id = $1 AND beat_id = ANY($2)', [L.userId, pick(1 + Math.floor(rnd() * 3))]);
    else if (kind === 3) { const c = await pool.connect(); try { await c.query('BEGIN'); await insertRaw(c, L, { id: `n${fresh++}`, name: rstr(6), bpm: '1', key: rstr(2), rating: 1, tags: [rstr(3)].filter(Boolean) }, 9000 + fresh, { withText: rnd() < 0.5 }); await c.query('COMMIT'); } finally { c.release(); } }
    else if (kind === 4) { ranged++; await pool.query('UPDATE catalog_beats SET rating_display = rating_display WHERE user_id = $1', [L.userId]); } // UPDATE masivo sin cambio: no debe alterar contadores
    else if (ids.length > 10) { const victims = pick(1 + Math.floor(rnd() * 3)); await pool.query('DELETE FROM catalog_beats WHERE user_id = $1 AND beat_id = ANY($2)', [L.userId, victims]).catch((e) => { if (!/foreign key|violates/i.test(e.message)) throw e; }); }
    assert.equal(await countsDiff(pool), 0, `paso ${step} (tipo ${kind})`);
  }
  assert.ok(ranged > 3);
  const zero = (await pool.query('SELECT count(*)::int AS n FROM catalog_search_gram_counts WHERE beat_count <= 0')).rows[0].n;
  assert.equal(zero, 0, 'no hay filas en cero ni negativas');
}));

test('0039: planSearch elige GIN (poco frecuente) o recorrido (frecuente) sin cambiar resultados; COUNT de q de 1-2 caracteres = contador exacto; filas sin proyectar usan el predicado por campos', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { q } = mk(pool);
  const rnd = mulberry32(779002);
  const rstr = (max) => Array.from({ length: 1 + Math.floor(rnd() * max) }, () => ALPHA[Math.floor(rnd() * ALPHA.length)]).join('');
  const beats = Array.from({ length: 150 }, (_, i) => ({ id: `p${String(i).padStart(3, '0')}`, name: i % 7 === 0 ? 'qz' + rstr(4) : rstr(7), bpm: String(60 + (i % 50)), key: 'Cm', rating: i % 6, tags: [rstr(4)] }));
  await seedBeats(pool, lib, beats);
  const c = await pool.connect();
  const planOf = async (s, state = 'ACTIVE') => { try { await c.query('BEGIN READ ONLY'); return await queries.planSearch(c, lib.userId, lib.generationId, state, s); } finally { await c.query('ROLLBACK'); } };
  try {
    assert.equal((await planOf('qz')).mode, 'GRAMS'); assert.equal((await planOf('qz')).n, beats.filter((b) => b.name.startsWith('qz')).length);
    assert.equal((await planOf('zzzz')).mode, 'TRGM'); assert.equal((await planOf('---')).mode, 'SCAN');
    assert.equal((await planOf('éé')).mode, 'GRAMS');
    // contador manipulado por encima del umbral: el camino cambia, el resultado NO
    const run = async (s, extra = {}) => { const r = await q.listBeats({ userId: lib.userId, query: { q: s, includeTotal: 'true', limit: '240', ...extra } }); return [r.totalMatched, r.items.map((x) => x.id)]; };
    const before = await run('qz'); const keyArgs = [lib.userId, lib.generationId];
    await pool.query("UPDATE catalog_search_gram_counts SET beat_count = beat_count + $3 WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE' AND gram = 'qz'", [...keyArgs, queries.GRAM_GIN_MAX]);
    assert.equal((await planOf('qz')).mode, 'SCAN');
    const viaScan = (await q.listBeats({ userId: lib.userId, query: { q: 'qz', limit: '240' } })).items.map((x) => x.id);
    assert.deepEqual(viaScan, before[1], 'camino SCAN == camino GIN');
    await pool.query("UPDATE catalog_search_gram_counts SET beat_count = beat_count - $3 WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE' AND gram = 'qz'", [...keyArgs, queries.GRAM_GIN_MAX]);
    // COUNT: contador exacto == COUNT real por el predicado antiguo
    for (const s of ['qz', 'a', 'é', '%', '_', 'm', 'mi', 'x_']) {
      const withCounter = (await run(s))[0];
      await pool.query('UPDATE catalog_beats SET search_text = NULL WHERE user_id = $1', [lib.userId]);
      const oracle = (await run(s))[0]; // todas sin proyectar -> predicado por campos
      assert.equal(withCounter, oracle, `COUNT q=${JSON.stringify(s)}`);
      for (const b of beats) { const p = codec.projectBeat(b); await pool.query('UPDATE catalog_beats SET search_text = $3 WHERE user_id = $1 AND beat_id = $2', [lib.userId, b.id, p.searchText]); }
      assert.equal(await countsDiff(pool), 0);
    }
    // una sola fila sin proyectar: se usa el predicado por campos (n no utilizable) y el resultado sigue siendo exacto
    await pool.query("UPDATE catalog_beats SET search_text = NULL WHERE user_id = $1 AND beat_id = 'p001'", [lib.userId]);
    assert.deepEqual(await planOf('qz'), { mode: 'FIELDS', n: null });
    const mixed = await run('qz');
    assert.deepEqual(mixed, before, 'resultado y total exactos con filas sin proyectar (predicado por campos)');
  } finally { c.release(); }
}));
