'use strict';
// T06 — Consultas: parseo C12 §4.1, hash de filtros, SQL generado y contratos de cursor/errores con pool falso. Sin red ni DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const queries = require('../../catalog/queries.js');
const authority = require('../../catalog/authority.js');

const KEYS = [{ kid: 'k1', secret: crypto.randomBytes(32) }];
const LIB = { user_id: 'u1', vault_id: 'v1', authority: 'POSTGRES', migration_state: 'IDLE', authority_era: 'era-1', authority_epoch: '1', revision: '5', active_generation_id: 'native-g',
  active_count: '3', trash_count: '0', purging_count: '0', pending_count: '0', restore_hold: true, cleanup_enabled: false };
const ROW = (i, extra = {}) => ({ id: `b${i}`, version: '1', state: 'ACTIVE', name: `Beat ${i}`, bpm: '120', key: 'Cm', rating: 5, color: null, color2: null, has_artwork: false, manual_rank: String(i),
  tags: ['Trap'], files: [{ slot: 'MASTER', fileId: `f${i}`, role: 'MASTER', revision: '1' }], k0: '250', k1: String(i), k2: `b${i}`, ...extra });

function fakePool({ lib = LIB, rows = [], count = '3', onQuery = null } = {}) {
  const statements = [];
  const client = {
    async query(sql, params) {
      const text = String(sql); statements.push({ sql: text, params: params || [] });
      const custom = onQuery && onQuery(text, params);
      if (custom) return custom;
      if (/FROM control_plane_flush_quarantine/.test(text)) return { rows: [] };
      if (/FROM catalog_libraries l WHERE/.test(text)) return { rows: lib ? [lib] : [] };
      if (/FROM catalog_native_activation/.test(text)) return { rows: [{ environment_id: 'lab', run_id: 'r', transport_bot_ids: '["Bot20"]', direct_token_exposure: 'FRESH_BOTS', activated_at: new Date() }] };
      if (/SELECT count\(\*\)::text AS n FROM catalog_beats/.test(text)) return { rows: [{ n: count }] };
      if (/FROM catalog_beats b WHERE/.test(text)) return { rows: typeof rows === 'function' ? rows(text, params) : rows };
      return { rows: [] };
    },
    release() { client.released = (client.released || 0) + 1; },
  };
  return { statements, client, connect: async () => client, query: client.query };
}
function make(pool, opts = {}) {
  const auth = authority.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' });
  return queries.createCatalogQueries({ pool, authority: auth, cursorKeys: KEYS, ...opts });
}

test('parseListRequest: defaults C12 §4.1, enums/limit estrictos, escalares repetidos, cursor+edge, q canónico y conjuntos de tags por bytes', () => {
  const d = queries.parseListRequest({});
  assert.deepEqual([d.state, d.sort, d.includeMode, d.limit, d.includeTotal, d.q, d.includeTags, d.excludeTags, d.cursor, d.edge], ['ACTIVE', 'rating', 'any', 100, false, '', [], [], null, null]);
  const bad = (q, reason) => assert.throws(() => queries.parseListRequest(q), (e) => e.code === 'INPUT_INVALID' && e.status === 400 && e.detail.reason === reason, JSON.stringify(q));
  bad({ state: 'PURGED' }, 'ENUM'); bad({ sort: 'id' }, 'ENUM'); bad({ includeMode: 'ANY' }, 'ENUM'); bad({ includeTotal: '1' }, 'ENUM'); bad({ edge: 'first' }, 'ENUM');
  for (const l of ['0', '241', '1e2', '100.0', '-1', ' 100', '0100']) bad({ limit: l }, 'LIMIT');
  assert.equal(queries.parseListRequest({ limit: '240' }).limit, 240); assert.equal(queries.parseListRequest({ limit: '1' }).limit, 1);
  bad({ q: ['a', 'b'] }, 'REPEATED_SCALAR'); bad({ sort: ['rating', 'name'] }, 'REPEATED_SCALAR');
  bad({ cursor: 'x', edge: 'last' }, 'CURSOR_AND_EDGE'); bad({ bgPage: '2' }, 'LEGACY_PARAM_ON_CATALOG_LIST');
  bad({ q: 'x'.repeat(64 * 1024 + 1) }, 'QUERY_TOO_LARGE');
  const r = queries.parseListRequest({ q: '  TrAp ', includeTag: ['b', 'a', 'b', '😀', 'z'], excludeTag: 'Dark' });
  assert.equal(r.q, 'trap');
  assert.deepEqual(r.includeTags, ['a', 'b', 'z', '😀'], 'conjunto ordenado por bytes UTF-8 (astral al final), sin duplicados');
  assert.deepEqual(r.excludeTags, ['Dark']);
  // filterHash: independiente del orden de tags y de los parámetros de paginación; sensible a texto exacto
  const h1 = queries.parseListRequest({ q: 'a', includeTag: ['x', 'y'], limit: '10', sort: 'name' }).filterHash;
  const h2 = queries.parseListRequest({ q: ' A ', includeTag: ['y', 'x'], limit: '240', sort: 'bpm', includeTotal: 'true' }).filterHash;
  assert.equal(h1, h2);
  assert.notEqual(h1, queries.parseListRequest({ q: 'a', includeTag: ['x', 'Y'] }).filterHash, 'Y ≠ y: tags exactos');
  assert.notEqual(h1, queries.parseListRequest({ q: 'a', includeTag: ['x', 'y'], includeMode: 'all' }).filterHash);
  assert.notEqual(h1, queries.parseListRequest({ q: 'a', includeTag: ['x', 'y'], state: 'TRASH' }).filterHash);
  assert.equal(queries.likePattern('50%_\\x'), '%50\\%\\_\\\\x%');
});

