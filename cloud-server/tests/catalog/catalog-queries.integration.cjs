'use strict';
// T06 — Consultas paginadas contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T06`). Cada test crea su DB efímera.
// Cubre C12-Q01/Q02/B01/B02/L01, F01/F02/N01/U01/U02, facetas (r4 §6), conjuntos (r4 §3) y EXPLAIN ANALYZE/BUFFERS sobre 100k.
// Bibliotecas NATIVAS (provisionadas por T05) con beats escritos por SQL de prueba usando la misma proyección JS (legacy-codec.projectBeat).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const queries = require('../../catalog/queries.js');
const codec = require('../../catalog/legacy-codec.js');
const { rebuildDerivedProjections } = require('../../catalog/staging.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const FIX = path.join(__dirname, '..', 'fixtures', 'catalog');
const fixture = (id) => JSON.parse(fs.readFileSync(path.join(FIX, `${id}.json`), 'utf8'));
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const KEYS = [{ kid: 'k1', secret: crypto.randomBytes(32) }];
const H = crypto.createHash('sha256').update('x').digest('hex');
const EXPLAIN_DIR = path.join(process.cwd(), 'tmp', 'catalog-check', 'T06-explain');

async function withDb(fn, { max = 6 } = {}) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max });
  try { await mig.applyMigrations(pool); await activate(pool); return await fn(pool, h); } finally { await pool.end(); await h.cleanup(); }
}
async function activate(pool) {
  await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
  await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory)
    VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [H]);
}
let seq = 0;
const auth = (pool) => authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres' });
const mk = (pool) => queries.createCatalogQueries({ pool, authority: auth(pool), cursorKeys: KEYS });
// Biblioteca nativa provisionada por la autoridad T05 (§3.4); devuelve {userId, generationId}.
async function nativeLibrary(pool) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, generationId: ctx.generation_id };
}
// Inserta beats (ACTIVE salvo state) con la proyección JS exacta y rank = ordinal; actualiza contadores y facetas.
async function seedBeats(pool, lib, beats, { state = 'ACTIVE', rankStart = 0 } = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let rank = rankStart;
    for (const beat of beats) {
      const p = codec.projectBeat(beat);
      const json = JSON.stringify(beat);
      await c.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, color, color2, bpm_sort_class, bpm_sort, sort_order, manual_rank,
          has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [lib.userId, lib.generationId, beat.id, beat.__state || state, p.name, p.bpmText, p.keyText, p.rating, p.color, p.color2, p.bpmSortClass, p.bpmSort, p.sortOrder, String(rank++ * 1000),
        p.hasArtwork, json, crypto.createHash('sha256').update(json, 'utf8').digest('hex'), Buffer.byteLength(json, 'utf8'), p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay]);
      for (const t of p.tags) await c.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [lib.userId, lib.generationId, beat.id, t.position, t.label, t.normKey, t.searchKey]);
    }
    await c.query(`UPDATE catalog_libraries SET active_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE'),
      trash_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'TRASH') WHERE user_id = $1`, [lib.userId, lib.generationId]);
    await rebuildDerivedProjections(c, lib);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const bumpRevision = (pool, userId) => pool.query('UPDATE catalog_libraries SET revision = revision + 1 WHERE user_id = $1', [userId]);
const ids = (page) => page.items.map((i) => i.id);
const digest = async (pool) => (await pool.query(`SELECT md5(coalesce(string_agg(t, '|' ORDER BY t), '')) AS d FROM (
  SELECT 'B' || user_id || beat_id || state || version::text || manual_rank::text AS t FROM catalog_beats
  UNION ALL SELECT 'L' || user_id || revision::text || active_count::text FROM catalog_libraries
  UNION ALL SELECT 'S' || user_id || set_id || status || member_count::text FROM catalog_query_sets) x`)).rows[0].d;

// ---------- oráculo JS (webLibrary.ts display + librarySelectors.ts filtro/orden; C12 §3.1/§3.4) ----------
const text = (v, d = '') => (typeof v === 'string' ? v : d);
function display(b) {
  return { id: b.id, name: text(b.name, 'Untitled').trim() || 'Untitled', bpm: text(b.bpm), key: text(b.key), tags: Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === 'string') : [],
    rating: Math.max(0, Math.min(255, Math.trunc(Number(b.rating) || 0))) };
}
function oracle(beats, { q = '', include = [], exclude = [], mode = 'any', sort = 'manual' } = {}) {
  const inc = new Set(include); const exc = new Set(exclude);
  const order = new Map(beats.map((b, i) => [b.id, i]));
  const qq = q.trim().toLowerCase();
  const rows = beats.map(display).filter((b) => (!qq || b.name.toLowerCase().includes(qq) || b.tags.some((t) => t.toLowerCase().includes(qq)) || b.key.toLowerCase().includes(qq) || String(b.bpm).includes(qq))
    && (inc.size === 0 || (mode === 'any' ? [...inc].some((t) => b.tags.includes(t)) : [...inc].every((t) => b.tags.includes(t))))
    && (exc.size === 0 || ![...exc].some((t) => b.tags.includes(t))));
  const cls = (bpm) => { const n = Number(bpm); return Number.isNaN(n) ? 3 : n === -Infinity ? 0 : n === Infinity ? 2 : 1; };
  const val = (bpm) => { const n = Number(bpm); return cls(bpm) === 1 ? (Object.is(n, -0) ? 0 : n) : 0; };
  const byManual = (a, b) => order.get(a.id) - order.get(b.id);
  if (sort === 'rating') rows.sort((a, b) => (b.rating - a.rating) || byManual(a, b));
  else if (sort === 'bpm') rows.sort((a, b) => (cls(a.bpm) - cls(b.bpm)) || (val(a.bpm) - val(b.bpm)) || byManual(a, b));
  else rows.sort(byManual);
  return rows.map((r) => r.id);
}
const gen = (n, f = (i) => ({})) => Array.from({ length: n }, (_, i) => ({ id: `w${String(i).padStart(6, '0')}`, name: `Beat ${i % 7}`, bpm: String(80 + (i % 5)), key: 'Cm', rating: i % 3, tags: [`t${i % 4}`], ...f(i) }));

