'use strict';
// T06 — Consultas paginadas del catálogo (CONTRATO C5, C12-DECISION-RECORD §3.4, §4, §5.2; C12-r4 §3, §6; MATRIZ-V V02).
//  - Solo lectura sobre PostgreSQL: una transacción breve REPEATABLE READ READ ONLY por petición, statement_timeout 1000 ms,
//    tope total 2000 ms → 503 CATALOG_QUERY_TIMEOUT. Nunca 200 vacío ante error; nunca transporte ni INDEX.
//  - Filtros globales en SQL (q = proyección search-js-v1, tags exactos, ANY/ALL, exclusión vence) antes de LIMIT.
//  - Keyset con tupla completa y comparación de filas, en ambas direcciones; cursores HMAC (cursor.js) ligados a tenant,
//    era, época, generación, revisión, perfiles, filtros, sort y limit. `edge=last` lee en orden inverso. resumeCursor inclusivo.
//  - Resolver legacy acotado (§5.2): único OFFSET permitido, ≤ 10.000; fuera de rango → último bloque por índice inverso.
//  - Conjuntos de consulta (C12-r4 §3): create/step/cancel/release con lotes ≤ 240 invocables por el arnés; T10 los programa.
// Sin importar transporte: solo SQL + crypto.

const crypto = require('crypto');
const { requireUserId } = require('./contract');
const { canonicalJson, CatalogAuthorityError } = require('./authority');
const { CatalogQueryError, createCursorSigner, keysFromEnv } = require('./cursor');
const { SEARCH_TEXT_SEP } = require('./legacy-codec');

const LIMIT_DEFAULT = 100;
const LIMIT_MAX = 240;
const FILES_LIMIT_MAX = 100;
const FACETS_LIMIT_MAX = 240;
const QUERY_SET_BATCH_MAX = 240;
const Q_MAX_BYTES = 64 * 1024;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const PREDICATE_MAX_BYTES = 8192; // CHECK de catalog_query_sets.predicate_json (0026)
const STATEMENT_TIMEOUT_MS = 1000;
const API_TIMEOUT_MS = 2000;
const LEGACY_OFFSET_MAX = 10000;
const LEGACY_BLOCK = 240;
const LEASE_MINUTES = 30;
const SORT_PROFILE = 'catalog-order-v1';
const SEARCH_PROFILE = 'search-js-v1';
const NAME_COLLATION = 'catalog_name_icu_und_v1';
const STATES = Object.freeze(['ACTIVE', 'TRASH']);
const SORTS = Object.freeze(['manual', 'rating', 'name', 'bpm']);
const INCLUDE_MODES = Object.freeze(['any', 'all']);

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const unavailable = (reason, extra = {}) => new CatalogQueryError('CATALOG_UNAVAILABLE', 503, `catalog is unavailable (${reason})`, { reason, ...extra });
const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// ---------- tuplas de orden (C12 §4.3): todas ASC para comparar filas; rating como 255 - rating_display ----------
const TUPLES = Object.freeze({
  manual: ['b.manual_rank', 'b.beat_id COLLATE "C"'],
  rating: ['(255 - b.rating_display)', 'b.manual_rank', 'b.beat_id COLLATE "C"'],
  name: [`b.name_display COLLATE ${NAME_COLLATION}`, 'b.manual_rank', 'b.beat_id COLLATE "C"'],
  bpm: ['b.bpm_sort_class', '(coalesce(b.bpm_sort, 0::float8))', 'b.manual_rank', 'b.beat_id COLLATE "C"'],
});
const TUPLE_CASTS = Object.freeze({
  manual: ['numeric', 'text'],
  rating: ['int', 'numeric', 'text'],
  name: ['text', 'numeric', 'text'],
  bpm: ['int', 'float8', 'numeric', 'text'],
});
// Columnas de la tupla como texto (para el cursor): roundtrip exacto (numeric/float8 vía text).
const TUPLE_TEXT = Object.freeze({
  manual: ['b.manual_rank::text', 'b.beat_id'],
  rating: ['(255 - b.rating_display)::text', 'b.manual_rank::text', 'b.beat_id'],
  name: ['b.name_display', 'b.manual_rank::text', 'b.beat_id'],
  bpm: ['b.bpm_sort_class::text', '(coalesce(b.bpm_sort, 0::float8))::text', 'b.manual_rank::text', 'b.beat_id'],
});

// ---------- parseo de la petición (C12 §4.1) ----------
function scalar(query, key) {
  const v = query[key];
  if (v === undefined) return undefined;
  if (Array.isArray(v)) throw inputInvalid('REPEATED_SCALAR', { param: key });
  if (typeof v !== 'string') throw inputInvalid('NOT_STRING', { param: key });
  return v;
}
function multi(query, key) {
  const v = query[key];
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  for (const x of arr) if (typeof x !== 'string') throw inputInvalid('NOT_STRING', { param: key });
  return arr;
}
function byteSort(values) {
  return [...new Set(values)].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}
function parseLimit(raw, { max, dflt }) {
  if (raw === undefined) return dflt;
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw inputInvalid('LIMIT', { max });
  const n = Number(raw);
  if (n < 1 || n > max) throw inputInvalid('LIMIT', { max });
  return n;
}
function parseEnum(raw, allowed, dflt, param) {
  if (raw === undefined) return dflt;
  if (!allowed.includes(raw)) throw inputInvalid('ENUM', { param, allowed });
  return raw;
}
function parseBool(raw, param) {
  if (raw === undefined) return false;
  if (raw !== 'true' && raw !== 'false') throw inputInvalid('ENUM', { param, allowed: ['true', 'false'] });
  return raw === 'true';
}
function filterHashOf(f) {
  return sha256Hex(canonicalJson({ state: f.state, q: f.q, includeMode: f.includeMode, include: f.includeTags, exclude: f.excludeTags }));
}
// q lógico = search.trim().toLowerCase() (librarySelectors.ts:17); vacío no filtra.
function canonicalQ(raw) {
  const q = (raw || '').trim().toLowerCase();
  if (Buffer.byteLength(q, 'utf8') > Q_MAX_BYTES) throw inputInvalid('QUERY_TOO_LARGE', { max_bytes: Q_MAX_BYTES });
  return q;
}
function parseListRequest(query = {}) {
  const state = parseEnum(scalar(query, 'state'), STATES, 'ACTIVE', 'state');
  const sort = parseEnum(scalar(query, 'sort'), SORTS, 'rating', 'sort');
  const includeMode = parseEnum(scalar(query, 'includeMode'), INCLUDE_MODES, 'any', 'includeMode');
  const limit = parseLimit(scalar(query, 'limit'), { max: LIMIT_MAX, dflt: LIMIT_DEFAULT });
  const includeTotal = parseBool(scalar(query, 'includeTotal'), 'includeTotal');
  const q = canonicalQ(scalar(query, 'q'));
  const includeTags = byteSort(multi(query, 'includeTag'));
  const excludeTags = byteSort(multi(query, 'excludeTag'));
  for (const t of [...includeTags, ...excludeTags]) if (Buffer.byteLength(t, 'utf8') > Q_MAX_BYTES) throw inputInvalid('TAG_TOO_LARGE');
  const cursor = scalar(query, 'cursor');
  const edge = scalar(query, 'edge');
  if (edge !== undefined && edge !== 'last') throw inputInvalid('ENUM', { param: 'edge', allowed: ['last'] });
  if (cursor !== undefined && edge !== undefined) throw inputInvalid('CURSOR_AND_EDGE');
  if (query.bgPage !== undefined || query.offset !== undefined) throw inputInvalid('LEGACY_PARAM_ON_CATALOG_LIST');
  const filters = Object.freeze({ state, q, includeMode, includeTags, excludeTags });
  return Object.freeze({ ...filters, sort, limit, includeTotal, cursor: cursor || null, edge: edge || null, filterHash: filterHashOf(filters) });
}