test('listBeats: transacción REPEATABLE READ READ ONLY con statement_timeout, sin legacy_json, LIMIT+1, orden por tupla y cursores next/resume', async () => {
  const pool = fakePool({ rows: [ROW(1), ROW(2), ROW(3)] });
  const q = make(pool);
  const page = await q.listBeats({ userId: 'u1', query: { limit: '2', sort: 'rating' } });
  const sqls = pool.statements.map((s) => s.sql);
  assert.ok(sqls.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));
  assert.ok(sqls.some((s) => /^SET LOCAL statement_timeout = 1000$/.test(s)));
  const main = pool.statements.find((s) => /FROM catalog_beats b WHERE/.test(s.sql));
  assert.ok(!/legacy_json|raw_index|wrapper_json|original_json/.test(main.sql), 'la lista no selecciona raw ni manifests');
  assert.match(main.sql, /ORDER BY \(255 - b\.rating_display\), b\.manual_rank, b\.beat_id COLLATE "C" LIMIT 3$/);
  assert.deepEqual(main.params, ['u1', 'native-g', 'ACTIVE']);
  assert.equal(pool.client.released, 1);
  assert.equal(page.items.length, 2); assert.deepEqual(page.items.map((i) => i.id), ['b1', 'b2']);
  assert.deepEqual(Object.keys(page.items[0]).sort(), ['artwork', 'bpm', 'color', 'color2', 'fileCount', 'hasArtwork', 'hasProject', 'hasStems', 'hasWav', 'id', 'key', 'name', 'playback', 'rating', 'state', 'tags', 'version']);
  assert.deepEqual(page.items[0].playback, { fileId: 'f1', revision: '1' });
  assert.deepEqual([page.startOrdinal, page.totalLibrary, page.totalMatched, page.previousCursor, page.revision, page.epoch, page.sortProfile], [0, 3, 3, null, '5', '1', 'catalog-order-v1']);
  assert.ok(page.nextCursor && page.resumeCursor);
  const next = q.signer.verify(page.nextCursor).payload;
  assert.deepEqual([next.direction, next.boundary, next.startOrdinal, next.totalMatched, next.tenantId, next.revision, next.limit, next.sort], ['forward', { tuple: ['250', '2', 'b2'], inclusive: false }, 2, 3, 'u1', '5', 2, 'rating']);
  const resume = q.signer.verify(page.resumeCursor).payload;
  assert.deepEqual([resume.direction, resume.boundary, resume.startOrdinal], ['forward', { tuple: ['250', '1', 'b1'], inclusive: true }, 0]);

  // Siguiente página: comparación de filas con la tupla exacta, misma dirección ASC
  pool.statements.length = 0;
  const p2 = await q.listBeats({ userId: 'u1', query: { limit: '2', sort: 'rating', cursor: page.nextCursor } });
  const m2 = pool.statements.find((s) => /FROM catalog_beats b WHERE/.test(s.sql));
  assert.match(m2.sql, /ROW\(\(255 - b\.rating_display\), b\.manual_rank, b\.beat_id COLLATE "C"\) > ROW\(\$4::int, \$5::numeric, \$6::text COLLATE "C"\)/);
  assert.deepEqual(m2.params.slice(3), ['250', '2', 'b2']);
  assert.equal(p2.startOrdinal, 2);
  const prev = q.signer.verify(p2.previousCursor).payload;
  assert.deepEqual([prev.direction, prev.boundary, prev.startOrdinal], ['backward', { tuple: ['250', '1', 'b1'], inclusive: false }, 0], 'ordinal = limit → bloque anterior exacto (ordinal 0)');
  const p4 = await q.listBeats({ userId: 'u1', query: { limit: '2', sort: 'rating', cursor: q.signer.sign({ ...next, startOrdinal: 1 }) } });
  assert.deepEqual(q.signer.verify(p4.previousCursor).payload.direction, 'first', 'ordinal entre 1 y limit-1 → token first');
  // Reapertura por resumeCursor: boundary inclusiva (>=)
  pool.statements.length = 0;
  await q.listBeats({ userId: 'u1', query: { limit: '2', sort: 'rating', cursor: page.resumeCursor } });
  assert.match(pool.statements.find((s) => /FROM catalog_beats b WHERE/.test(s.sql)).sql, /\) >= ROW\(/);
});