test('ICU A1 real: colación icu/und no determinista con collversion; U01 orden lingüístico; U02 NFC/NFD empatan y desempata manual_rank', () => withDb(async (pool) => {
  const coll = (await pool.query("SELECT collprovider, collisdeterministic, collversion, pg_collation_actual_version(oid) AS actual FROM pg_collation WHERE collname = 'catalog_name_icu_und_v1'")).rows[0];
  assert.ok(coll, 'colación 0028 presente');
  assert.equal(coll.collprovider, 'i', 'proveedor ICU real, no libc');
  assert.equal(coll.collisdeterministic, false);
  assert.ok(coll.collversion && coll.collversion === coll.actual, `collversion registrado y vigente: ${coll.collversion}`);
  const u01 = fixture('c12-u01-names');
  const lib = await nativeLibrary(pool);
  const beats = u01.beats.filter((b, i, arr) => arr.findIndex((x) => x.id === b.id) === i); // el duplicado b0 se rechaza en import (ID_DUPLICATE)
  await seedBeats(pool, lib, beats);
  const q = mk(pool);
  const page = await q.listBeats({ userId: lib.userId, query: { sort: 'name', limit: '240' } });
  const order = ids(page);
  fs.mkdirSync(EXPLAIN_DIR, { recursive: true });
  fs.writeFileSync(path.join(EXPLAIN_DIR, 'u01-name-order.json'), JSON.stringify({ collation: coll, order: order.map((id) => [id, display(beats.find((b) => b.id === id)).name]) }, null, 2));
  const pos = (id) => order.indexOf(id);
  const name = (id) => display(beats.find((b) => b.id === id)).name;
  // Invariantes lingüísticos de ICU und (CLDR root): los sin nombre ('Untitled') se ordenan como texto; dígitos antes de letras; puntuación no ignorada
  assert.ok(pos('x1') < pos('b2') && pos('x2') < pos('b2'), 'dígitos antes de letras');
  assert.ok(pos('x1') < pos('x2'), '"10" < "2" (numeric=false)');
  assert.ok(pos('b12') < pos('b11'), '"a10" < "a2" (numeric=false)');
  assert.ok(pos('b2') < pos('b3'), 'minúscula antes que mayúscula en el mismo primario (caseFirst=false → lower first)');
  assert.ok(pos('b2') < pos('b4') && pos('b4') < pos('b1') && pos('b1') < pos('b10'), 'a < á < ä antes de a-2: acentos al nivel secundario, no al final del alfabeto');
  assert.ok(pos('b1') < pos('b0'), 'ä no va después de z (no es sueco)');
  assert.ok(pos('b7') < pos('b6') && pos('b6') < pos('b18'), 'n < ñ < same');
  assert.equal(pos('b19'), pos('b18') + 1, 'nombres idénticos: desempate por manual_rank');
  assert.ok(pos('x7') < pos('x6') || pos('x6') < pos('x7'), 'ß y ss ordenados (terciario distinto), sin igualdad binaria');
  const untitled = ['n-absent', 'n-null', 'n-empty'].map(pos);
  assert.deepEqual(untitled, [untitled[0], untitled[0] + 1, untitled[0] + 2], 'Untitled ×3 consecutivos por manual_rank');
  assert.equal(name('n-empty'), 'Untitled');
  assert.ok(pos('b8') < pos('x1') && pos('b9') < pos('x1') && pos('x5') < pos('x1'), 'símbolos/emoji antes que dígitos y letras (CLDR root: símbolos < dígitos < letras)');
  // U02: NFC y NFD de "á" son canónicamente iguales bajo ICU: el orden lo decide manual_rank en ambos sentidos
  for (const key of ['orderA', 'orderB']) {
    const l2 = await nativeLibrary(pool);
    const u02 = fixture('c12-u02-nfc-nfd')[key];
    await seedBeats(pool, l2, u02.beats);
    const p = await q.listBeats({ userId: l2.userId, query: { sort: 'name' } });
    assert.deepEqual(ids(p), u02.beats.map((b) => b.id), `${key}: empate canónico → orden manual`);
    const eq = (await pool.query("SELECT ($1::text COLLATE catalog_name_icu_und_v1) = ($2::text COLLATE catalog_name_icu_und_v1) AS eq", [u02.beats[0].name, u02.beats[1].name])).rows[0].eq;
    assert.equal(eq, true, 'NFC = NFD bajo la colación');
  }
}));