// ---------- SQL ----------
function likePattern(q) { return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; }
// Modo de búsqueda de q (ya canónico). FIELDS: contiene el separador de search_text (predicado por campos). GRAMS: 1-2 caracteres (code points).
// TRGM: 3+ caracteres con al menos un trozo de 3 caracteres alfanuméricos consecutivos (garantiza >= 1 trigrama real para pg_trgm; si el
// ctype de la base no los considerara alfanuméricos solo se pierde velocidad, nunca exactitud). SCAN: el resto.
function searchMode(q) {
  if (q.includes(SEARCH_TEXT_SEP)) return 'FIELDS';
  let n = 0; for (const _ of q) { if (++n > 2) break; }
  if (n <= 2) return 'GRAMS';
  return /[\p{L}\p{N}]{3}/u.test(q) ? 'TRGM' : 'SCAN';
}
// 0039: umbral de frecuencia (beats de la biblioteca/estado que contienen el grama) por debajo del cual el GIN de gramas gana al recorrido
// ordenado con LIMIT; por encima, el recorrido ordenado encuentra la página tras leer ~LIMIT/densidad filas (medido a 1M: 'mi' 59k beats 2,7 ms
// ordenado vs 257 ms GIN). El contador solo elige camino y responde el COUNT: ambos caminos devuelven exactamente las mismas filas.
const GRAM_GIN_MAX = 5000;
// Resuelve el modo efectivo de q dentro de la transacción de lectura. Devuelve { mode, n } (n = contador exacto solo si es utilizable).
async function planSearch(client, uid, gen, state, q) {
  const mode = searchMode(q);
  if (mode !== 'GRAMS') return { mode, n: null };
  const r = await client.query(`SELECT (SELECT beat_count::text FROM catalog_search_gram_counts WHERE user_id = $1 AND generation_id = $2 AND state = $3 AND gram = $4) AS n,
    EXISTS (SELECT 1 FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = $3 AND search_text IS NULL) AS unprojected`, [uid, gen, state, q]);
  // filas sin proyectar (search_text NULL): el contador no las cubre -> predicado por campos, correcto aunque más lento
  if (r.rows[0].unprojected) return { mode: 'FIELDS', n: null };
  const n = r.rows[0].n === null ? 0 : Number(r.rows[0].n);
  return { mode: n <= GRAM_GIN_MAX ? 'GRAMS' : 'SCAN', n };
}
// Predicado de filtros sobre el alias b. Devuelve {sql, params} añadiendo a params. `mode` (de planSearch) fija el camino de q.
function filterSql(f, params, mode = f.q ? searchMode(f.q) : null) {
  const parts = [];
  if (f.q) {
    params.push(likePattern(f.q)); const p = `$${params.length}`;
    let g = null; if (mode === 'GRAMS') { params.push(f.q); g = `$${params.length}`; }
    const byFields = `(b.name_search COLLATE "C" LIKE ${p} ESCAPE '\\' OR b.key_search COLLATE "C" LIKE ${p} ESCAPE '\\' OR b.bpm_display COLLATE "C" LIKE ${p} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM catalog_beat_tags t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id AND t.search_key COLLATE "C" LIKE ${p} ESCAPE '\\'))`;
    // 0037: un único LIKE sobre search_text (name_search ␟ key_search ␟ bpm_display ␟ search_key de los tags) cuando existe; es equivalente
    // porque un q sin ␟ no puede cruzar el separador. Si q contiene ␟, o la fila aún no tiene search_text (NULL), se usa el predicado por
    // campos (el subplan hashed sobre catalog_beat_tags solo se construye si alguna fila lo evalúa). SEARCH_PROFILE no cambia.
    // 0038: el predicado sobre search_text elige el índice de forma DETERMINISTA (el planner no sabe que un LIKE sin trigramas obliga a
    // recorrer todo el GIN y lo elige igualmente): GRAMS = 1-2 caracteres vía GIN de 1/2-gramas por campo (equivalencia exacta con el LIKE);
    // TRGM = GIN pg_trgm; SCAN = LIKE que ningún índice puede usar (`|| ''`), para q de 3+ caracteres sin ningún trozo alfanumérico de 3.
    const onText = {
      GRAMS: `catalog_search_grams(b.search_text) @> ARRAY[${g}::text]`,
      TRGM: `b.search_text COLLATE "C" LIKE ${p} ESCAPE '\\'`,
      SCAN: `(b.search_text || '') COLLATE "C" LIKE ${p} ESCAPE '\\'`,
    }[mode];
    parts.push(mode === 'FIELDS' ? byFields : `((b.search_text IS NOT NULL AND ${onText}) OR (b.search_text IS NULL AND ${byFields}))`);
  }
  if (f.includeTags.length) {
    params.push(f.includeTags); const p = `$${params.length}`;
    if (f.includeMode === 'all') parts.push(`(SELECT count(DISTINCT t.label) FROM catalog_beat_tags t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id AND t.label = ANY(${p}::text[])) = ${f.includeTags.length}`);
    else parts.push(`EXISTS (SELECT 1 FROM catalog_beat_tags t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id AND t.label = ANY(${p}::text[]))`);
  }
  if (f.excludeTags.length) {
    params.push(f.excludeTags); const p = `$${params.length}`;
    parts.push(`NOT EXISTS (SELECT 1 FROM catalog_beat_tags t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id AND t.label = ANY(${p}::text[]))`);
  }
  return parts.length ? ' AND ' + parts.join(' AND ') : '';
}
function tupleRow(sort) { return `ROW(${TUPLES[sort].join(', ')})`; }
function boundaryRow(sort, params, tuple) {
  const casts = TUPLE_CASTS[sort];
  if (!Array.isArray(tuple) || tuple.length !== casts.length || tuple.some((v) => typeof v !== 'string')) throw new CatalogQueryError('CURSOR_INVALID', 400, 'cursor is invalid', { reason: 'BOUNDARY_SHAPE' });
  const refs = tuple.map((v, i) => { params.push(v); return `$${params.length}::${casts[i]}${casts[i] === 'text' && i === casts.length - 1 ? ' COLLATE "C"' : casts[i] === 'text' ? ` COLLATE ${NAME_COLLATION}` : ''}`; });
  return `ROW(${refs.join(', ')})`;
}
function orderBy(sort, desc) { return TUPLES[sort].map((c) => `${c}${desc ? ' DESC' : ''}`).join(', '); }
const DTO_COLUMNS = `b.beat_id AS id, b.version::text AS version, b.state, b.name_display AS name, b.bpm_display AS bpm, b.key_display AS key,
  b.rating_display AS rating, b.color, b.color2, b.has_artwork, b.manual_rank::text AS manual_rank,
  (SELECT coalesce(array_agg(t.label ORDER BY t.position), '{}') FROM catalog_beat_tags t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id) AS tags,
  (SELECT coalesce(json_agg(json_build_object('slot', cf.slot_key, 'fileId', cf.file_id, 'role', fv.role, 'revision', fv.revision::text) ORDER BY cf.slot_key), '[]'::json)
     FROM catalog_current_files cf JOIN catalog_file_versions fv ON fv.user_id = cf.user_id AND fv.generation_id = cf.generation_id AND fv.file_id = cf.file_id
     WHERE cf.user_id = b.user_id AND cf.generation_id = b.generation_id AND cf.beat_id = b.beat_id) AS files`;