test('cursor ajeno/incongruente → 400 CURSOR_INVALID; propio con revisión/época/generación vieja → 409 CURSOR_STALE; edge=last lee en orden inverso', async () => {
  const pool = fakePool({ rows: [ROW(3), ROW(2), ROW(1)] });
  const q = make(pool);
  const first = await q.listBeats({ userId: 'u1', query: { limit: '2' } });
  const invalid = (query, reason, uid = 'u1') => assert.rejects(q.listBeats({ userId: uid, query }), (e) => e.code === 'CURSOR_INVALID' && e.status === 400 && e.detail.reason === reason, reason);
  await invalid({ limit: '2', cursor: first.nextCursor }, 'TENANT', 'u2');
  await invalid({ limit: '3', cursor: first.nextCursor }, 'REQUEST_MISMATCH');
  await invalid({ limit: '2', sort: 'name', cursor: first.nextCursor }, 'REQUEST_MISMATCH');
  await invalid({ limit: '2', q: 'x', cursor: first.nextCursor }, 'REQUEST_MISMATCH');
  await invalid({ limit: '2', cursor: `${first.nextCursor}x` }, 'FORMAT');
  for (const lib of [{ ...LIB, revision: '6' }, { ...LIB, authority_epoch: '2' }, { ...LIB, active_generation_id: 'native-h' }, { ...LIB, authority_era: 'era-2' }]) {
    const q2 = make(fakePool({ lib, rows: [] }));
    const sameKeyToken = first.nextCursor; // misma clave HMAC (KEYS)
    await assert.rejects(q2.listBeats({ userId: 'u1', query: { limit: '2', cursor: sameKeyToken } }), (e) => e.code === 'CURSOR_STALE' && e.status === 409);
  }
  pool.statements.length = 0;
  const last = await q.listBeats({ userId: 'u1', query: { limit: '2', edge: 'last' } });
  const m = pool.statements.find((s) => /FROM catalog_beats b WHERE/.test(s.sql));
  assert.match(m.sql, /ORDER BY \(255 - b\.rating_display\) DESC, b\.manual_rank DESC, b\.beat_id COLLATE "C" DESC LIMIT 3$/);
  assert.deepEqual(last.items.map((i) => i.id), ['b2', 'b3'], 'bloque final revertido al orden normal (fake devuelve 3 filas DESC: b3,b2,b1 → página b2,b3)');
  assert.deepEqual([last.startOrdinal, last.nextCursor], [1, null]);
  assert.ok(last.previousCursor, 'hay filas antes');
  await assert.rejects(q.listBeats({ userId: 'u1', query: { edge: 'last', cursor: first.nextCursor } }), (e) => e.code === 'INPUT_INVALID');
});