test('Q01: 241 beats, páginas de 240 por cada sort con empates; vecinos exactos adelante/atrás, resumeCursor, edge=last con N=0/1/240/241, fronteras parciales', () => withDb(async (pool) => {
  const beats = gen(241, (i) => ({ name: i % 10 === 0 ? 'Same Name' : `Beat ${(i * 7) % 13}`, bpm: ['120', '90', 'oops', '', '1e2'][i % 5], rating: i % 3 }));
  const lib = await nativeLibrary(pool);
  await seedBeats(pool, lib, beats);
  const q = mk(pool);
  for (const sort of ['manual', 'rating', 'name', 'bpm']) {
    const all = ids(await q.listBeats({ userId: lib.userId, query: { sort, limit: '240' } }));
    const p1 = await q.listBeats({ userId: lib.userId, query: { sort, limit: '240' } });
    assert.deepEqual([p1.items.length, p1.startOrdinal, p1.totalMatched, p1.totalLibrary, p1.previousCursor], [240, 0, 241, 241, null], sort);
    const p2 = await q.listBeats({ userId: lib.userId, query: { sort, limit: '240', cursor: p1.nextCursor } });
    assert.deepEqual([p2.items.length, p2.startOrdinal, p2.nextCursor], [1, 240, null], `${sort}: último bloque parcial`);
    const full = [...ids(p1), ...ids(p2)];
    assert.equal(new Set(full).size, 241, `${sort}: sin duplicados ni huecos`);
    assert.deepEqual(full.slice(0, 240), all);
    if (sort !== 'name') assert.deepEqual(full, oracle(beats, { sort }), `${sort}: orden global = oráculo JS`);
    // atrás desde el bloque parcial → bloque 0 exacto; resume reabre cada bloque con su ordinal
    const back = await q.listBeats({ userId: lib.userId, query: { sort, limit: '240', cursor: p2.previousCursor } });
    assert.deepEqual([ids(back), back.startOrdinal, back.previousCursor], [ids(p1), 0, null]);
    const r2 = await q.listBeats({ userId: lib.userId, query: { sort, limit: '240', cursor: p2.resumeCursor } });
    assert.deepEqual([ids(r2), r2.startOrdinal], [ids(p2), 240]);
    // bloques de 100: 0..99, 100..199, 200..240; atrás desde 200 → 100..199; desde 100 → 0..99; resume de 100 → 100..199
    const a = await q.listBeats({ userId: lib.userId, query: { sort } });
    const b = await q.listBeats({ userId: lib.userId, query: { sort, cursor: a.nextCursor } });
    const c = await q.listBeats({ userId: lib.userId, query: { sort, cursor: b.nextCursor } });
    assert.deepEqual([...ids(a), ...ids(b), ...ids(c)], full, `${sort}: bloques de 100 = orden global`);
    assert.deepEqual([a.startOrdinal, b.startOrdinal, c.startOrdinal, c.items.length, c.nextCursor], [0, 100, 200, 41, null]);
    const bBack = await q.listBeats({ userId: lib.userId, query: { sort, cursor: c.previousCursor } });
    assert.deepEqual([ids(bBack), bBack.startOrdinal], [ids(b), 100]);
    const aBack = await q.listBeats({ userId: lib.userId, query: { sort, cursor: bBack.previousCursor } });
    assert.deepEqual([ids(aBack), aBack.startOrdinal, aBack.previousCursor], [ids(a), 0, null]);
    assert.ok(aBack.nextCursor, 'tras volver atrás sigue habiendo siguiente');
    assert.deepEqual(ids(await q.listBeats({ userId: lib.userId, query: { sort, cursor: aBack.nextCursor } })), ids(b));
    // edge=last: último bloque por índice inverso, mismo count, ordinal exacto
    const last = await q.listBeats({ userId: lib.userId, query: { sort, limit: '240', edge: 'last' } });
    assert.deepEqual([ids(last), last.startOrdinal, last.totalMatched, last.nextCursor], [full.slice(1), 1, 241, null], `${sort}: Ctrl+End = últimas 240 filas (ordinales 1..240), count del mismo snapshot`);
    const last100 = await q.listBeats({ userId: lib.userId, query: { sort, edge: 'last' } });
    assert.deepEqual([ids(last100), last100.startOrdinal], [full.slice(141), 141]);
    const prevFromLast = await q.listBeats({ userId: lib.userId, query: { sort, cursor: last100.previousCursor } });
    assert.deepEqual([ids(prevFromLast), prevFromLast.startOrdinal], [full.slice(41, 141), 41]);
  }
  // Empates visibles: rating empatado se desempata por manual_rank y el keyset no salta vecinos en la frontera de un empate
  const tie = await q.listBeats({ userId: lib.userId, query: { sort: 'rating', limit: '7' } });
  const tieNext = await q.listBeats({ userId: lib.userId, query: { sort: 'rating', limit: '7', cursor: tie.nextCursor } });
  assert.deepEqual([...ids(tie), ...ids(tieNext)], oracle(beats, { sort: 'rating' }).slice(0, 14));
  // N = 0 / 1 / 240
  for (const n of [0, 1, 240]) {
    const l = await nativeLibrary(pool);
    await seedBeats(pool, l, gen(n));
    const first = await q.listBeats({ userId: l.userId, query: { limit: '240' } });
    assert.deepEqual([first.items.length, first.totalMatched, first.nextCursor, first.previousCursor, first.startOrdinal], [n, n, null, null, 0], `N=${n}`);
    const last = await q.listBeats({ userId: l.userId, query: { limit: '240', edge: 'last' } });
    assert.deepEqual([ids(last), last.startOrdinal, last.previousCursor, last.nextCursor], [ids(first), 0, null, null], `N=${n} edge=last`);
    assert.ok(first.resumeCursor && last.resumeCursor, 'resumeCursor siempre presente (modo first si vacío)');
    assert.deepEqual(ids(await q.listBeats({ userId: l.userId, query: { limit: '240', cursor: first.resumeCursor } })), ids(first));
  }
}));