function itemDto(row) {
  const files = Array.isArray(row.files) ? row.files : [];
  const slot = (k) => files.find((f) => f.slot === k) || null;
  const ref = (f) => (f ? { fileId: f.fileId, revision: f.revision } : null);
  return {
    id: row.id, version: row.version, state: row.state, name: row.name, bpm: row.bpm, key: row.key, tags: row.tags || [], rating: row.rating,
    color: row.color, color2: row.color2, artwork: ref(slot('ARTWORK')), playback: ref(slot('MASTER')),
    hasArtwork: row.has_artwork === true || slot('ARTWORK') !== null, hasWav: files.some((f) => f.role === 'WAV'), hasStems: files.some((f) => f.role === 'STEMS'),
    hasProject: slot('PROJECT') !== null, fileCount: files.length,
  };
}
function tupleOf(row, sort) { return TUPLE_TEXT[sort].map((_, i) => row[`k${i}`]); }
function tupleSelect(sort) { return TUPLE_TEXT[sort].map((c, i) => `${c} AS k${i}`).join(', '); }

const LIB_SQL = `SELECT l.user_id, l.vault_id, l.authority, l.migration_state, l.authority_era::text AS authority_era, l.authority_epoch::text AS authority_epoch,
  l.revision::text AS revision, l.active_generation_id, l.active_count::text AS active_count, l.trash_count::text AS trash_count,
  l.purging_count::text AS purging_count, l.pending_count::text AS pending_count, l.restore_hold, l.cleanup_enabled
  FROM catalog_libraries l WHERE l.user_id = $1`;

function contextDto(lib) {
  return {
    authority: 'POSTGRES', authorityEra: lib.authority_era, epoch: lib.authority_epoch, revision: lib.revision, generationId: lib.active_generation_id,
    migrationState: lib.migration_state, sortProfile: SORT_PROFILE, searchProfile: SEARCH_PROFILE,
    counts: { active: Number(lib.active_count), trash: Number(lib.trash_count), purging: Number(lib.purging_count), pending: Number(lib.pending_count) },
  };
}