test('sin biblioteca POSTGRES delega en resolveContext (404/409), error SQL → 503, timeout SQL → 503 CATALOG_QUERY_TIMEOUT, página > 2 MiB → 413, cuarentena → 409', async () => {
  const vault = { id: 'v1', user_id: 'u1', telegram_chat_id: '-1', catalog_native_eligible: true, index_bootstrap_pending: true, transport_bot_id: 'Bot20', chat_known: false };
  const noLib = fakePool({ lib: null, onQuery: (sql) => (/FROM vaults v WHERE/.test(sql) ? { rows: [vault] } : null) });
  await assert.rejects(make(noLib).listBeats({ userId: 'u1' }), (e) => e.code === 'LIBRARY_NOT_PROVISIONED' && e.status === 404);
  const seq = noLib.statements.map((s) => s.sql);
  assert.ok(seq.indexOf('COMMIT') < seq.indexOf('BEGIN READ ONLY'), 'la transacción de lectura se cierra antes de resolveContext');
  assert.equal(noLib.client.released, 2, 'ambos clientes (lista + contexto) liberados');
  const legacy = fakePool({ lib: { ...LIB, authority: 'LEGACY' } });
  await assert.rejects(make(legacy).listBeats({ userId: 'u1' }), (e) => e.code === 'LIBRARY_RESET_REQUIRED' && e.status === 409);
  const boom = fakePool({ onQuery: (sql) => { if (/FROM catalog_beats b WHERE/.test(sql)) throw Object.assign(new Error('x'), { code: '42P01' }); } });
  await assert.rejects(make(boom).listBeats({ userId: 'u1' }), (e) => e.code === 'CATALOG_UNAVAILABLE' && e.status === 503 && e.detail.sqlstate === '42P01');
  const slow = fakePool({ onQuery: (sql) => { if (/FROM catalog_beats b WHERE/.test(sql)) throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); } });
  await assert.rejects(make(slow).listBeats({ userId: 'u1' }), (e) => e.code === 'CATALOG_QUERY_TIMEOUT' && e.status === 503);
  const big = fakePool({ rows: Array.from({ length: 240 }, (_, i) => ROW(i, { name: 'x'.repeat(9000) })) });
  await assert.rejects(make(big).listBeats({ userId: 'u1', query: { limit: '240' } }), (e) => e.code === 'CATALOG_PAGE_TOO_LARGE' && e.status === 413 && e.detail.bytes > 2 * 1024 * 1024);
  const quarantined = fakePool({ onQuery: (sql) => (/FROM control_plane_flush_quarantine/.test(sql) ? { rows: [{ '?column?': 1 }] } : null) });
  await assert.rejects(make(quarantined).listBeats({ userId: 'u1' }), (e) => e.code === 'VAULT_QUARANTINED' && e.status === 409);
  await assert.rejects(make(fakePool()).listBeats({ userId: '' }), /CATALOG_TENANT_REQUIRED/);
  // flag apagado → 503 antes de tocar la DB
  const off = fakePool();
  const auth = authority.createCatalogAuthority({ pool: off, env: {}, controlPlaneAuthority: 'postgres' });
  await assert.rejects(queries.createCatalogQueries({ pool: off, authority: auth, cursorKeys: KEYS }).listBeats({ userId: 'u1' }), (e) => e.code === 'CATALOG_UNAVAILABLE' && e.detail.reason === 'NATIVE_FLAG_DISABLED');
  assert.equal(off.statements.length, 0);
});