test('Q02: tenant A/B, token manipulado, filtros/limit/sort distintos y revisión concurrente → 400/409 sin fuga; una lectura no altera datos', () => withDb(async (pool) => {
  const a = await nativeLibrary(pool); const b = await nativeLibrary(pool);
  await seedBeats(pool, a, gen(5)); await seedBeats(pool, b, gen(3, (i) => ({ id: `other${i}`, tags: ['secret'] })));
  const q = mk(pool);
  const before = await digest(pool);
  const pa = await q.listBeats({ userId: a.userId, query: { limit: '2', includeTotal: 'true' } });
  const invalid = (uid, query, reason) => assert.rejects(q.listBeats({ userId: uid, query }), (e) => e.code === 'CURSOR_INVALID' && e.status === 400 && e.detail.reason === reason && !JSON.stringify(e.detail).includes('other'), reason);
  await invalid(b.userId, { limit: '2', cursor: pa.nextCursor }, 'TENANT');
  await invalid(a.userId, { limit: '3', cursor: pa.nextCursor }, 'REQUEST_MISMATCH');
  await invalid(a.userId, { limit: '2', sort: 'name', cursor: pa.nextCursor }, 'REQUEST_MISMATCH');
  await invalid(a.userId, { limit: '2', includeTag: 'x', cursor: pa.nextCursor }, 'REQUEST_MISMATCH');
  const [p, s] = pa.nextCursor.split('.');
  await invalid(a.userId, { limit: '2', cursor: `${p}.${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}` }, 'SIGNATURE');
  const forged = Buffer.from(Buffer.from(p, 'base64url').toString().replace(`"tenantId":"${a.userId}"`, `"tenantId":"${b.userId}"`)).toString('base64url');
  await assert.rejects(q.listBeats({ userId: b.userId, query: { limit: '2', cursor: `${forged}.${s}` } }), (e) => e.code === 'CURSOR_INVALID');
  // otro firmante (clave distinta) → firma inválida, aunque el payload sea coherente
  const other = queries.createCatalogQueries({ pool, authority: auth(pool), cursorKeys: [{ kid: 'k1', secret: crypto.randomBytes(32) }] });
  await assert.rejects(q.listBeats({ userId: a.userId, query: { limit: '2', cursor: other.signer.sign(q.signer.verify(pa.nextCursor).payload) } }), (e) => e.code === 'CURSOR_INVALID' && e.detail.reason === 'SIGNATURE');
  // revisión concurrente: el cursor propio queda stale (409) y la nueva lectura trae la revisión actual
  await bumpRevision(pool, a.userId);
  await assert.rejects(q.listBeats({ userId: a.userId, query: { limit: '2', cursor: pa.nextCursor } }), (e) => e.code === 'CURSOR_STALE' && e.status === 409 && e.detail.current_revision === '2');
  const fresh = await q.listBeats({ userId: a.userId, query: { limit: '2' } });
  assert.equal(fresh.revision, '2');
  // detalle/archivos de un beat ajeno → 404 sin distinguir existencia
  await assert.rejects(q.getBeat({ userId: a.userId, beatId: 'other0' }), (e) => e.code === 'NOT_FOUND' && e.status === 404);
  await assert.rejects(q.listBeatFiles({ userId: a.userId, beatId: 'other0' }), (e) => e.code === 'NOT_FOUND');
  const own = await q.getBeat({ userId: b.userId, beatId: 'other0' });
  assert.deepEqual([own.id, own.tags, own.version, own.etag], ['other0', ['secret'], '1', 'W/"6-1"']);
  await pool.query('UPDATE catalog_libraries SET revision = revision - 1 WHERE user_id = $1', [a.userId]); // deshacer el bump de prueba
  assert.equal(await digest(pool), before, 'las lecturas no escribieron nada (digest igual al inicial tras deshacer el bump)');
}));

test('F01/F02/N01: paridad SQL ↔ oráculo JS (search-js-v1) para búsqueda, tags exactos ANY/ALL/exclusión y orden BPM A2', () => withDb(async (pool) => {
  const q = mk(pool);
  const f01 = fixture('c12-f01-tags'); const l1 = await nativeLibrary(pool); await seedBeats(pool, l1, f01.index.beats);
  const tagCases = [...f01.queries, { include: ['Dark'], mode: 'ANY' }, { include: ['trap'], mode: 'ANY' }, { include: [' Trap'], mode: 'ANY' }, { include: ['Trap', 'Dark'], mode: 'ANY', exclude: ['Trap'] }];
  for (const c of tagCases) {
    const query = { sort: 'manual', includeMode: (c.mode || 'ANY').toLowerCase() };
    if (c.include?.length) query.includeTag = c.include; if (c.exclude?.length) query.excludeTag = c.exclude;
    const page = await q.listBeats({ userId: l1.userId, query });
    assert.deepEqual(ids(page), oracle(f01.index.beats, { include: c.include || [], exclude: c.exclude || [], mode: query.includeMode }), JSON.stringify(c));
  }
  const f02 = fixture('c12-f02-search'); const l2 = await nativeLibrary(pool); await seedBeats(pool, l2, f02.index.beats);
  const searchCases = [...f02.queries, 'q-', 'Q-Á', 'ος', 'Σ', 'n2', 'a', 'i̇', '%%', '\\\\', ' ', '', 'zzz-none', '9', 'A'];
  for (const s of searchCases) {
    const page = await q.listBeats({ userId: l2.userId, query: { q: s, sort: 'manual', limit: '240', includeTotal: 'true' } });
    const expected = oracle(f02.index.beats, { q: s });
    assert.deepEqual(ids(page), expected.slice(0, 240), `q=${JSON.stringify(s)}`);
    assert.equal(page.totalMatched, expected.length, `totalMatched q=${JSON.stringify(s)}`);
    if (expected.length > 240) {
      const p2 = await q.listBeats({ userId: l2.userId, query: { q: s, sort: 'manual', limit: '240', cursor: page.nextCursor } });
      assert.deepEqual(ids(p2), expected.slice(240), 'coincidencia fuera de la primera página');
    }
  }
  // q coincide por key y por bpm (sin lowercase en bpm) y por tag
  const l3 = await nativeLibrary(pool);
  const b3 = [{ id: 'k1', name: 'x', key: 'F#m', bpm: '0X80', tags: ['Loud'] }, { id: 'k2', name: 'y', key: 'am', bpm: '128', tags: ['quiet'] }, { id: 'k3', name: 'LOUD', key: '', bpm: '', tags: [] }];
  await seedBeats(pool, l3, b3);
  for (const s of ['f#', 'AM', '0x80', '0X80', 'loud', 'quiet', '12', 'ui']) assert.deepEqual(ids(await q.listBeats({ userId: l3.userId, query: { q: s, sort: 'manual' } })), oracle(b3, { q: s }), `q=${s}`);
  // N01: orden BPM por clase/valor binary64 y manual_rank
  const n01 = fixture('c12-n01-bpm'); const l4 = await nativeLibrary(pool); await seedBeats(pool, l4, n01.beats);
  const bpmOrder = ids(await q.listBeats({ userId: l4.userId, query: { sort: 'bpm' } }));
  assert.deepEqual(bpmOrder, oracle(n01.beats, { sort: 'bpm' }));
  assert.deepEqual(bpmOrder.slice(0, 1), ['p10'], '-Infinity primero (clase 0)');
  assert.deepEqual(bpmOrder.slice(-3), ['p9', 'p7', 'p8'], '+Infinity (clase 2) y luego NaN/oops (clase 3) por manual_rank');
  const page = await q.listBeats({ userId: l4.userId, query: { sort: 'bpm', limit: '4' } });
  const p2 = await q.listBeats({ userId: l4.userId, query: { sort: 'bpm', limit: '4', cursor: page.nextCursor } });
  assert.deepEqual([...ids(page), ...ids(p2)], bpmOrder.slice(0, 8), 'keyset BPM con float8 roundtrip exacto (5e-324, 1.79e308)');
  const dto = (await q.listBeats({ userId: l4.userId, query: { sort: 'manual' } })).items;
  assert.deepEqual(dto.map((i) => i.bpm), n01.beats.map((b) => display(b).bpm), 'bpm numérico JSON se muestra vacío; texto se conserva');
}));