function sqlError(error) {
  if (error instanceof CatalogAuthorityError) return error;
  if (error?.code === '57014') return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog query timed out', { sqlstate: '57014' });
  return unavailable('SQL_ERROR', { sqlstate: error?.code || null });
}
function withDeadline(promise, ms, onTimeout) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog request exceeded the total time budget', { budget_ms: ms })); }, ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function createCatalogQueries({ pool = null, authority = null, env = process.env, cursorKeys = null, now = () => Date.now(), randomUUID = () => crypto.randomUUID() } = {}) {
  if (!authority || typeof authority.availability !== 'function') throw new Error('createCatalogQueries requires the catalog authority');
  const keyring = cursorKeys ? { keys: cursorKeys, source: 'explicit' } : keysFromEnv(env);
  const signer = createCursorSigner({ keys: keyring.keys });

  // Transacción de lectura breve y consistente: la disponibilidad (flag/activación) se exige antes; la biblioteca POSTGRES
  // se lee dentro del snapshot. Sin fila POSTGRES, la respuesta exacta (404/409/503) la decide authority.resolveContext.
  async function readTx(userId, fn) {
    const uid = requireUserId(userId);
    await authority.availability();
    if (!pool || typeof pool.connect !== 'function') throw unavailable('POSTGRES_UNAVAILABLE');
    const client = await pool.connect();
    let r;
    try {
      const run = (async () => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
          const q = await client.query('SELECT 1 FROM control_plane_flush_quarantine WHERE user_id = $1 AND resolved_at IS NULL LIMIT 1', [uid]);
          if (q.rows.length) throw new CatalogAuthorityError('VAULT_QUARANTINED', 409, 'vault is quarantined by the control-plane flush', {});
          const lib = (await client.query(LIB_SQL, [uid])).rows[0] || null;
          if (!lib || lib.authority !== 'POSTGRES' || !lib.active_generation_id) return { noLibrary: true };
          const out = await fn(client, lib, uid);
          return { value: out };
        } finally { await client.query('COMMIT').catch(() => {}); }
      })();
      r = await withDeadline(run, API_TIMEOUT_MS);
    } catch (error) {
      throw sqlError(error);
    } finally {
      client.release();
    }
    if (r.noLibrary) {
      await authority.resolveContext({ userId: uid }); // lanza 404/409/503 con el cliente ya liberado
      throw unavailable('CONTEXT_RACE');
    }
    return r.value;
  }

  // ---------- cursor ↔ contexto ----------
  function cursorBase(lib, uid, req) {
    return { kind: 'beats', tenantId: uid, vaultId: lib.vault_id, generationId: lib.active_generation_id, era: lib.authority_era, epoch: lib.authority_epoch,
      revision: lib.revision, searchProfile: SEARCH_PROFILE, sortProfile: SORT_PROFILE, filterHash: req.filterHash, sort: req.sort, limit: req.limit };
  }
  function verifyCursor(token, lib, uid, req, kind = 'beats') {
    const { payload } = signer.verify(token);
    const bad = (reason) => new CatalogQueryError('CURSOR_INVALID', 400, 'cursor is invalid', { reason });
    if (payload.kind !== kind) throw bad('KIND');
    // Ajeno o incongruente con la petición → 400 genérico sin datos de otra cuenta.
    if (payload.tenantId !== uid) throw bad('TENANT');
    if (kind === 'beats' && (payload.filterHash !== req.filterHash || payload.sort !== req.sort || payload.limit !== req.limit)) throw bad('REQUEST_MISMATCH');
    if (kind === 'facets' && (payload.scope !== req.scope || payload.limit !== req.limit)) throw bad('REQUEST_MISMATCH');
    // Propio pero viejo → 409 CURSOR_STALE.
    if (payload.vaultId !== lib.vault_id || payload.generationId !== lib.active_generation_id || payload.era !== lib.authority_era
      || payload.epoch !== lib.authority_epoch || payload.revision !== lib.revision || payload.searchProfile !== SEARCH_PROFILE || payload.sortProfile !== SORT_PROFILE) {
      throw new CatalogQueryError('CURSOR_STALE', 409, 'cursor belongs to a previous revision or context', { current_revision: lib.revision });
    }
    if (!['forward', 'backward', 'first'].includes(payload.direction)) throw bad('DIRECTION');
    if (payload.direction !== 'first' && (!payload.boundary || typeof payload.boundary.inclusive !== 'boolean')) throw bad('BOUNDARY');
    if (!Number.isSafeInteger(payload.startOrdinal) || payload.startOrdinal < 0) throw bad('ORDINAL');
    if (payload.totalMatched !== null && !Number.isSafeInteger(payload.totalMatched)) throw bad('TOTAL');
    return payload;
  }

  // ---------- GET /catalog/v1/beats ----------
  async function listBeats({ userId, query = {}, request = null } = {}) {
    const req = request || parseListRequest(query);
    return readTx(userId, async (client, lib, uid) => {
      const hasFilters = Boolean(req.q) || req.includeTags.length > 0 || req.excludeTags.length > 0;
      let cur = null;
      if (req.cursor) cur = verifyCursor(req.cursor, lib, uid, req);
      const direction = req.edge === 'last' ? 'last' : cur ? cur.direction : 'first';
      const params = [uid, lib.active_generation_id, req.state];
      const plan = req.q ? await planSearch(client, uid, lib.active_generation_id, req.state, req.q) : { mode: null, n: null };
      const where = `b.user_id = $1 AND b.generation_id = $2 AND b.state = $3${filterSql(req, params, plan.mode)}`;

      // total del mismo snapshot: contadores sin filtros; COUNT exacto si includeTotal o si hace falta para edge=last; si no, el firmado.
      let total = null;
      if (!hasFilters) total = Number(req.state === 'ACTIVE' ? lib.active_count : lib.trash_count);
      else if ((req.includeTotal || direction === 'last') && plan.n !== null && req.includeTags.length === 0 && req.excludeTags.length === 0) total = plan.n; // 0039: contador exacto de q de 1-2 caracteres
      else if (req.includeTotal || direction === 'last') total = Number((await client.query(`SELECT count(*)::text AS n FROM catalog_beats b WHERE ${where}`, params)).rows[0].n);
      else if (cur && cur.totalMatched !== null) total = cur.totalMatched;

      let keyset = '';
      if (cur && cur.direction !== 'first') {
        const op = cur.direction === 'forward' ? (cur.boundary.inclusive ? '>=' : '>') : (cur.boundary.inclusive ? '<=' : '<');
        keyset = ` AND ${tupleRow(req.sort)} ${op} ${boundaryRow(req.sort, params, cur.boundary.tuple)}`;
      }
      const desc = direction === 'last' || (cur && cur.direction === 'backward');
      const sql = `SELECT ${DTO_COLUMNS}, ${tupleSelect(req.sort)} FROM catalog_beats b WHERE ${where}${keyset} ORDER BY ${orderBy(req.sort, desc)} LIMIT ${req.limit + 1}`;
      const rows = (await client.query(sql, params)).rows;
      const extra = rows.length > req.limit;
      let page = rows.slice(0, req.limit);
      if (desc) page = page.reverse();

      let startOrdinal;
      if (direction === 'first') startOrdinal = 0;
      else if (direction === 'last') startOrdinal = Math.max(0, total - page.length);
      else startOrdinal = cur.startOrdinal;
      const hasNext = direction === 'last' ? false : cur && cur.direction === 'backward' ? true : extra;
      const hasPrev = startOrdinal > 0; // ordinal 0 → previousCursor null (C12 §4.3)

      const base = { ...cursorBase(lib, uid, req), totalMatched: total };
      const items = page.map(itemDto);
      const firstTuple = page.length ? tupleOf(page[0], req.sort) : null;
      const lastTuple = page.length ? tupleOf(page[page.length - 1], req.sort) : null;
      const nextCursor = hasNext && lastTuple ? { ...base, direction: 'forward', boundary: { tuple: lastTuple, inclusive: false }, startOrdinal: startOrdinal + page.length } : null;
      let previousCursor = null;
      if (hasPrev && firstTuple) {
        previousCursor = startOrdinal < req.limit
          ? { ...base, direction: 'first', boundary: null, startOrdinal: 0 }
          : { ...base, direction: 'backward', boundary: { tuple: firstTuple, inclusive: false }, startOrdinal: startOrdinal - req.limit };
      }
      const resumeCursor = firstTuple ? { ...base, direction: 'forward', boundary: { tuple: firstTuple, inclusive: true }, startOrdinal } : { ...base, direction: 'first', boundary: null, startOrdinal: 0 };
      return { items, startOrdinal, totalMatched: total, totalLibrary: Number(req.state === 'ACTIVE' ? lib.active_count : lib.trash_count),
        context: contextDto(lib), cursors: { next: nextCursor, previous: previousCursor, resume: resumeCursor }, hasNext, hasPrev };
    }).then((r) => finishPage(r));
  }
  // Firma fuera de la transacción y acota el tamaño serializado (2 MiB → 413 CATALOG_PAGE_TOO_LARGE).
  function finishPage(r) {
    const body = {
      items: r.items, authorityEra: r.context.authorityEra, epoch: r.context.epoch, revision: r.context.revision, generationId: r.context.generationId,
      sortProfile: SORT_PROFILE, searchProfile: SEARCH_PROFILE, totalLibrary: r.totalLibrary, totalMatched: r.totalMatched, startOrdinal: r.startOrdinal,
      nextCursor: r.cursors.next ? signer.sign(r.cursors.next) : null, previousCursor: r.cursors.previous ? signer.sign(r.cursors.previous) : null,
      resumeCursor: signer.sign(r.cursors.resume),
    };
    if (r.resolution) Object.assign(body, { resolution: r.resolution, resolvedOffset: r.resolvedOffset, requestedOffset: r.requestedOffset, anchorOrdinal: r.startOrdinal });
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (bytes > PAGE_MAX_BYTES) throw new CatalogQueryError('CATALOG_PAGE_TOO_LARGE', 413, 'serialized page exceeds 2 MiB', { bytes, max_bytes: PAGE_MAX_BYTES });
    return body;
  }

  // ---------- GET /catalog/v1/beats/:id ----------
  async function getBeat({ userId, beatId } = {}) {
    if (typeof beatId !== 'string' || !beatId || Buffer.byteLength(beatId, 'utf8') > 1024) throw inputInvalid('BEAT_ID');
    return readTx(userId, async (client, lib, uid) => {
      const r = await client.query(`SELECT ${DTO_COLUMNS}, b.sort_order, b.telegram_topic_id::text AS telegram_topic_id, b.created_at, b.updated_at,
          (SELECT json_build_object('trashId', te.trash_id, 'trashedAt', te.trashed_at, 'purgeAfter', te.purge_after) FROM catalog_trash_entries te
             WHERE te.user_id = b.user_id AND te.generation_id = b.generation_id AND te.beat_id = b.beat_id) AS trash
        FROM catalog_beats b WHERE b.user_id = $1 AND b.generation_id = $2 AND b.beat_id = $3 AND b.state IN ('ACTIVE', 'TRASH', 'PURGING')`, [uid, lib.active_generation_id, beatId]);
      const row = r.rows[0];
      if (!row) throw new CatalogQueryError('NOT_FOUND', 404, 'beat is not accessible', {});
      const dto = itemDto(row);
      return { ...dto, manualRank: row.manual_rank, trash: row.trash || null, updatedAt: row.updated_at, etag: `W/"${row.id.length}-${row.version}"`,
        authorityEra: lib.authority_era, epoch: lib.authority_epoch, revision: lib.revision, generationId: lib.active_generation_id };
    });
  }

  // ---------- GET /catalog/v1/beats/:id/files (keyset por file_id COLLATE "C", límite 100) ----------
  async function listBeatFiles({ userId, beatId, query = {} } = {}) {
    if (typeof beatId !== 'string' || !beatId) throw inputInvalid('BEAT_ID');
    const limit = parseLimit(scalar(query, 'limit'), { max: FILES_LIMIT_MAX, dflt: FILES_LIMIT_MAX });
    const after = scalar(query, 'after') || null;
    return readTx(userId, async (client, lib, uid) => {
      const exists = await client.query("SELECT 1 FROM catalog_beats b WHERE b.user_id = $1 AND b.generation_id = $2 AND b.beat_id = $3 AND b.state IN ('ACTIVE', 'TRASH', 'PURGING')", [uid, lib.active_generation_id, beatId]);
      if (!exists.rows.length) throw new CatalogQueryError('NOT_FOUND', 404, 'beat is not accessible', {});
      const params = [uid, lib.active_generation_id, beatId, limit + 1];
      let keyset = '';
      if (after) { params.push(after); keyset = ` AND fv.file_id COLLATE "C" > $${params.length}`; }
      const r = await client.query(`SELECT fv.file_id, fv.role, fv.revision::text AS revision, fv.filename, fv.mime, fv.size_bytes::text AS size_bytes, fv.status, fv.verified_sha256,
          (SELECT cf.slot_key FROM catalog_current_files cf WHERE cf.user_id = fv.user_id AND cf.generation_id = fv.generation_id AND cf.file_id = fv.file_id LIMIT 1) AS slot,
          (SELECT count(*)::int FROM catalog_file_parts p WHERE p.user_id = fv.user_id AND p.generation_id = fv.generation_id AND p.file_id = fv.file_id) AS part_count
        FROM catalog_file_versions fv WHERE fv.user_id = $1 AND fv.generation_id = $2 AND fv.beat_id = $3 AND fv.status <> 'DELETED'${keyset}
        ORDER BY fv.file_id COLLATE "C" LIMIT $4`, params);
      const rows = r.rows.slice(0, limit);
      return {
        items: rows.map((f) => ({ fileId: f.file_id, role: f.role, revision: f.revision, filename: f.filename, mime: f.mime, sizeBytes: f.size_bytes, status: f.status,
          verified: f.verified_sha256 !== null, slot: f.slot, partCount: f.part_count, current: f.slot !== null })),
        nextAfter: r.rows.length > limit ? rows[rows.length - 1].file_id : null, revision: lib.revision, epoch: lib.authority_epoch, authorityEra: lib.authority_era,
      };
    });
  }

  // ---------- GET /catalog/v1/navigation/legacy (C12 §5.2, solo ACTIVE, sin filtros, bloque 240) ----------
  async function resolveLegacyNavigation({ userId, query = {} } = {}) {
    for (const k of ['cursor', 'q', 'includeTag', 'excludeTag', 'edge', 'state']) if (query[k] !== undefined) throw inputInvalid('LEGACY_WITH_CATALOG_PARAMS', { param: k });
    const sort = parseEnum(scalar(query, 'sort'), SORTS, 'rating', 'sort');
    const limitRaw = scalar(query, 'limit');
    if (limitRaw !== undefined && limitRaw !== String(LEGACY_BLOCK)) throw inputInvalid('LIMIT', { allowed: [LEGACY_BLOCK] });
    const offsetRaw = scalar(query, 'offset');
    if (offsetRaw === undefined || !/^(0|[1-9][0-9]{0,15})$/.test(offsetRaw) || !Number.isSafeInteger(Number(offsetRaw))) {
      throw new CatalogQueryError('LEGACY_OFFSET_INVALID', 400, 'legacy offset must be a canonical safe non-negative integer', { action: 'first-page' });
    }
    const offset = Number(offsetRaw);
    const req = Object.freeze({ state: 'ACTIVE', q: '', includeMode: 'any', includeTags: [], excludeTags: [], sort, limit: LEGACY_BLOCK, includeTotal: true, cursor: null, edge: null,
      filterHash: filterHashOf({ state: 'ACTIVE', q: '', includeMode: 'any', includeTags: [], excludeTags: [] }) });
    const r = await readTx(userId, async (client, lib, uid) => {
      const total = Number(lib.active_count);
      const params = [uid, lib.active_generation_id];
      const where = "b.user_id = $1 AND b.generation_id = $2 AND b.state = 'ACTIVE'";
      const base = { ...cursorBase(lib, uid, req), totalMatched: total };
      const empty = (resolution, resolvedOffset) => ({ items: [], startOrdinal: 0, totalMatched: total, totalLibrary: total, context: contextDto(lib),
        cursors: { next: null, previous: null, resume: { ...base, direction: 'first', boundary: null, startOrdinal: 0 } }, resolution, resolvedOffset, requestedOffset: offset });
      if (total === 0) return empty('empty', 0); // vacío SQL certificado, no fallback
      let page; let startOrdinal; let resolution;
      if (offset >= total) {
        const lastStart = Math.floor((total - 1) / LEGACY_BLOCK) * LEGACY_BLOCK;
        const n = total - lastStart; // 1…240, por índice inverso
        page = (await client.query(`SELECT ${DTO_COLUMNS}, ${tupleSelect(sort)} FROM catalog_beats b WHERE ${where} ORDER BY ${orderBy(sort, true)} LIMIT ${n}`, params)).rows.reverse();
        startOrdinal = lastStart; resolution = 'last';
      } else if (offset <= LEGACY_OFFSET_MAX) {
        // Único OFFSET autorizado: claves por índice de orden, DTO solo de las 241 filas devueltas.
        page = (await client.query(`SELECT ${DTO_COLUMNS}, ${tupleSelect(sort)} FROM catalog_beats b
          JOIN (SELECT k.beat_id FROM catalog_beats k WHERE k.user_id = $1 AND k.generation_id = $2 AND k.state = 'ACTIVE'
                ORDER BY ${orderBy(sort, false).replace(/\bb\./g, 'k.')} OFFSET ${offset} LIMIT ${LEGACY_BLOCK + 1}) sel ON sel.beat_id = b.beat_id
          WHERE ${where} ORDER BY ${orderBy(sort, false)}`, params)).rows;
        startOrdinal = offset; resolution = 'exact';
      } else {
        throw new CatalogQueryError('LEGACY_OFFSET_UNRESOLVABLE', 409, 'legacy offset is inside the library but beyond the bounded conversion range', { max_offset: LEGACY_OFFSET_MAX, total, action: 'go-to-start' });
      }
      const extra = page.length > LEGACY_BLOCK;
      page = page.slice(0, LEGACY_BLOCK);
      const firstTuple = page.length ? tupleOf(page[0], sort) : null;
      const lastTuple = page.length ? tupleOf(page[page.length - 1], sort) : null;
      const hasNext = resolution === 'last' ? false : extra;
      const next = hasNext ? { ...base, direction: 'forward', boundary: { tuple: lastTuple, inclusive: false }, startOrdinal: startOrdinal + page.length } : null;
      const prev = startOrdinal === 0 ? null : startOrdinal < LEGACY_BLOCK ? { ...base, direction: 'first', boundary: null, startOrdinal: 0 }
        : { ...base, direction: 'backward', boundary: { tuple: firstTuple, inclusive: false }, startOrdinal: startOrdinal - LEGACY_BLOCK };
      return { items: page.map(itemDto), startOrdinal, totalMatched: total, totalLibrary: total, context: contextDto(lib), resolution, resolvedOffset: startOrdinal, requestedOffset: offset,
        cursors: { next, previous: prev, resume: { ...base, direction: 'forward', boundary: { tuple: firstTuple, inclusive: true }, startOrdinal } } };
    });
    return finishPage(r);
  }

  // ---------- Facetas (C12-r4 §6): frecuencia desc, nombre A1, clave binaria; activos por identidad ----------
  function parseFacetsRequest(query = {}) {
    const scope = parseEnum(scalar(query, 'scope'), STATES, 'ACTIVE', 'scope');
    const limit = parseLimit(scalar(query, 'limit'), { max: FACETS_LIMIT_MAX, dflt: FACETS_LIMIT_MAX });
    const cursor = scalar(query, 'cursor') || null;
    const qRaw = scalar(query, 'q');
    const q = qRaw === undefined ? '' : canonicalQ(qRaw);
    return Object.freeze({ scope, limit, cursor, q });
  }
  const facetDto = (f) => ({ key: f.norm_key, label: f.rep_label, count: Number(f.beat_count), representativeBeatId: f.rep_beat_id });
  async function listFacets({ userId, query = {} } = {}) {
    const req = parseFacetsRequest(query);
    return readTx(userId, async (client, lib, uid) => {
      const params = [uid, lib.active_generation_id, req.scope];
      let where = 'f.user_id = $1 AND f.generation_id = $2 AND f.scope = $3 AND f.beat_count > 0';
      if (req.q) { params.push(likePattern(req.q)); where += ` AND f.norm_key COLLATE "C" LIKE $${params.length} ESCAPE '\\'`; }
      let cur = null;
      if (req.cursor) {
        cur = verifyCursor(req.cursor, lib, uid, { scope: req.scope, limit: req.limit }, 'facets');
        if (cur.q !== req.q) throw new CatalogQueryError('CURSOR_INVALID', 400, 'cursor is invalid', { reason: 'REQUEST_MISMATCH' });
        const [c, l, k] = cur.boundary.tuple;
        params.push(c, l, k);
        const n = params.length;
        where += ` AND (f.beat_count < $${n - 2}::bigint OR (f.beat_count = $${n - 2}::bigint AND ROW(f.rep_label COLLATE ${NAME_COLLATION}, f.norm_key COLLATE "C") > ROW($${n - 1}::text COLLATE ${NAME_COLLATION}, $${n}::text COLLATE "C")))`;
      }
      const rows = (await client.query(`SELECT f.norm_key, f.rep_label, f.rep_beat_id, f.beat_count::text AS beat_count FROM catalog_facets f WHERE ${where}
        ORDER BY f.beat_count DESC, f.rep_label COLLATE ${NAME_COLLATION} ASC, f.norm_key COLLATE "C" ASC LIMIT ${req.limit + 1}`, params)).rows;
      const page = rows.slice(0, req.limit);
      const totalFacets = Number((await client.query('SELECT count(*)::text AS n FROM catalog_facets f WHERE f.user_id = $1 AND f.generation_id = $2 AND f.scope = $3 AND f.beat_count > 0', [uid, lib.active_generation_id, req.scope])).rows[0].n);
      const startOrdinal = cur ? cur.startOrdinal : 0;
      const base = { kind: 'facets', tenantId: uid, vaultId: lib.vault_id, generationId: lib.active_generation_id, era: lib.authority_era, epoch: lib.authority_epoch, revision: lib.revision,
        searchProfile: SEARCH_PROFILE, sortProfile: SORT_PROFILE, scope: req.scope, q: req.q, limit: req.limit, totalMatched: totalFacets };
      const last = page[page.length - 1];
      return { items: page.map(facetDto), startOrdinal, totalFacets, revision: lib.revision, epoch: lib.authority_epoch, authorityEra: lib.authority_era,
        nextCursor: rows.length > req.limit ? signer.sign({ ...base, direction: 'forward', boundary: { tuple: [last.beat_count, last.rep_label, last.norm_key], inclusive: false }, startOrdinal: startOrdinal + page.length }) : null };
    });
  }
  async function activeFacets({ userId, keys = [] } = {}, scope = 'ACTIVE') {
    if (!Array.isArray(keys) || keys.length > FACETS_LIMIT_MAX || keys.some((k) => typeof k !== 'string')) throw inputInvalid('FACET_KEYS');
    if (!STATES.includes(scope)) throw inputInvalid('ENUM', { param: 'scope' });
    return readTx(userId, async (client, lib, uid) => {
      const rows = (await client.query('SELECT f.norm_key, f.rep_label, f.rep_beat_id, f.beat_count::text AS beat_count FROM catalog_facets f WHERE f.user_id = $1 AND f.generation_id = $2 AND f.scope = $3 AND f.norm_key = ANY($4::text[])', [uid, lib.active_generation_id, scope, [...new Set(keys)]])).rows;
      return { items: rows.map(facetDto), missing: keys.filter((k) => !rows.some((r) => r.norm_key === k)), revision: lib.revision };
    });
  }

  // ---------- Conjuntos de consulta (C12-r4 §3; V02-B paso 5). Escrituras breves; sin scheduling (T10). ----------
  const SET_SQL = `SELECT s.set_id, s.generation_id, s.authority_era::text AS authority_era, s.authority_epoch::text AS authority_epoch, s.scope, s.predicate_json, s.predicate_hash,
    s.base_revision::text AS base_revision, s.status, s.member_count::text AS member_count, s.frontier_beat_id, s.checkpoint_seq::text AS checkpoint_seq, s.error_code, s.created_at, s.updated_at
    FROM catalog_query_sets s WHERE s.user_id = $1 AND s.set_id = $2`;
  const setDto = (s) => ({ setId: s.set_id, status: s.status, scope: s.scope, generationId: s.generation_id, authorityEra: s.authority_era, epoch: s.authority_epoch,
    baseRevision: s.base_revision, memberCount: Number(s.member_count), checkpointSeq: Number(s.checkpoint_seq), predicateHash: s.predicate_hash, errorCode: s.error_code });
  function predicateOf(filters) {
    const p = { version: 1, searchProfile: SEARCH_PROFILE, state: filters.state, q: filters.q, includeMode: filters.includeMode, include: filters.includeTags, exclude: filters.excludeTags };
    const json = canonicalJson(p);
    if (Buffer.byteLength(json, 'utf8') > PREDICATE_MAX_BYTES) throw new CatalogQueryError('QUERY_SET_PREDICATE_TOO_LARGE', 413, 'query-set predicate exceeds 8 KiB', { max_bytes: PREDICATE_MAX_BYTES });
    return { json, hash: filterHashOf(filters), filters: p };
  }
  async function writeTx(userId, fn) {
    const uid = requireUserId(userId);
    await authority.availability();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        const lib = (await client.query(LIB_SQL, [uid])).rows[0] || null;
        if (!lib || lib.authority !== 'POSTGRES' || !lib.active_generation_id) { await client.query('ROLLBACK'); await authority.resolveContext({ userId: uid }); throw unavailable('CONTEXT_RACE'); }
        const out = await fn(client, lib, uid);
        await client.query('COMMIT');
        return out;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    } catch (error) { throw sqlError(error); } finally { client.release(); }
  }
  async function createQuerySet({ userId, query = {}, consumer = {} } = {}) {
    const req = parseListRequest({ ...query, cursor: undefined, edge: undefined, limit: undefined, includeTotal: undefined, sort: undefined });
    const { json, hash } = predicateOf(req);
    const consumerId = typeof consumer.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(consumer.id) ? consumer.id : null;
    const consumerKind = ['SELECTION', 'SHUFFLE', 'OPERATION', 'BUILD'].includes(consumer.kind) ? consumer.kind : null;
    if (!consumerId || !consumerKind) throw inputInvalid('CONSUMER');
    return writeTx(userId, async (client, lib, uid) => {
      const reuse = (await client.query(`SELECT set_id FROM catalog_query_sets WHERE user_id = $1 AND generation_id = $2 AND predicate_hash = $3 AND base_revision = $4::bigint AND status IN ('BUILDING', 'READY')`,
        [uid, lib.active_generation_id, hash, lib.revision])).rows[0];
      let setId = reuse ? reuse.set_id : null; let created = false;
      if (!setId) {
        // Un BUILDING por biblioteca (índice único parcial de 0026). Pre-comprobación + SAVEPOINT: una carrera 23505 no aborta la transacción.
        const busy = (await client.query("SELECT set_id FROM catalog_query_sets WHERE user_id = $1 AND status = 'BUILDING'", [uid])).rows[0];
        if (busy) throw new CatalogQueryError('QUERY_SET_BUILDING_BUSY', 409, 'another query set is already building for this library', { set_id: busy.set_id });
        setId = `qs-${randomUUID()}`;
        await client.query('SAVEPOINT qs_insert');
        try {
          await client.query(`INSERT INTO catalog_query_sets(user_id, set_id, generation_id, authority_era, authority_epoch, scope, predicate_json, predicate_version, predicate_hash, base_revision, status)
            VALUES ($1, $2, $3, $4::uuid, $5::bigint, $6, $7, 1, $8, $9::bigint, 'BUILDING')`, [uid, setId, lib.active_generation_id, lib.authority_era, lib.authority_epoch, req.state, json, hash, lib.revision]);
          created = true;
        } catch (error) {
          if (error?.code !== '23505') throw error;
          await client.query('ROLLBACK TO SAVEPOINT qs_insert');
          throw new CatalogQueryError('QUERY_SET_BUILDING_BUSY', 409, 'another query set is already building for this library', { set_id: null, race: true });
        }
      }
      // T10: la construcción la programa el worker (job idempotente por set); la lectura de Gallery no espera a READY (r4 §3).
      if (created) await client.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) DO NOTHING`, [`job-qs-${setId}`, uid, 'QUERY_SET_BUILD', null, canonicalJson({ setId })]);
      await client.query(`INSERT INTO catalog_query_set_leases(user_id, set_id, consumer_id, consumer_kind, lease_until) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5::int))
        ON CONFLICT (user_id, set_id, consumer_id) DO UPDATE SET lease_until = EXCLUDED.lease_until, consumer_kind = EXCLUDED.consumer_kind`, [uid, setId, consumerId, consumerKind, LEASE_MINUTES]);
      const s = (await client.query(SET_SQL, [uid, setId])).rows[0];
      return { ...setDto(s), created, reused: !created, revision: lib.revision };
    });
  }
  // Un paso de construcción: ≤ batch miembros en orden manual, checkpoint atómico; READY bajo lock breve de biblioteca con revisión re-comprobada.
  async function stepQuerySet({ userId, setId, batch = QUERY_SET_BATCH_MAX } = {}) {
    if (!Number.isInteger(batch) || batch < 1 || batch > QUERY_SET_BATCH_MAX) throw inputInvalid('BATCH', { max: QUERY_SET_BATCH_MAX });
    if (typeof setId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(setId)) throw inputInvalid('SET_ID');
    return writeTx(userId, async (client, lib, uid) => {
      const s = (await client.query(`${SET_SQL} FOR UPDATE OF s`, [uid, setId])).rows[0];
      if (!s) throw new CatalogQueryError('NOT_FOUND', 404, 'query set is not accessible', {});
      if (s.status !== 'BUILDING') return { ...setDto(s), advanced: 0 };
      const contextChanged = s.generation_id !== lib.active_generation_id || s.authority_era !== lib.authority_era || s.authority_epoch !== lib.authority_epoch || s.base_revision !== lib.revision;
      if (contextChanged) {
        await client.query("UPDATE catalog_query_sets SET status = 'STALE', updated_at = now() WHERE user_id = $1 AND set_id = $2", [uid, setId]);
        return { ...setDto(s), status: 'STALE', advanced: 0 };
      }
      const pred = JSON.parse(s.predicate_json);
      const filters = { state: pred.state, q: pred.q, includeMode: pred.includeMode, includeTags: pred.include, excludeTags: pred.exclude };
      const params = [uid, s.generation_id, filters.state];
      const splan = filters.q ? await planSearch(client, uid, s.generation_id, filters.state, filters.q) : { mode: null };
      let where = `b.user_id = $1 AND b.generation_id = $2 AND b.state = $3${filterSql(filters, params, splan.mode)}`;
      if (s.frontier_beat_id) {
        const fr = (await client.query('SELECT manual_rank::text AS r FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, s.generation_id, s.frontier_beat_id])).rows[0];
        if (!fr) throw new CatalogQueryError('QUERY_SET_FRONTIER_LOST', 409, 'query-set frontier beat no longer exists in the generation', { set_id: setId });
        params.push(fr.r, s.frontier_beat_id);
        where += ` AND ROW(b.manual_rank, b.beat_id COLLATE "C") > ROW($${params.length - 1}::numeric, $${params.length}::text COLLATE "C")`;
      }
      const rows = (await client.query(`SELECT b.beat_id, b.version::text AS version FROM catalog_beats b WHERE ${where} ORDER BY b.manual_rank, b.beat_id COLLATE "C" LIMIT ${batch + 1}`, params)).rows;
      const more = rows.length > batch;
      const take = rows.slice(0, batch);
      const start = Number(s.member_count);
      if (take.length) {
        const values = take.map((_, i) => `($1, $2, $${4 + i * 3}::bigint, $3, $${5 + i * 3}, $${6 + i * 3}::bigint)`).join(', ');
        const p = [uid, setId, s.generation_id];
        take.forEach((r, i) => p.push(String(start + i), r.beat_id, r.version));
        await client.query(`INSERT INTO catalog_query_members(user_id, set_id, slot, generation_id, beat_id, expected_version) VALUES ${values}`, p);
      }
      let status = 'BUILDING';
      if (!more) {
        // Publicación READY: lock breve de la biblioteca y revisión re-comprobada en ese instante.
        const locked = (await client.query('SELECT revision::text AS revision FROM catalog_libraries WHERE user_id = $1 FOR UPDATE', [uid])).rows[0];
        status = locked && locked.revision === s.base_revision ? 'READY' : 'STALE';
      }
      await client.query(`UPDATE catalog_query_sets SET member_count = $3::bigint, frontier_beat_id = $4, checkpoint_seq = checkpoint_seq + 1, status = $5, updated_at = now() WHERE user_id = $1 AND set_id = $2`,
        [uid, setId, String(start + take.length), take.length ? take[take.length - 1].beat_id : s.frontier_beat_id, status]);
      const after = (await client.query(SET_SQL, [uid, setId])).rows[0];
      return { ...setDto(after), advanced: take.length };
    });
  }
  async function getQuerySet({ userId, setId } = {}) {
    if (typeof setId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(setId)) throw inputInvalid('SET_ID');
    return readTx(userId, async (client, lib, uid) => {
      const s = (await client.query(SET_SQL, [uid, setId])).rows[0];
      if (!s) throw new CatalogQueryError('NOT_FOUND', 404, 'query set is not accessible', {});
      const leases = (await client.query('SELECT count(*)::int AS n FROM catalog_query_set_leases WHERE user_id = $1 AND set_id = $2 AND lease_until > now()', [uid, setId])).rows[0].n;
      return { ...setDto(s), activeLeases: leases, currentRevision: lib.revision, stale: s.status === 'READY' && s.base_revision !== lib.revision };
    });
  }
  async function transitionQuerySet({ userId, setId, to } = {}) {
    if (typeof setId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(setId)) throw inputInvalid('SET_ID');
    if (!['CANCELLED', 'RELEASED'].includes(to)) throw inputInvalid('TRANSITION');
    return writeTx(userId, async (client, _lib, uid) => {
      const s = (await client.query(`${SET_SQL} FOR UPDATE OF s`, [uid, setId])).rows[0];
      if (!s) throw new CatalogQueryError('NOT_FOUND', 404, 'query set is not accessible', {});
      const ok = to === 'CANCELLED' ? s.status === 'BUILDING' : ['READY', 'STALE', 'FAILED', 'CANCELLED'].includes(s.status);
      if (!ok) {
        if (s.status === to) return { ...setDto(s), changed: false };
        throw new CatalogQueryError('QUERY_SET_TRANSITION_INVALID', 409, `query set ${s.status} cannot become ${to}`, { status: s.status });
      }
      await client.query('UPDATE catalog_query_sets SET status = $3, updated_at = now() WHERE user_id = $1 AND set_id = $2', [uid, setId, to]);
      if (to === 'RELEASED') await client.query('DELETE FROM catalog_query_set_leases WHERE user_id = $1 AND set_id = $2', [uid, setId]);
      const after = (await client.query(SET_SQL, [uid, setId])).rows[0];
      return { ...setDto(after), changed: true };
    });
  }

  return Object.freeze({
    signer, keySource: keyring.source, parseListRequest, parseFacetsRequest, filterHashOf, listBeats, getBeat, listBeatFiles, resolveLegacyNavigation, listFacets, activeFacets,
    createQuerySet, stepQuerySet, getQuerySet, cancelQuerySet: (a) => transitionQuerySet({ ...a, to: 'CANCELLED' }), releaseQuerySet: (a) => transitionQuerySet({ ...a, to: 'RELEASED' }),
    limits: Object.freeze({ LIMIT_DEFAULT, LIMIT_MAX, FILES_LIMIT_MAX, FACETS_LIMIT_MAX, QUERY_SET_BATCH_MAX, Q_MAX_BYTES, PAGE_MAX_BYTES, STATEMENT_TIMEOUT_MS, API_TIMEOUT_MS, LEGACY_OFFSET_MAX, LEGACY_BLOCK }),
  });
}

// Singleton para server-core (mismo patrón que authority.configureCatalogAuthority).
let configured = null;
function configureCatalogQueries(options = null) {
  configured = options && options.pool && options.authority ? createCatalogQueries(options) : null;
  return configured;
}
function currentCatalogQueries() { return configured; }

module.exports = {
  LIMIT_DEFAULT, LIMIT_MAX, FILES_LIMIT_MAX, FACETS_LIMIT_MAX, QUERY_SET_BATCH_MAX, Q_MAX_BYTES, PAGE_MAX_BYTES, STATEMENT_TIMEOUT_MS, API_TIMEOUT_MS, LEGACY_OFFSET_MAX, LEGACY_BLOCK,
  SORT_PROFILE, SEARCH_PROFILE, NAME_COLLATION, STATES, SORTS, INCLUDE_MODES, TUPLES,
  CatalogQueryError, parseListRequest, filterHashOf, canonicalQ, likePattern, searchMode, planSearch, GRAM_GIN_MAX, filterSql, byteSort, createCatalogQueries, configureCatalogQueries, currentCatalogQueries,
};