test('filtros globales en SQL: q por proyección search-js-v1 (name/tags/key/bpm, LIKE escapado COLLATE "C"), tags exactos ANY/ALL y exclusión; COUNT exacto solo con includeTotal', async () => {
  const pool = fakePool({ rows: [] });
  const q = make(pool);
  await q.listBeats({ userId: 'u1', query: { q: ' 50%_\\ ', includeTag: ['Trap', 'Dark'], excludeTag: 'demo', includeMode: 'all', includeTotal: 'true' } });
  const main = pool.statements.find((s) => /FROM catalog_beats b WHERE/.test(s.sql) && !/count\(\*\)/.test(s.sql));
  assert.match(main.sql, /b\.name_search COLLATE "C" LIKE \$4 ESCAPE '\\'/);
  assert.match(main.sql, /t\.search_key COLLATE "C" LIKE \$4 ESCAPE '\\'/);
  assert.match(main.sql, /b\.bpm_display COLLATE "C" LIKE \$4/);
  assert.match(main.sql, /count\(DISTINCT t\.label\)[\s\S]*= ANY\(\$5::text\[\]\)\) = 2/, 'ALL = no falta ninguno');
  assert.match(main.sql, /NOT EXISTS \(SELECT 1 FROM catalog_beat_tags t[\s\S]*= ANY\(\$6::text\[\]\)\)/);
  assert.deepEqual(main.params, ['u1', 'native-g', 'ACTIVE', '%50\\%\\_\\\\%', ['Dark', 'Trap'], ['demo']]);
  assert.ok(pool.statements.some((s) => /SELECT count\(\*\)::text AS n FROM catalog_beats b WHERE/.test(s.sql)), 'COUNT del mismo snapshot con includeTotal');
  pool.statements.length = 0;
  const r = await q.listBeats({ userId: 'u1', query: { includeTag: 'Trap' } });
  assert.ok(!pool.statements.some((s) => /count\(\*\)/.test(s.sql)), 'sin includeTotal no hay COUNT filtrado');
  assert.equal(r.totalMatched, null);
  assert.match(pool.statements.find((s) => /FROM catalog_beats b WHERE/.test(s.sql)).sql, /EXISTS \(SELECT 1 FROM catalog_beat_tags t[\s\S]*= ANY\(\$4::text\[\]\)\)/, 'ANY por defecto');
  pool.statements.length = 0;
  const plain = await q.listBeats({ userId: 'u1', query: {} });
  assert.equal(plain.totalMatched, 3, 'sin filtros: contadores de la biblioteca');
  assert.ok(!pool.statements.some((s) => /count\(\*\)/.test(s.sql)));
});

test('resolver legacy: offset canónico, parámetros de catálogo rechazados, N=0 vacío certificado, fuera de rango → último bloque inverso, >10.000 en rango → 409', async () => {
  const q0 = make(fakePool({ lib: { ...LIB, active_count: '0' } }));
  const empty = await q0.resolveLegacyNavigation({ userId: 'u1', query: { offset: '5' } });
  assert.deepEqual([empty.items, empty.resolution, empty.totalLibrary, empty.nextCursor, empty.previousCursor], [[], 'empty', 0, null, null]);
  const bad = (query, code) => assert.rejects(make(fakePool()).resolveLegacyNavigation({ userId: 'u1', query }), (e) => e.code === code && e.status === 400, JSON.stringify(query));
  for (const o of ['-1', '1.5', '0xF0', '1e9', 'nope', '01', '9007199254740993', undefined]) await bad({ offset: o }, 'LEGACY_OFFSET_INVALID');
  await bad({ offset: '0', cursor: 'x' }, 'INPUT_INVALID'); await bad({ offset: '0', q: 'a' }, 'INPUT_INVALID'); await bad({ offset: '0', limit: '100' }, 'INPUT_INVALID');
  const pool = fakePool({ lib: { ...LIB, active_count: '500' }, rows: (sql) => (/DESC LIMIT 20$/.test(sql) ? Array.from({ length: 20 }, (_, i) => ROW(499 - i)) : []) });
  const q = make(pool);
  const last = await q.resolveLegacyNavigation({ userId: 'u1', query: { offset: '1000000000', sort: 'rating' } });
  assert.deepEqual([last.resolution, last.resolvedOffset, last.requestedOffset, last.startOrdinal, last.items.length, last.nextCursor], ['last', 480, 1000000000, 480, 20, null]);
  assert.deepEqual(last.items.map((i) => i.id).slice(0, 3), ['b480', 'b481', 'b482'], 'índice inverso revertido');
  assert.ok(last.previousCursor && q.signer.verify(last.previousCursor).payload.startOrdinal === 240);
  pool.statements.length = 0;
  await q.resolveLegacyNavigation({ userId: 'u1', query: { offset: '241' } });
  const m = pool.statements.find((s) => /OFFSET 241 LIMIT 241/.test(s.sql));
  assert.ok(m, 'único OFFSET acotado, claves por índice y DTO solo de las devueltas');
  assert.match(m.sql, /SELECT k\.beat_id FROM catalog_beats k WHERE/);
  const deep = make(fakePool({ lib: { ...LIB, active_count: '20000' } }));
  await assert.rejects(deep.resolveLegacyNavigation({ userId: 'u1', query: { offset: '10001' } }), (e) => e.code === 'LEGACY_OFFSET_UNRESOLVABLE' && e.status === 409 && e.detail.action === 'go-to-start');
  await deep.resolveLegacyNavigation({ userId: 'u1', query: { offset: '10000' } }); // en el límite: permitido
});