test('facetas r4 §6: frecuencia desc, representante por primer manual_rank, nombre A1 y clave binaria; activos por identidad; keyset', () => withDb(async (pool) => {
  const q = mk(pool);
  const f01 = fixture('c12-f01-tags'); const lib = await nativeLibrary(pool); await seedBeats(pool, lib, f01.index.beats);
  const f = await q.listFacets({ userId: lib.userId, query: {} });
  assert.deepEqual(f.items, [{ key: 'trap', label: 'Trap', count: 3, representativeBeatId: 'red' }, { key: 'dark', label: 'Dark', count: 2, representativeBeatId: 'blue' }]);
  assert.deepEqual([f.totalFacets, f.startOrdinal, f.nextCursor], [2, 0, null]);
  const act = await q.activeFacets({ userId: lib.userId, keys: ['dark', 'nope', 'trap'] });
  assert.deepEqual([act.items.map((i) => i.key).sort(), act.missing], [['dark', 'trap'], ['nope']]);
  assert.deepEqual((await q.listFacets({ userId: lib.userId, query: { q: 'a' } })).items.map((i) => i.key), ['trap', 'dark']);
  assert.deepEqual((await q.listFacets({ userId: lib.userId, query: { q: 'ar' } })).items.map((i) => i.key), ['dark']);
  assert.deepEqual((await q.listFacets({ userId: lib.userId, query: { q: 'tr' } })).items.map((i) => i.key), ['trap']);
  assert.deepEqual((await q.listFacets({ userId: lib.userId, query: { scope: 'TRASH' } })).items, []);
  // keyset con empates de frecuencia: 30 tags con count 1, nombre ICU y clave binaria
  const l2 = await nativeLibrary(pool);
  const tags = ['zeta', 'Alpha', 'alpha', 'ábaco', 'beta', '10', '2', 'Ñu', 'nu', '😀', ...Array.from({ length: 20 }, (_, i) => `tag${i}`)];
  await seedBeats(pool, l2, tags.map((t, i) => ({ id: `f${i}`, name: `n${i}`, tags: [t] })));
  const all = (await q.listFacets({ userId: l2.userId, query: {} })).items;
  assert.equal(all.length, tags.length - 1, 'Alpha y alpha se agrupan (trim+lower) con count 2');
  assert.deepEqual(all[0], { key: 'alpha', label: 'Alpha', count: 2, representativeBeatId: 'f1' });
  let got = []; let cursor; let pages = 0;
  do { const p = await q.listFacets({ userId: l2.userId, query: { limit: '7', ...(cursor ? { cursor } : {}) } }); got.push(...p.items.map((i) => i.key)); cursor = p.nextCursor; pages++; } while (cursor);
  assert.deepEqual(got, all.map((i) => i.key), 'paginación de facetas = orden global');
  assert.equal(pages, Math.ceil(all.length / 7));
  await assert.rejects(q.listFacets({ userId: lib.userId, query: { cursor: (await q.listFacets({ userId: l2.userId, query: { limit: '7' } })).nextCursor, limit: '7' } }), (e) => e.code === 'CURSOR_INVALID' && e.detail.reason === 'TENANT');
}));

test('B01/B02 legacy: offsets 0/1/239/240/241 sobre N=241, fuera de rango → último bloque, N=0 y N=1, parámetros inválidos y bloque+resumeCursor', () => withDb(async (pool) => {
  const q = mk(pool);
  const beats = gen(241, (i) => ({ rating: (i * 31) % 7 }));
  const lib = await nativeLibrary(pool); await seedBeats(pool, lib, beats);
  const global = oracle(beats, { sort: 'rating' });
  for (const [offset, start, len, resolution] of [[0, 0, 240, 'exact'], [1, 1, 240, 'exact'], [239, 239, 2, 'exact'], [240, 240, 1, 'exact'], [241, 240, 1, 'last'], [10000, 240, 1, 'last'], [10001, 240, 1, 'last'], [1000000000, 240, 1, 'last']]) {
    const r = await q.resolveLegacyNavigation({ userId: lib.userId, query: { offset: String(offset), sort: 'rating' } });
    assert.deepEqual([r.resolution, r.resolvedOffset, r.requestedOffset, r.startOrdinal, r.anchorOrdinal, r.items.length, r.totalLibrary], [resolution, start, offset, start, start, len, 241], `offset ${offset}`);
    assert.deepEqual(ids(r), global.slice(start, start + len), `offset ${offset}: bloque exacto del orden global`);
    const reopened = await q.listBeats({ userId: lib.userId, query: { sort: 'rating', limit: '240', cursor: r.resumeCursor } });
    assert.deepEqual([ids(reopened), reopened.startOrdinal], [ids(r), start], `offset ${offset}: resumeCursor reabre el mismo bloque por GET /beats`);
    if (start > 0) { const prev = await q.listBeats({ userId: lib.userId, query: { sort: 'rating', limit: '240', cursor: r.previousCursor } }); assert.equal(prev.startOrdinal, Math.max(0, start - 240)); }
    if (r.nextCursor) { const nx = await q.listBeats({ userId: lib.userId, query: { sort: 'rating', limit: '240', cursor: r.nextCursor } }); assert.deepEqual(ids(nx), global.slice(start + len, start + len + 240)); }
  }
  for (const n of [0, 1]) {
    const l = await nativeLibrary(pool); await seedBeats(pool, l, gen(n));
    for (const offset of ['0', '1', '1000000000']) {
      const r = await q.resolveLegacyNavigation({ userId: l.userId, query: { offset } });
      assert.deepEqual([r.items.length, r.resolution, r.resolvedOffset, r.nextCursor, r.previousCursor], [n, n === 0 ? 'empty' : offset === '0' ? 'exact' : 'last', 0, null, null], `N=${n} offset=${offset}`);
    }
  }
  const bad = (query, code) => assert.rejects(q.resolveLegacyNavigation({ userId: lib.userId, query }), (e) => e.code === code && e.status === 400, JSON.stringify(query));
  for (const o of ['-1', '1.5', '0xF0', '1e9', 'nope', '', '9007199254740992']) await bad({ offset: o }, 'LEGACY_OFFSET_INVALID');
  await bad({ offset: ['1', '2'] }, 'INPUT_INVALID'); await bad({ offset: '0', cursor: 'x' }, 'INPUT_INVALID'); await bad({ offset: '0', includeTag: 'a' }, 'INPUT_INVALID');
}));

test('L01: default 100, máximo 240, 241 → 400 sin clamp; página > 2 MiB → 413 sin truncar; q 64 KiB +1 → 400', () => withDb(async (pool) => {
  const q = mk(pool);
  const lib = await nativeLibrary(pool);
  await seedBeats(pool, lib, gen(241, (i) => ({ name: i < 120 ? 'x'.repeat(20000) : `n${i}` })));
  assert.equal((await q.listBeats({ userId: lib.userId, query: { sort: 'manual', edge: 'last' } })).items.length, 100);
  await assert.rejects(q.listBeats({ userId: lib.userId, query: { limit: '241' } }), (e) => e.code === 'INPUT_INVALID' && e.detail.reason === 'LIMIT');
  await assert.rejects(q.listBeats({ userId: lib.userId, query: { sort: 'manual', limit: '240' } }), (e) => e.code === 'CATALOG_PAGE_TOO_LARGE' && e.status === 413 && e.detail.bytes > 2 * 1024 * 1024);
  const small = await q.listBeats({ userId: lib.userId, query: { sort: 'manual', limit: '100' } });
  assert.equal(small.items[0].name.length, 20000, 'nombres largos íntegros, sin truncar');
  await assert.rejects(q.listBeats({ userId: lib.userId, query: { q: 'é'.repeat(32 * 1024 + 1) } }), (e) => e.code === 'INPUT_INVALID' && e.detail.reason === 'QUERY_TOO_LARGE');
  const ok = await q.listBeats({ userId: lib.userId, query: { q: 'é'.repeat(32 * 1024), includeTotal: 'true' } });
  assert.deepEqual([ok.items, ok.totalMatched], [[], 0], 'q de exactamente 64 KiB UTF-8 es válido');
}));

test('conjuntos r4 §3: create BUILDING → pasos ≤240 en orden manual → READY con slots densos; STALE si cambia la revisión; reuso, BUSY, cancel y release', () => withDb(async (pool) => {
  const q = mk(pool);
  const beats = gen(500, (i) => ({ tags: [i % 2 ? 'odd' : 'even'] }));
  const lib = await nativeLibrary(pool); await seedBeats(pool, lib, beats);
  const created = await q.createQuerySet({ userId: lib.userId, query: { includeTag: 'odd' }, consumer: { id: 'tab-1', kind: 'SHUFFLE' } });
  assert.deepEqual([created.status, created.created, created.memberCount, created.baseRevision], ['BUILDING', true, 0, '1']);
  const reused = await q.createQuerySet({ userId: lib.userId, query: { includeTag: ['odd'] }, consumer: { id: 'tab-2', kind: 'SELECTION' } });
  assert.deepEqual([reused.setId, reused.reused], [created.setId, true]);
  await assert.rejects(q.createQuerySet({ userId: lib.userId, query: { includeTag: 'even' }, consumer: { id: 'tab-1', kind: 'SHUFFLE' } }), (e) => e.code === 'QUERY_SET_BUILDING_BUSY' && e.detail.set_id === created.setId);
  const steps = [];
  for (let i = 0; i < 5; i++) { const s = await q.stepQuerySet({ userId: lib.userId, setId: created.setId, batch: 100 }); steps.push([s.status, s.memberCount, s.advanced]); if (s.status !== 'BUILDING') break; }
  assert.deepEqual(steps, [['BUILDING', 100, 100], ['BUILDING', 200, 100], ['READY', 250, 50]]);
  const members = (await pool.query('SELECT slot::int AS slot, beat_id FROM catalog_query_members WHERE user_id = $1 AND set_id = $2 ORDER BY slot', [lib.userId, created.setId])).rows;
  assert.deepEqual(members.map((m) => m.slot), Array.from({ length: 250 }, (_, i) => i), 'slots densos 0..m-1');
  assert.deepEqual(members.map((m) => m.beat_id), oracle(beats, { include: ['odd'] }), 'membresía = predicado global en orden manual');
  const got = await q.getQuerySet({ userId: lib.userId, setId: created.setId });
  assert.deepEqual([got.status, got.activeLeases, got.stale], ['READY', 2, false]);
  assert.deepEqual((await q.stepQuerySet({ userId: lib.userId, setId: created.setId })).advanced, 0, 'un paso sobre READY no escribe');
  // revisión nueva a mitad de construcción → STALE, nunca READY parcial
  await bumpRevision(pool, lib.userId);
  assert.equal((await q.getQuerySet({ userId: lib.userId, setId: created.setId })).stale, true);
  const s2 = await q.createQuerySet({ userId: lib.userId, query: { includeTag: 'even' }, consumer: { id: 'tab-1', kind: 'SHUFFLE' } });
  assert.deepEqual([s2.status, s2.baseRevision], ['BUILDING', '2']);
  await q.stepQuerySet({ userId: lib.userId, setId: s2.setId, batch: 240 });
  await bumpRevision(pool, lib.userId);
  const stale = await q.stepQuerySet({ userId: lib.userId, setId: s2.setId, batch: 240 });
  assert.deepEqual([stale.status, stale.memberCount], ['STALE', 240]);
  await assert.rejects(q.cancelQuerySet({ userId: lib.userId, setId: s2.setId }), (e) => e.code === 'QUERY_SET_TRANSITION_INVALID');
  const rel = await q.releaseQuerySet({ userId: lib.userId, setId: s2.setId });
  assert.deepEqual([rel.status, (await q.getQuerySet({ userId: lib.userId, setId: s2.setId })).activeLeases], ['RELEASED', 0]);
  // cancel de un BUILDING; READY publicado solo si la revisión no cambió entre el último lote y el lock
  const s3 = await q.createQuerySet({ userId: lib.userId, query: {}, consumer: { id: 'op', kind: 'OPERATION' } });
  assert.equal((await q.cancelQuerySet({ userId: lib.userId, setId: s3.setId })).status, 'CANCELLED');
  await assert.rejects(q.getQuerySet({ userId: lib.userId, setId: 'qs-nope' }), (e) => e.code === 'NOT_FOUND');
  const other = await nativeLibrary(pool);
  await assert.rejects(q.getQuerySet({ userId: other.userId, setId: created.setId }), (e) => e.code === 'NOT_FOUND', 'conjunto ajeno = inexistente');
  await assert.rejects(q.createQuerySet({ userId: lib.userId, query: { q: 'x'.repeat(9000) }, consumer: { id: 'c', kind: 'BUILD' } }), (e) => e.code === 'QUERY_SET_PREDICATE_TOO_LARGE' && e.status === 413);
  await assert.rejects(q.createQuerySet({ userId: lib.userId, query: {}, consumer: { id: 'c', kind: 'NOPE' } }), (e) => e.code === 'INPUT_INVALID');
}));

test('100k sintéticos: EXPLAIN ANALYZE/BUFFERS de primera página, página profunda, edge=last, COUNT filtrado y resolver legacy 10.000; sin Sort global; >10.000 en rango → 409', () => withDb(async (pool) => {
  const q = mk(pool);
  const lib = await nativeLibrary(pool);
  const N = 100000;
  const t0 = Date.now();
  await pool.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, manual_rank, legacy_json, legacy_sha256, legacy_export_bytes, name, name_display, name_search, key_display, key_search,
      bpm_display, bpm_sort_class, bpm_sort, rating, rating_display)
    SELECT $1, $2, 'g' || i, 'ACTIVE', i::numeric * 1000, j, encode(sha256(convert_to(j, 'UTF8')), 'hex'), octet_length(j), 'Name ' || (i % 997), 'Name ' || (i % 997), 'name ' || (i % 997), 'Cm', 'cm',
      (60 + (i % 240))::text, 1, 60 + (i % 240), (i % 6) * 50, (i % 6) * 50
    FROM generate_series(0, ${N - 1}) i, LATERAL (SELECT '{"id":"g' || i || '"}' AS j) x`, [lib.userId, lib.generationId]);
  // ANALYZE antes de los tags: sin estadísticas, el plan cacheado de la comprobación FK por fila hace seq scan sobre 100k filas (observado en LAB).
  await pool.query('ANALYZE catalog_beats');
  await pool.query(`INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) SELECT $1, $2, 'g' || i, 0, 'tag' || (i % 50), 'tag' || (i % 50), 'tag' || (i % 50) FROM generate_series(0, ${N - 1}) i`, [lib.userId, lib.generationId]);
  await pool.query('UPDATE catalog_libraries SET active_count = $2 WHERE user_id = $1', [lib.userId, N]);
  await pool.query('ANALYZE catalog_beats; ANALYZE catalog_beat_tags');
  const seedMs = Date.now() - t0;
  fs.mkdirSync(EXPLAIN_DIR, { recursive: true });
  const explain = async (label, sql, params) => {
    const r = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const plan = r.rows[0]['QUERY PLAN'][0];
    fs.writeFileSync(path.join(EXPLAIN_DIR, `${label}.json`), JSON.stringify({ label, sql, params, plan }, null, 2));
    const text = JSON.stringify(plan);
    return { plan, text, ms: plan['Execution Time'], rows: plan.Plan['Actual Rows'] };
  };
  const report = { seedMs, N, explains: {} };
  // Consultas exactamente como las construye queries.js (misma tupla, misma comparación de filas, LIMIT+1)
  const base = `b.user_id = $1 AND b.generation_id = $2 AND b.state = 'ACTIVE'`;
  const cols = 'b.beat_id, b.version, b.name_display, b.rating_display, b.manual_rank';
  const sel = `SELECT ${cols} FROM catalog_beats b`;
  for (const sort of ['manual', 'rating', 'name', 'bpm']) {
    const tuple = queries.TUPLES[sort].join(', ');
    const first = await explain(`first-${sort}`, `${sel} WHERE ${base} ORDER BY ${tuple} LIMIT 241`, [lib.userId, lib.generationId]);
    assert.ok(first.text.includes(`catalog_beats_order_${sort}_idx`), `${sort}: primera página por el índice de orden`);
    assert.ok(!/"Node Type":"Sort"/.test(first.text), `${sort}: sin Sort global`);
    assert.equal(first.rows, 241);
    // página profunda: frontera real en el ordinal 50.000 obtenida por una lectura keyset previa (cursor), no por OFFSET
    const p1 = await q.listBeats({ userId: lib.userId, query: { sort, limit: '240' } });
    const deepPage = await q.listBeats({ userId: lib.userId, query: { sort, limit: '240', cursor: p1.nextCursor } });
    assert.deepEqual([deepPage.startOrdinal, deepPage.items.length], [240, 240]);
    const boundaryRow = (await pool.query(`SELECT ${cols}, ${queries.TUPLES[sort].map((c, i) => `(${c})::text AS k${i}`).join(', ')} FROM (SELECT * FROM catalog_beats b WHERE ${base} ORDER BY ${tuple} OFFSET 50000 LIMIT 1) b`, [lib.userId, lib.generationId])).rows[0];
    const casts = { manual: ['numeric', 'text'], rating: ['int', 'numeric', 'text'], name: ['text', 'numeric', 'text'], bpm: ['int', 'float8', 'numeric', 'text'] }[sort];
    const tupleVals = casts.map((_, i) => boundaryRow[`k${i}`]);
    const refs = casts.map((c, i) => `$${3 + i}::${c}${c === 'text' && i === casts.length - 1 ? ' COLLATE "C"' : c === 'text' ? ` COLLATE ${queries.NAME_COLLATION}` : ''}`);
    const deep = await explain(`deep-${sort}`, `${sel} WHERE ${base} AND ROW(${tuple}) > ROW(${refs.join(', ')}) ORDER BY ${tuple} LIMIT 241`, [lib.userId, lib.generationId, ...tupleVals]);
    assert.ok(deep.text.includes(`catalog_beats_order_${sort}_idx`) && !/"Node Type":"Sort"/.test(deep.text), `${sort}: página profunda por índice sin Sort`);
    assert.equal(deep.rows, 241);
    assert.ok(deep.ms < 1000, `${sort}: página profunda ${deep.ms} ms < statement_timeout`);
    const last = await explain(`last-${sort}`, `${sel} WHERE ${base} ORDER BY ${queries.TUPLES[sort].map((c) => `${c} DESC`).join(', ')} LIMIT 240`, [lib.userId, lib.generationId]);
    assert.ok(last.text.includes(`catalog_beats_order_${sort}_idx`) && /Backward/.test(last.text) && !/"Node Type":"Sort"/.test(last.text), `${sort}: edge=last por índice inverso`);
    report.explains[sort] = { first: first.ms, deep: deep.ms, last: last.ms };
  }
  const cnt = await explain('count-filtered', `SELECT count(*) FROM catalog_beats b WHERE ${base} AND (b.name_search COLLATE "C" LIKE $3 ESCAPE '\\' OR b.key_search COLLATE "C" LIKE $3 ESCAPE '\\' OR b.bpm_display COLLATE "C" LIKE $3 ESCAPE '\\'
    OR EXISTS (SELECT 1 FROM catalog_beat_tags t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id AND t.search_key COLLATE "C" LIKE $3 ESCAPE '\\'))`, [lib.userId, lib.generationId, '%name 99%']);
  const legacy = await explain('legacy-offset-10000', `SELECT k.beat_id FROM catalog_beats k WHERE k.user_id = $1 AND k.generation_id = $2 AND k.state = 'ACTIVE' ORDER BY ${queries.TUPLES.rating.join(', ').replace(/\bb\./g, 'k.')} OFFSET 10000 LIMIT 241`, [lib.userId, lib.generationId]);
  assert.ok(legacy.text.includes('catalog_beats_order_rating_idx') && !/"Node Type":"Sort"/.test(legacy.text), 'legacy 10.000: índice de orden, sin Sort');
  report.explains.countFiltered = cnt.ms; report.explains.legacy10000 = legacy.ms;
  // Resultados reales a través del módulo (API completa) y tiempos
  const t1 = Date.now(); const firstPage = await q.listBeats({ userId: lib.userId, query: { sort: 'rating', limit: '240', includeTotal: 'true' } }); report.apiFirstMs = Date.now() - t1;
  assert.deepEqual([firstPage.items.length, firstPage.totalMatched], [240, N]);
  const t2 = Date.now(); const lastPage = await q.listBeats({ userId: lib.userId, query: { sort: 'name', limit: '240', edge: 'last' } }); report.apiLastMs = Date.now() - t2;
  assert.deepEqual([lastPage.items.length, lastPage.startOrdinal], [240, N - 240]);
  const t3 = Date.now(); const filtered = await q.listBeats({ userId: lib.userId, query: { q: 'name 99', includeTag: 'tag7', includeTotal: 'true', sort: 'bpm' } }); report.apiFilteredMs = Date.now() - t3;
  assert.ok(filtered.totalMatched > 0 && filtered.items.length <= 100);
  const lg = await q.resolveLegacyNavigation({ userId: lib.userId, query: { offset: '10000', sort: 'rating' } });
  assert.deepEqual([lg.resolution, lg.startOrdinal, lg.items.length], ['exact', 10000, 240]);
  await assert.rejects(q.resolveLegacyNavigation({ userId: lib.userId, query: { offset: '10001', sort: 'rating' } }), (e) => e.code === 'LEGACY_OFFSET_UNRESOLVABLE' && e.status === 409);
  const far = await q.resolveLegacyNavigation({ userId: lib.userId, query: { offset: String(N + 5), sort: 'rating' } });
  assert.deepEqual([far.resolution, far.startOrdinal, far.items.length], ['last', 99840, 160]);
  fs.writeFileSync(path.join(EXPLAIN_DIR, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`# T06 EXPLAIN 100k: ${JSON.stringify(report)}`);
}), { timeout: 600000 });

test('0 transporte: ningún módulo de Telegram/Direct cargado por las consultas', () => {
  const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
  assert.ok(!loaded.some((k) => /direct-transport-control|master-storage|telegram-retry|library-index-publication/.test(k)));
});
