'use strict';
// T07 — Mutaciones del catálogo (CONTRATO C5/C6, C12-r4 §4 selección/bulk y §6 rename, NATIVO r2.1 §7).
//  - Toda mutación: validar antes de BEGIN → catalog_libraries FOR UPDATE → autoridad POSTGRES / IDLE / era+época → idempotencia
//    (clave por usuario; mismo contenido → resultado persistido, distinto → 409 IDEMPOTENCY_MISMATCH) → beats FOR UPDATE en orden de
//    beat_id → versión y estado → cambio → version+1, revision+1, evento, resultado → COMMIT. Sin red, sin Telegram, sin ID3.
//  - PATCH edita un beat (documento canónico v2 + proyecciones + tags + grupos/facetas). Un no-op con la misma intención no suma
//    versión ni revisión y persiste su resultado. Trash/restore: lote ≤50 atómico (todo o nada ante un conflicto).
//  - Selección server-side (CAS selection_version + idempotencyKey), rangos inclusivos evaluados con el sort de creación.
//  - Operaciones bulk/rename por lotes ≤50 invocables (stepOperation); journal + checkpoint + avance de revisión en la misma transacción;
//    una escritura externa (revisión distinta de la esperada) detiene el siguiente lote con CONFLICT conservando lo confirmado.
// El scheduling durable de los pasos es T10; aquí los pasos son funciones de módulo.

const crypto = require('crypto');
const { requireUserId } = require('./contract');
const { canonicalJson, CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');
const codec = require('./legacy-codec');
const rules = require('./metadata-rules');
const { TUPLES, SORTS, STATEMENT_TIMEOUT_MS } = require('./queries');

const BATCH_MAX = 50;
const BODY_METADATA_BYTES = 64 * 1024;
const BODY_BATCH_BYTES = 256 * 1024;
const TRASH_RETENTION_DAYS = 14;
const RANK_STEP = 1000n;
const EVENTS_PAGE_MAX = 240;
const EVENTS_RETENTION = 10000;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BULK_KINDS = Object.freeze(['BULK_PATCH', 'BULK_TRASH', 'BULK_RESTORE']);

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const notFound = (what) => new CatalogQueryError('NOT_FOUND', 404, `${what} is not accessible`, {});
const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sqlError = (error) => {
  if (error instanceof CatalogAuthorityError) return error;
  if (error?.code === '57014') return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog statement timed out', { sqlstate: '57014' });
  if (error?.code === 'BGL01' || error?.code === 'BGN04' || error?.code === 'BGA05') return new CatalogQueryError('CATALOG_NATIVE_RULE', 409, 'database native rule rejected the mutation', { sqlstate: error.code, detail: error.detail || null });
  return new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog is unavailable (SQL_ERROR)', { reason: 'SQL_ERROR', sqlstate: error?.code || null, sql_message: error?.code ? String(error.message).slice(0, 200) : null });
};

// ---------- documento canónico v2 y proyecciones (codec T04) ----------
const DOC_KEYS = Object.freeze({ name: 'name', bpm: 'bpm', key: 'key', tags: 'tags', rating: 'rating', color: 'color', color2: 'color2', crop: 'image_crop' });
function applyPatchToDoc(doc, set) {
  const out = { ...doc };
  for (const [field, value] of Object.entries(set)) out[DOC_KEYS[field]] = field === 'tags' ? [...value] : field === 'crop' ? (value === null ? null : { ...value }) : value;
  return out;
}
function docChanged(before, after) { return codec.deepDiff(before, after).length > 0; }
function beatRowsFromDoc(doc) {
  const p = codec.projectBeat(doc);
  const legacyJson = JSON.stringify(doc);
  return { p, legacyJson, legacySha256: sha256Hex(legacyJson), legacyExportBytes: Buffer.byteLength(legacyJson, 'utf8') };
}
const BEAT_UPDATE_SQL = `UPDATE catalog_beats SET name = $4, bpm_text = $5, key_text = $6, rating = $7, color = $8, color2 = $9, bpm_sort_class = $10, bpm_sort = $11,
    has_artwork = $12, legacy_json = $13, legacy_sha256 = $14, legacy_export_bytes = $15, name_display = $16, name_search = $17, key_display = $18, key_search = $19,
    bpm_display = $20, rating_display = $21, version = version + 1, updated_at = now()
  WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 RETURNING version::text AS version`;
async function writeBeatDoc(client, uid, gen, beatId, doc) {
  const { p, legacyJson, legacySha256, legacyExportBytes } = beatRowsFromDoc(doc);
  const r = await client.query(BEAT_UPDATE_SQL, [uid, gen, beatId, p.name, p.bpmText, p.keyText, p.rating, p.color, p.color2, p.bpmSortClass, p.bpmSort, p.hasArtwork,
    legacyJson, legacySha256, legacyExportBytes, p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay]);
  await client.query('DELETE FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, beatId]);
  await client.query('DELETE FROM catalog_beat_tags WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, beatId]);
  for (const t of p.tags) await client.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uid, gen, beatId, t.position, t.label, t.normKey, t.searchKey]);
  return { version: r.rows[0].version, normKeys: [...new Set(p.tags.map((t) => t.normKey))] };
}
// Grupos (una fila por beat y norm_key) y facetas de las claves afectadas, en ambos scopes, dentro de la transacción.
async function refreshGroupsAndFacets(client, uid, gen, beatIds, normKeys, revision) {
  if (beatIds.length) {
    await client.query('DELETE FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND beat_id = ANY($3::text[])', [uid, gen, beatIds]);
    await client.query(`INSERT INTO catalog_beat_tag_groups(user_id, generation_id, beat_id, norm_key, projection_version, state, manual_rank, first_position, label_at_first_position)
      SELECT DISTINCT ON (t.beat_id, t.norm_key) t.user_id, t.generation_id, t.beat_id, t.norm_key, t.projection_version, b.state, b.manual_rank, t.position, t.label
      FROM catalog_beat_tags t JOIN catalog_beats b USING (user_id, generation_id, beat_id)
      WHERE t.user_id = $1 AND t.generation_id = $2 AND t.beat_id = ANY($3::text[]) ORDER BY t.beat_id, t.norm_key, t.position`, [uid, gen, beatIds]);
  }
  const keys = [...new Set(normKeys)];
  if (!keys.length) return;
  await client.query('DELETE FROM catalog_facets WHERE user_id = $1 AND generation_id = $2 AND norm_key = ANY($3::text[])', [uid, gen, keys]);
  await client.query(`WITH grp AS (SELECT * FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND norm_key = ANY($3::text[]) AND state IN ('ACTIVE','TRASH')),
    cnt AS (SELECT state, norm_key, projection_version, count(*) AS n FROM grp GROUP BY 1, 2, 3),
    rep AS (SELECT DISTINCT ON (state, norm_key, projection_version) state, norm_key, projection_version, beat_id, first_position, label_at_first_position
            FROM grp ORDER BY state, norm_key, projection_version, manual_rank, beat_id COLLATE "C")
    INSERT INTO catalog_facets(user_id, generation_id, scope, norm_key, projection_version, beat_count, rep_beat_id, rep_position, rep_label, updated_revision)
    SELECT $1, $2, c.state, c.norm_key, c.projection_version, c.n, r.beat_id, r.first_position, r.label_at_first_position, $4::bigint
    FROM cnt c JOIN rep r USING (state, norm_key, projection_version)`, [uid, gen, keys, revision]);
}
async function normKeysOf(client, uid, gen, beatIds) {
  if (!beatIds.length) return [];
  return (await client.query('SELECT DISTINCT norm_key FROM catalog_beat_tags WHERE user_id = $1 AND generation_id = $2 AND beat_id = ANY($3::text[])', [uid, gen, beatIds])).rows.map((r) => r.norm_key);
}

// ---------- transacción de mutación ----------
function createCatalogCommands({ pool = null, authority = null, now = () => new Date(), randomUUID = () => crypto.randomUUID() } = {}) {
  if (!authority || typeof authority.requireLibraryForMutation !== 'function') throw new Error('createCatalogCommands requires the catalog authority');

  // Lock de biblioteca + autoridad/era/época (authority.requireLibraryForMutation) + IDLE; devuelve lib con revision actual.
  async function mutationTx(userId, { era, epoch }, fn) {
    const uid = requireUserId(userId);
    await authority.availability();
    if (!pool || typeof pool.connect !== 'function') throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog is unavailable (POSTGRES_UNAVAILABLE)', { reason: 'POSTGRES_UNAVAILABLE' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        const q = await client.query('SELECT 1 FROM control_plane_flush_quarantine WHERE user_id = $1 AND resolved_at IS NULL LIMIT 1', [uid]);
        if (q.rows.length) throw new CatalogAuthorityError('VAULT_QUARANTINED', 409, 'vault is quarantined by the control-plane flush', {});
        const ctx = await authority.requireLibraryForMutation(client, { userId: uid, era, epoch }); // FOR UPDATE de catalog_libraries
        if (ctx.migration_state !== 'IDLE') throw new CatalogQueryError('LIBRARY_FROZEN', 409, 'library is not accepting mutations', { migration_state: ctx.migration_state });
        const out = await fn(client, ctx, uid);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        // Un error con `commit` confirma lo escrito antes de propagarse (marcar CONFLICT en la selección debe sobrevivir al rechazo).
        if (error && error.commit === true) await client.query('COMMIT').catch(() => {}); else await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } catch (error) { throw sqlError(error); } finally { client.release(); }
  }
  async function bumpRevision(client, uid, delta = { active: 0, trash: 0 }) {
    const r = await client.query(`UPDATE catalog_libraries SET revision = revision + 1, active_count = active_count + $2, trash_count = trash_count + $3, updated_at = now()
      WHERE user_id = $1 RETURNING revision::text AS revision`, [uid, delta.active, delta.trash]);
    return r.rows[0].revision;
  }
  async function emitEvent(client, uid, gen, revision, kind, { beatId = null, version = null, operationId = null, payload = {} } = {}) {
    const seq = (await client.query('SELECT coalesce(max(event_seq), 0) + 1 AS seq FROM catalog_events WHERE user_id = $1', [uid])).rows[0].seq;
    await client.query('INSERT INTO catalog_events(user_id, event_seq, generation_id, revision, kind, beat_id, version, operation_id, payload_json) VALUES ($1,$2,$3,$4::bigint,$5,$6,$7::bigint,$8,$9)',
      [uid, seq, gen, revision, kind, beatId, version, operationId, canonicalJson(payload)]);
    return String(seq);
  }
  // Idempotencia C5: misma clave y mismo hash → resultado persistido; distinto → 409 sin efectos.
  async function idempotency(client, uid, key, hash) {
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_RE.test(key)) throw inputInvalid('IDEMPOTENCY_KEY');
    const r = (await client.query('SELECT operation_id, request_hash, result_json, status FROM catalog_operations WHERE user_id = $1 AND idempotency_key = $2', [uid, key])).rows[0];
    if (!r) return null;
    if (r.request_hash !== hash) throw new CatalogQueryError('IDEMPOTENCY_MISMATCH', 409, 'idempotency key was used with a different request', { operation_id: r.operation_id });
    return { replay: true, operationId: r.operation_id, result: r.result_json ? JSON.parse(r.result_json) : null, status: r.status };
  }
  async function recordOperation(client, uid, ctx, { kind, key, hash, payload, result, status = 'COMPLETED', extra = {} }) {
    const operationId = `op-${randomUUID()}`;
    await client.query(`INSERT INTO catalog_operations(user_id, operation_id, generation_id, authority_era, authority_epoch, kind, idempotency_key, request_hash, payload_json, result_json, status,
        set_id, selection_id, selection_version, expected_revision, total_frozen, frontier_beat_id, completed_at)
      VALUES ($1, $2, $3, $4::uuid, $5::bigint, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::bigint, $16::bigint, $17, CASE WHEN $11 IN ('COMPLETED','PARTIAL','CANCELLED') THEN now() ELSE NULL END)`,
      [uid, operationId, ctx.generation_id, ctx.authority_era, ctx.authority_epoch, kind, key, hash, canonicalJson(payload), result ? canonicalJson(result) : null, status,
        extra.setId || null, extra.selectionId || null, extra.selectionVersion ?? null, extra.expectedRevision ?? null, extra.totalFrozen ?? 0, extra.frontierBeatId || null]);
    return operationId;
  }
  const beatDto = async (client, uid, gen, beatId) => {
    const r = (await client.query(`SELECT b.beat_id AS id, b.version::text AS version, b.state, b.name_display AS name, b.bpm_display AS bpm, b.key_display AS key, b.rating_display AS rating, b.color, b.color2, b.has_artwork,
        (SELECT coalesce(array_agg(t.label ORDER BY t.position), '{}') FROM catalog_beat_tags t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id) AS tags
      FROM catalog_beats b WHERE b.user_id = $1 AND b.generation_id = $2 AND b.beat_id = $3`, [uid, gen, beatId])).rows[0];
    return r ? { id: r.id, version: r.version, state: r.state, name: r.name, bpm: r.bpm, key: r.key, tags: r.tags, rating: r.rating, color: r.color, color2: r.color2, hasArtwork: r.has_artwork } : null;
  };
  const lockBeats = async (client, uid, gen, beatIds) => (await client.query(`SELECT beat_id, state, version::text AS version, legacy_json, manual_rank::text AS manual_rank FROM catalog_beats
      WHERE user_id = $1 AND generation_id = $2 AND beat_id = ANY($3::text[]) ORDER BY beat_id COLLATE "C" FOR UPDATE`, [uid, gen, beatIds])).rows;

  // ---------- PATCH /catalog/v1/beats/:id ----------
  async function patchBeat({ userId, beatId, era, epoch, idempotencyKey, expectedVersion, ifMatch = null, patch } = {}) {
    if (typeof beatId !== 'string' || !beatId) throw inputInvalid('BEAT_ID');
    if (Buffer.byteLength(JSON.stringify(patch ?? null), 'utf8') > BODY_METADATA_BYTES) throw new CatalogQueryError('PAYLOAD_TOO_LARGE', 413, 'patch exceeds 64 KiB', { max_bytes: BODY_METADATA_BYTES });
    const v = rules.validatePatch(patch);
    if (!v.ok) throw inputInvalid('PATCH', { errors: v.errors });
    const expected = parseVersion(expectedVersion, ifMatch);
    const payload = { kind: 'PATCH', target: beatId, patch: v.set, expectedVersion: expected };
    const hash = sha256Hex(canonicalJson(payload));
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const gen = ctx.generation_id;
      const replay = await idempotency(client, uid, idempotencyKey, hash);
      if (replay) return { ...replay.result, replay: true, operationId: replay.operationId };
      const [row] = await lockBeats(client, uid, gen, [beatId]);
      if (!row || !['ACTIVE', 'TRASH'].includes(row.state)) throw notFound('beat');
      if (row.state !== 'ACTIVE') throw new CatalogQueryError('BEAT_NOT_ACTIVE', 409, 'only ACTIVE beats can be edited', { state: row.state });
      if (row.version !== expected) throw new CatalogQueryError('VERSION_CONFLICT', 409, 'beat version does not match', { current_version: row.version, expected_version: expected });
      const before = JSON.parse(row.legacy_json);
      const after = applyPatchToDoc(before, v.set);
      let result;
      if (!docChanged(before, after)) {
        result = { noop: true, beat: await beatDto(client, uid, gen, beatId), revision: ctx.revision };
      } else {
        const oldKeys = await normKeysOf(client, uid, gen, [beatId]);
        const { version, normKeys } = await writeBeatDoc(client, uid, gen, beatId, after);
        const revision = await bumpRevision(client, uid);
        await refreshGroupsAndFacets(client, uid, gen, [beatId], [...oldKeys, ...normKeys], revision);
        const eventSeq = await emitEvent(client, uid, gen, revision, 'BEAT_PATCHED', { beatId, version, payload: { fields: Object.keys(v.set) } });
        result = { noop: false, beat: await beatDto(client, uid, gen, beatId), revision, eventSeq };
      }
      const operationId = await recordOperation(client, uid, ctx, { kind: 'PATCH', key: idempotencyKey, hash, payload, result });
      return { ...result, replay: false, operationId };
    });
  }
  function parseVersion(expectedVersion, ifMatch) {
    const fromHeader = ifMatch == null ? null : (/^W\/"[0-9]+-([0-9]+)"$/.exec(String(ifMatch)) || [])[1] || null;
    const fromBody = expectedVersion == null ? null : String(expectedVersion);
    if (fromBody !== null && !/^[1-9][0-9]{0,17}$/.test(fromBody)) throw inputInvalid('EXPECTED_VERSION');
    if (fromHeader !== null && fromBody !== null && fromHeader !== fromBody) throw inputInvalid('IF_MATCH_MISMATCH');
    const v = fromBody ?? fromHeader;
    if (v === null) throw new CatalogQueryError('PRECONDITION_REQUIRED', 428, 'expectedVersion (or If-Match) is required', {});
    return v;
  }

  // ---------- trash / restore (lote ≤50 atómico) ----------
  function parseBatch(items) {
    if (!Array.isArray(items) || items.length < 1) throw inputInvalid('BATCH_EMPTY');
    if (items.length > BATCH_MAX) throw inputInvalid('BATCH_TOO_LARGE', { max: BATCH_MAX });
    if (Buffer.byteLength(JSON.stringify(items), 'utf8') > BODY_BATCH_BYTES) throw new CatalogQueryError('PAYLOAD_TOO_LARGE', 413, 'batch exceeds 256 KiB', { max_bytes: BODY_BATCH_BYTES });
    const out = []; const seen = new Set();
    for (const it of items) {
      if (!it || typeof it.beatId !== 'string' || !it.beatId) throw inputInvalid('BATCH_ITEM');
      const ev = String(it.expectedVersion ?? '');
      if (!/^[1-9][0-9]{0,17}$/.test(ev)) throw inputInvalid('EXPECTED_VERSION', { beatId: it.beatId });
      if (seen.has(it.beatId)) throw inputInvalid('BATCH_DUPLICATE', { beatId: it.beatId });
      seen.add(it.beatId); out.push({ beatId: it.beatId, expectedVersion: ev });
    }
    return out.sort((a, b) => Buffer.compare(Buffer.from(a.beatId), Buffer.from(b.beatId)));
  }
  async function trashOne(client, uid, gen, row) {
    const pos = (await client.query('SELECT coalesce(max(export_position), -1) + 1 AS p FROM catalog_trash_entries WHERE user_id = $1 AND generation_id = $2', [uid, gen])).rows[0].p;
    const trashId = `trash-${randomUUID()}`;
    const r = await client.query(`UPDATE catalog_beats SET state = 'TRASH', version = version + 1, updated_at = now() WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 RETURNING version::text AS version`, [uid, gen, row.beat_id]);
    await client.query(`INSERT INTO catalog_trash_entries(user_id, generation_id, beat_id, beat_state, wrapper_present, trash_id, trashed_at, purge_after, wrapper_json, export_position)
      VALUES ($1, $2, $3, 'TRASH', true, $4, now(), now() + make_interval(days => ${TRASH_RETENTION_DAYS}), $5, $6)`, [uid, gen, row.beat_id, trashId, canonicalJson({ trash_id: trashId }), pos]);
    return r.rows[0].version;
  }
  async function restoreOne(client, uid, gen, row) {
    const tomb = await client.query('SELECT 1 FROM catalog_tombstones WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, row.beat_id]);
    if (tomb.rows.length) throw new CatalogQueryError('PURGE_PENDING', 409, 'beat has a tombstone', { beatId: row.beat_id });
    const maxRank = (await client.query("SELECT coalesce(max(manual_rank), 0)::text AS r FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE'", [uid, gen])).rows[0].r;
    const rank = (BigInt(maxRank) + RANK_STEP).toString();
    await client.query('DELETE FROM catalog_trash_entries WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, row.beat_id]);
    const r = await client.query(`UPDATE catalog_beats SET state = 'ACTIVE', manual_rank = $4::numeric, version = version + 1, updated_at = now() WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 RETURNING version::text AS version`, [uid, gen, row.beat_id, rank]);
    return r.rows[0].version;
  }
  async function transitionBatch({ userId, era, epoch, idempotencyKey, items } = {}, mode) {
    const batch = parseBatch(items);
    const payload = { kind: mode, items: batch };
    const hash = sha256Hex(canonicalJson(payload));
    const from = mode === 'TRASH' ? 'ACTIVE' : 'TRASH';
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const gen = ctx.generation_id;
      const replay = await idempotency(client, uid, idempotencyKey, hash);
      if (replay) return { ...replay.result, replay: true, operationId: replay.operationId };
      const rows = await lockBeats(client, uid, gen, batch.map((b) => b.beatId));
      const byId = new Map(rows.map((r) => [r.beat_id, r]));
      const conflicts = [];
      for (const it of batch) {
        const row = byId.get(it.beatId);
        if (!row || row.state === 'PURGED') conflicts.push({ beatId: it.beatId, reason: 'NOT_FOUND' });
        else if (row.version !== it.expectedVersion) conflicts.push({ beatId: it.beatId, reason: 'VERSION_CONFLICT', currentVersion: row.version });
        else if (row.state !== from) conflicts.push({ beatId: it.beatId, reason: row.state === 'PURGING' ? 'PURGE_PENDING' : 'STATE_CONFLICT', state: row.state });
      }
      if (conflicts.length) throw new CatalogQueryError('VERSION_CONFLICT', 409, `${mode.toLowerCase()} batch rejected: no item was applied`, { conflicts });
      const results = [];
      for (const it of batch) {
        const version = mode === 'TRASH' ? await trashOne(client, uid, gen, byId.get(it.beatId)) : await restoreOne(client, uid, gen, byId.get(it.beatId));
        results.push({ beatId: it.beatId, version });
      }
      const n = batch.length;
      const revision = await bumpRevision(client, uid, mode === 'TRASH' ? { active: -n, trash: n } : { active: n, trash: -n });
      const keys = await normKeysOf(client, uid, gen, batch.map((b) => b.beatId));
      await refreshGroupsAndFacets(client, uid, gen, batch.map((b) => b.beatId), keys, revision);
      for (const r of results) await emitEvent(client, uid, gen, revision, mode === 'TRASH' ? 'BEAT_TRASHED' : 'BEAT_RESTORED', { beatId: r.beatId, version: r.version });
      const result = { items: results, revision };
      const operationId = await recordOperation(client, uid, ctx, { kind: mode, key: idempotencyKey, hash, payload, result });
      return { ...result, replay: false, operationId };
    });
  }
  const trashBeats = (a) => transitionBatch(a, 'TRASH');
  const restoreBeats = (a) => transitionBatch(a, 'RESTORE');

  // ---------- selección (C12-r4 §4) ----------
  const SELECTION_SQL = `SELECT s.selection_id, s.set_id, s.generation_id, s.sort, s.default_selected, s.selection_version::text AS selection_version, s.status, s.owner_consumer_id,
    s.selected_count::text AS selected_count, s.base_revision::text AS base_revision FROM catalog_selections s WHERE s.user_id = $1 AND s.selection_id = $2`;
  const selectionDto = (s, extra = {}) => ({ selectionId: s.selection_id, setId: s.set_id, sort: s.sort, defaultSelected: s.default_selected, selectionVersion: s.selection_version, status: s.status,
    count: Number(s.selected_count), baseRevision: s.base_revision, ...extra });
  // Predicado SQL "miembro m seleccionado" según el log de operaciones (última op que lo cubre, si no default). Alias m = catalog_query_members.
  function selectedPredicateSql(sort, params, selParam) {
    const tuple = TUPLES[sort].join(', ');
    const tupleOf = (alias) => TUPLES[sort].map((c) => c.replace(/\bb\./g, `${alias}.`)).join(', ');
    return `coalesce((SELECT o.kind IN ('INCLUDE_IDS', 'INCLUDE_RANGE') FROM catalog_selection_ops o
        WHERE o.user_id = m.user_id AND o.selection_id = ${selParam} AND (
          o.kind = 'CLEAR'
          OR (o.kind IN ('INCLUDE_IDS', 'EXCLUDE_IDS') AND EXISTS (SELECT 1 FROM catalog_selection_op_ids i WHERE i.user_id = o.user_id AND i.selection_id = o.selection_id AND i.op_seq = o.op_seq AND i.beat_id = m.beat_id))
          OR (o.kind IN ('INCLUDE_RANGE', 'EXCLUDE_RANGE')
              AND ROW(${tuple}) >= (SELECT ${tupleOf('f')} FROM catalog_beats f WHERE f.user_id = b.user_id AND f.generation_id = b.generation_id AND f.beat_id = o.from_beat_id)
              AND ROW(${tuple}) <= (SELECT ${tupleOf('t')} FROM catalog_beats t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = o.to_beat_id)))
        ORDER BY o.op_seq DESC LIMIT 1), s.default_selected)`;
  }
  const MEMBERS_FROM = `FROM catalog_query_members m JOIN catalog_beats b ON b.user_id = m.user_id AND b.generation_id = m.generation_id AND b.beat_id = m.beat_id
    JOIN catalog_selections s ON s.user_id = m.user_id AND s.selection_id = $2 WHERE m.user_id = $1 AND m.set_id = s.set_id`;
  async function countSelected(client, uid, selectionId, sort) {
    const params = [uid, selectionId];
    return (await client.query(`SELECT count(*)::text AS n ${MEMBERS_FROM} AND ${selectedPredicateSql(sort, params, '$2')}`, params)).rows[0].n;
  }
  async function readTx(userId, fn) {
    const uid = requireUserId(userId);
    await authority.availability();
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try { await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`); return await fn(client, uid); } finally { await client.query('COMMIT').catch(() => {}); }
    } catch (error) { throw sqlError(error); } finally { client.release(); }
  }
  async function createSelection({ userId, era, epoch, setId, sort = 'rating', defaultSelected = false, consumerId } = {}) {
    if (typeof setId !== 'string' || !ID_RE.test(setId)) throw inputInvalid('SET_ID');
    if (!SORTS.includes(sort)) throw inputInvalid('ENUM', { param: 'sort' });
    if (typeof defaultSelected !== 'boolean') throw inputInvalid('DEFAULT_SELECTED');
    if (typeof consumerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(consumerId)) throw inputInvalid('CONSUMER');
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const set = (await client.query("SELECT status, generation_id, base_revision::text AS base_revision FROM catalog_query_sets WHERE user_id = $1 AND set_id = $2", [uid, setId])).rows[0];
      if (!set) throw notFound('query set');
      if (set.status !== 'READY' || set.generation_id !== ctx.generation_id || set.base_revision !== ctx.revision) throw new CatalogQueryError('CURSOR_STALE', 409, 'query set is not READY for the current revision', { set_status: set.status, set_revision: set.base_revision, current_revision: ctx.revision });
      const selectionId = `sel-${randomUUID()}`;
      await client.query(`INSERT INTO catalog_selections(user_id, selection_id, set_id, generation_id, sort, default_selected, owner_consumer_id, base_revision, selected_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, CASE WHEN $6 THEN (SELECT member_count FROM catalog_query_sets WHERE user_id = $1 AND set_id = $3) ELSE 0 END)`, [uid, selectionId, setId, ctx.generation_id, sort, defaultSelected, consumerId, ctx.revision]);
      const s = (await client.query(SELECTION_SQL, [uid, selectionId])).rows[0];
      return selectionDto(s, { created: true });
    });
  }
  async function applySelectionOp({ userId, era, epoch, selectionId, selectionVersion, idempotencyKey, op } = {}) {
    if (typeof selectionId !== 'string' || !ID_RE.test(selectionId)) throw inputInvalid('SELECTION_ID');
    if (!/^[0-9]{1,18}$/.test(String(selectionVersion ?? ''))) throw inputInvalid('SELECTION_VERSION');
    if (!op || !['INCLUDE_IDS', 'EXCLUDE_IDS', 'INCLUDE_RANGE', 'EXCLUDE_RANGE', 'CLEAR'].includes(op.kind)) throw inputInvalid('SELECTION_OP');
    const ids = op.kind.endsWith('_IDS') ? op.beatIds : [];
    if (op.kind.endsWith('_IDS') && (!Array.isArray(ids) || ids.length < 1 || ids.length > BATCH_MAX || ids.some((x) => typeof x !== 'string' || !x) || new Set(ids).size !== ids.length)) throw inputInvalid('SELECTION_IDS', { max: BATCH_MAX });
    if (op.kind.endsWith('_RANGE') && (typeof op.fromBeatId !== 'string' || typeof op.toBeatId !== 'string' || !op.fromBeatId || !op.toBeatId)) throw inputInvalid('SELECTION_RANGE');
    const payload = { kind: 'SELECTION_OP', selectionId, selectionVersion: String(selectionVersion), op: { kind: op.kind, beatIds: ids.length ? [...ids].sort() : undefined, fromBeatId: op.fromBeatId, toBeatId: op.toBeatId } };
    const hash = sha256Hex(canonicalJson(payload));
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) throw inputInvalid('IDEMPOTENCY_KEY');
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const s = (await client.query(`${SELECTION_SQL} FOR UPDATE OF s`, [uid, selectionId])).rows[0];
      if (!s) throw notFound('selection');
      const prior = (await client.query('SELECT op_seq::text AS op_seq, request_hash FROM catalog_selection_ops WHERE user_id = $1 AND selection_id = $2 AND idempotency_key = $3', [uid, selectionId, idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) throw new CatalogQueryError('IDEMPOTENCY_MISMATCH', 409, 'idempotency key was used with a different request', {});
        return selectionDto(s, { replay: true });
      }
      if (s.status !== 'ACTIVE') throw new CatalogQueryError('SELECTION_CONFLICT', 409, `selection is ${s.status}`, { status: s.status });
      if (s.base_revision !== ctx.revision) {
        await client.query("UPDATE catalog_selections SET status = 'CONFLICT', updated_at = now() WHERE user_id = $1 AND selection_id = $2", [uid, selectionId]);
        throw Object.assign(new CatalogQueryError('SELECTION_CONFLICT', 409, 'library revision changed since the selection was created', { base_revision: s.base_revision, current_revision: ctx.revision }), { commit: true });
      }
      if (s.selection_version !== String(selectionVersion)) throw new CatalogQueryError('SELECTION_CONFLICT', 409, 'selectionVersion does not match (CAS)', { current_version: s.selection_version });
      if (op.kind.endsWith('_RANGE')) {
        const inSet = (await client.query('SELECT count(*)::int AS n FROM catalog_query_members WHERE user_id = $1 AND set_id = $2 AND beat_id = ANY($3::text[])', [uid, s.set_id, [op.fromBeatId, op.toBeatId]])).rows[0].n;
        if (inSet !== new Set([op.fromBeatId, op.toBeatId]).size) throw inputInvalid('SELECTION_RANGE_OUTSIDE_SET');
      }
      const seq = (BigInt(s.selection_version) + 1n).toString();
      // Rango: se normaliza al orden del sort (from ≤ to) en el momento de aplicar, con la tupla actual.
      let from = op.fromBeatId || null; let to = op.toBeatId || null;
      if (op.kind.endsWith('_RANGE')) {
        const tupleOf = (alias) => TUPLES[s.sort].map((c) => c.replace(/\bb\./g, `${alias}.`)).join(', ');
        const cmp = (await client.query(`SELECT ROW(${tupleOf('f')}) <= ROW(${tupleOf('t')}) AS ok FROM catalog_beats f, catalog_beats t
          WHERE f.user_id = $1 AND f.generation_id = $2 AND f.beat_id = $3 AND t.user_id = $1 AND t.generation_id = $2 AND t.beat_id = $4`, [uid, s.generation_id, from, to])).rows[0]?.ok;
        if (cmp === false) [from, to] = [to, from];
      }
      await client.query('INSERT INTO catalog_selection_ops(user_id, selection_id, op_seq, idempotency_key, request_hash, kind, from_beat_id, to_beat_id, revision) VALUES ($1,$2,$3::bigint,$4,$5,$6,$7,$8,$9::bigint)',
        [uid, selectionId, seq, idempotencyKey, hash, op.kind, from, to, ctx.revision]);
      for (const id of ids) await client.query('INSERT INTO catalog_selection_op_ids(user_id, selection_id, op_seq, beat_id) VALUES ($1,$2,$3::bigint,$4)', [uid, selectionId, seq, id]);
      if (op.kind === 'CLEAR') await client.query('UPDATE catalog_selections SET default_selected = false WHERE user_id = $1 AND selection_id = $2', [uid, selectionId]);
      const count = op.kind === 'CLEAR' ? '0' : await countSelected(client, uid, selectionId, s.sort);
      await client.query('UPDATE catalog_selections SET selection_version = $3::bigint, selected_count = $4::bigint, updated_at = now() WHERE user_id = $1 AND selection_id = $2', [uid, selectionId, seq, count]);
      const after = (await client.query(SELECTION_SQL, [uid, selectionId])).rows[0];
      return selectionDto(after, { replay: false });
    });
  }
  async function getSelection({ userId, selectionId, beatIds = [] } = {}) {
    if (typeof selectionId !== 'string' || !ID_RE.test(selectionId)) throw inputInvalid('SELECTION_ID');
    if (!Array.isArray(beatIds) || beatIds.length > 240 || beatIds.some((x) => typeof x !== 'string')) throw inputInvalid('FLAGS_IDS', { max: 240 });
    return readTx(userId, async (client, uid) => {
      const s = (await client.query(SELECTION_SQL, [uid, selectionId])).rows[0];
      if (!s) throw notFound('selection');
      const lib = (await client.query('SELECT revision::text AS revision FROM catalog_libraries WHERE user_id = $1', [uid])).rows[0];
      let flags = {};
      if (beatIds.length) {
        const params = [uid, selectionId, beatIds];
        const rows = (await client.query(`SELECT m.beat_id, ${selectedPredicateSql(s.sort, params, '$2')} AS selected ${MEMBERS_FROM} AND m.beat_id = ANY($3::text[])`, params)).rows;
        flags = Object.fromEntries(beatIds.map((id) => [id, rows.find((r) => r.beat_id === id)?.selected ?? false]));
      }
      return selectionDto(s, { currentRevision: lib.revision, stale: s.base_revision !== lib.revision, flags });
    });
  }
  async function releaseSelection({ userId, era, epoch, selectionId } = {}) {
    if (typeof selectionId !== 'string' || !ID_RE.test(selectionId)) throw inputInvalid('SELECTION_ID');
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const s = (await client.query(`${SELECTION_SQL} FOR UPDATE OF s`, [uid, selectionId])).rows[0];
      if (!s) throw notFound('selection');
      if (s.status === 'FROZEN') throw new CatalogQueryError('SELECTION_CONFLICT', 409, 'selection is frozen by an operation', {});
      await client.query("UPDATE catalog_selections SET status = 'RELEASED', updated_at = now() WHERE user_id = $1 AND selection_id = $2", [uid, selectionId]);
      return selectionDto({ ...s, status: 'RELEASED' });
    });
  }

  // ---------- rename de tags (C12-r4 §6) ----------
  async function previewTagRename({ userId, from, to } = {}) {
    if (typeof from !== 'string' || !from.trim()) throw inputInvalid('RENAME_FROM');
    const target = rules.validateTag(to);
    if (!target.valid) throw inputInvalid('RENAME_TO', { reason: target.reason });
    const fromKey = rules.normalizeTag(from);
    return readTx(userId, async (client, uid) => {
      const lib = (await client.query('SELECT active_generation_id, revision::text AS revision, authority_epoch::text AS epoch, authority_era::text AS era FROM catalog_libraries WHERE user_id = $1 AND authority = \'POSTGRES\'', [uid])).rows[0];
      if (!lib) throw new CatalogQueryError('LIBRARY_RESET_REQUIRED', 409, 'no PostgreSQL library for this tenant', {});
      const counts = (await client.query(`SELECT b.state, count(*)::int AS n FROM catalog_beat_tag_groups g JOIN catalog_beats b USING (user_id, generation_id, beat_id)
        WHERE g.user_id = $1 AND g.generation_id = $2 AND g.norm_key = $3 AND b.state IN ('ACTIVE', 'TRASH') GROUP BY b.state`, [uid, lib.active_generation_id, fromKey])).rows;
      const n = (st) => counts.find((c) => c.state === st)?.n || 0;
      const existing = (await client.query("SELECT coalesce(sum(beat_count), 0)::int AS n FROM catalog_facets WHERE user_id = $1 AND generation_id = $2 AND norm_key = $3", [uid, lib.active_generation_id, target.normalized])).rows[0].n;
      return { from: fromKey, to: target.normalized, countActive: n('ACTIVE'), countTrash: n('TRASH'), mergesInto: existing > 0 ? existing : 0, revision: lib.revision, epoch: lib.epoch, authorityEra: lib.era };
    });
  }
  // Renombra en el documento: sustituye solo los tags cuyo norm coincide con `from`; deduplica cadenas exactamente iguales preservando orden.
  function renameTagsInDoc(doc, fromKey, to) {
    if (!Array.isArray(doc.tags)) return null;
    const next = []; const seen = new Set(); let changed = false;
    for (const t of doc.tags) {
      const v = typeof t === 'string' && rules.normalizeTag(t) === fromKey ? to : t;
      if (v !== t) changed = true;
      if (typeof v === 'string') { if (seen.has(v)) { changed = true; continue; } seen.add(v); }
      next.push(v);
    }
    return changed ? { ...doc, tags: next } : null;
  }

  // ---------- operaciones bulk (C12-r4 §4) y rename como operación ----------
  const OP_SQL = `SELECT o.operation_id, o.kind, o.status, o.set_id, o.selection_id, o.selection_version::text AS selection_version, o.expected_revision::text AS expected_revision,
    o.committed_revision::text AS committed_revision, o.total_frozen::text AS total_frozen, o.confirmed::text AS confirmed, o.not_executed::text AS not_executed, o.cancelled::text AS cancelled,
    o.conflict_batch_seq, o.next_slot::text AS next_slot, o.frontier_beat_id, o.payload_json, o.result_json, o.generation_id, o.created_at, o.updated_at, o.completed_at
    FROM catalog_operations o WHERE o.user_id = $1 AND o.operation_id = $2`;
  const opDto = (o, extra = {}) => ({ operationId: o.operation_id, kind: o.kind, status: o.status, setId: o.set_id, selectionId: o.selection_id, selectionVersion: o.selection_version,
    expectedRevision: o.expected_revision, committedRevision: o.committed_revision, progress: { total: Number(o.total_frozen), confirmed: Number(o.confirmed), notExecuted: Number(o.not_executed), cancelled: Number(o.cancelled), conflictBatchSeq: o.conflict_batch_seq },
    createdAt: o.created_at, updatedAt: o.updated_at, completedAt: o.completed_at, ...extra });

  async function createOperation({ userId, era, epoch, idempotencyKey, kind, selectionId = null, selectionVersion = null, patch = null, rename = null } = {}) {
    if (!['BULK_PATCH', 'BULK_TRASH', 'BULK_RESTORE', 'TAG_RENAME'].includes(kind)) throw inputInvalid('OPERATION_KIND');
    let validatedPatch = null; let renameSpec = null;
    if (kind === 'BULK_PATCH') { const v = rules.validatePatch(patch); if (!v.ok) throw inputInvalid('PATCH', { errors: v.errors }); if ('tags' in v.set) throw inputInvalid('BULK_PATCH_TAGS', { hint: 'bulk patch cannot replace tags; use TAG_RENAME' }); validatedPatch = v.set; }
    if (kind === 'TAG_RENAME') {
      if (!rename || typeof rename.from !== 'string' || !rename.from.trim()) throw inputInvalid('RENAME_FROM');
      const t = rules.validateTag(rename.to); if (!t.valid) throw inputInvalid('RENAME_TO', { reason: t.reason });
      renameSpec = { from: rules.normalizeTag(rename.from), to: t.normalized };
    } else {
      if (typeof selectionId !== 'string' || !ID_RE.test(selectionId)) throw inputInvalid('SELECTION_ID');
      if (!/^[0-9]{1,18}$/.test(String(selectionVersion ?? ''))) throw inputInvalid('SELECTION_VERSION');
    }
    const payload = { kind, selectionId, selectionVersion: selectionVersion == null ? null : String(selectionVersion), patch: validatedPatch, rename: renameSpec };
    const hash = sha256Hex(canonicalJson(payload));
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const replay = await idempotency(client, uid, idempotencyKey, hash);
      if (replay) { const o = (await client.query(OP_SQL, [uid, replay.operationId])).rows[0]; return opDto(o, { replay: true }); }
      let extra = { expectedRevision: ctx.revision };
      if (kind === 'TAG_RENAME') {
        const total = (await client.query(`SELECT count(*)::text AS n FROM catalog_beat_tag_groups g JOIN catalog_beats b USING (user_id, generation_id, beat_id)
          WHERE g.user_id = $1 AND g.generation_id = $2 AND g.norm_key = $3 AND b.state IN ('ACTIVE', 'TRASH')`, [uid, ctx.generation_id, renameSpec.from])).rows[0].n;
        extra = { ...extra, totalFrozen: total };
      } else {
        const s = (await client.query(`${SELECTION_SQL} FOR UPDATE OF s`, [uid, selectionId])).rows[0];
        if (!s) throw notFound('selection');
        if (s.status !== 'ACTIVE' || s.selection_version !== String(selectionVersion)) throw new CatalogQueryError('SELECTION_CONFLICT', 409, 'selection is not ACTIVE at that version', { status: s.status, current_version: s.selection_version });
        if (s.base_revision !== ctx.revision) { await client.query("UPDATE catalog_selections SET status = 'CONFLICT', updated_at = now() WHERE user_id = $1 AND selection_id = $2", [uid, selectionId]); throw Object.assign(new CatalogQueryError('SELECTION_CONFLICT', 409, 'library revision changed since the selection was created', { base_revision: s.base_revision, current_revision: ctx.revision }), { commit: true }); }
        await client.query("UPDATE catalog_selections SET status = 'FROZEN', updated_at = now() WHERE user_id = $1 AND selection_id = $2", [uid, selectionId]);
        extra = { ...extra, setId: s.set_id, selectionId, selectionVersion: s.selection_version, totalFrozen: s.selected_count };
      }
      const operationId = await recordOperation(client, uid, ctx, { kind, key: idempotencyKey, hash, payload, result: null, status: 'QUEUED', extra });
      const o = (await client.query(OP_SQL, [uid, operationId])).rows[0];
      return opDto(o, { replay: false, created: true });
    });
  }
  // Un lote ≤50: miembros seleccionados desde next_slot (o beats con el tag desde frontier). Journal + checkpoint + revisión en la misma transacción.
  async function stepOperation({ userId, era, epoch, operationId, batch = BATCH_MAX } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    if (!Number.isInteger(batch) || batch < 1 || batch > BATCH_MAX) throw inputInvalid('BATCH', { max: BATCH_MAX });
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const gen = ctx.generation_id;
      const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
      if (!o) throw notFound('operation');
      if (!['QUEUED', 'RUNNING', 'CANCELLING'].includes(o.status)) return opDto(o, { advanced: 0 });
      const batchSeq = Number((await client.query('SELECT coalesce(max(batch_seq), 0) + 1 AS s FROM catalog_operation_batches WHERE user_id = $1 AND operation_id = $2', [uid, operationId])).rows[0].s);
      const payload = JSON.parse(o.payload_json);
      // Miembros del lote
      let members;
      if (o.kind === 'TAG_RENAME') {
        const p = [uid, gen, payload.rename.from, batch + 1];
        let frontier = '';
        if (o.frontier_beat_id) { p.push(o.frontier_beat_id); frontier = ` AND b.beat_id COLLATE "C" > $5::text COLLATE "C"`; }
        members = (await client.query(`SELECT b.beat_id, b.version::text AS expected_version, NULL::bigint AS slot FROM catalog_beat_tag_groups g JOIN catalog_beats b USING (user_id, generation_id, beat_id)
          WHERE g.user_id = $1 AND g.generation_id = $2 AND g.norm_key = $3 AND b.state IN ('ACTIVE', 'TRASH')${frontier} ORDER BY b.beat_id COLLATE "C" LIMIT $4`, p)).rows;
      } else {
        const s = (await client.query(SELECTION_SQL, [uid, o.selection_id])).rows[0];
        const params = [uid, o.selection_id, o.next_slot, batch + 1];
        members = (await client.query(`SELECT m.beat_id, m.expected_version::text AS expected_version, m.slot::text AS slot ${MEMBERS_FROM} AND m.slot >= $3::bigint AND ${selectedPredicateSql(s.sort, params, '$2')} ORDER BY m.slot LIMIT $4`, params)).rows;
      }
      const more = members.length > batch;
      const take = members.slice(0, batch);
      if (o.status === 'CANCELLING') {
        // Cancelación: los lotes siguientes no se ejecutan; se registra lo pendiente como cancelado.
        const remaining = Number(o.total_frozen) - Number(o.confirmed) - Number(o.not_executed);
        await client.query(`UPDATE catalog_operations SET status = 'CANCELLED', cancelled = $3::bigint, completed_at = now() WHERE user_id = $1 AND operation_id = $2`, [uid, operationId, Math.max(0, remaining)]);
        if (o.selection_id) await client.query("UPDATE catalog_selections SET status = 'INVALIDATED', updated_at = now() WHERE user_id = $1 AND selection_id = $2 AND status = 'FROZEN'", [uid, o.selection_id]);
        return opDto((await client.query(OP_SQL, [uid, operationId])).rows[0], { advanced: 0 });
      }
      if (!take.length) {
        const final = Number(o.not_executed) > 0 ? 'PARTIAL' : 'COMPLETED';
        await client.query(`UPDATE catalog_operations SET status = $3, completed_at = now() WHERE user_id = $1 AND operation_id = $2`, [uid, operationId, final]);
        if (o.selection_id) await client.query("UPDATE catalog_selections SET status = 'INVALIDATED', updated_at = now() WHERE user_id = $1 AND selection_id = $2 AND status = 'FROZEN'", [uid, o.selection_id]);
        return opDto((await client.query(OP_SQL, [uid, operationId])).rows[0], { advanced: 0 });
      }
      // Escritura externa desde el último commit propio → CONFLICT sin ejecutar este lote (lo confirmado se conserva).
      if (o.expected_revision !== ctx.revision) {
        await client.query('INSERT INTO catalog_operation_batches(user_id, operation_id, batch_seq, from_slot, to_slot, item_count, status) VALUES ($1,$2,$3,$4::bigint,$5::bigint,0,\'CONFLICT\')', [uid, operationId, batchSeq, o.next_slot, o.next_slot]);
        await client.query(`UPDATE catalog_operations SET status = 'CONFLICT', conflict_batch_seq = $3 WHERE user_id = $1 AND operation_id = $2`, [uid, operationId, batchSeq]);
        return opDto((await client.query(OP_SQL, [uid, operationId])).rows[0], { advanced: 0, conflict: { reason: 'REVISION_CHANGED', expected_revision: o.expected_revision, current_revision: ctx.revision } });
      }
      const ids = take.map((m) => m.beat_id).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      const rows = await lockBeats(client, uid, gen, ids);
      const byId = new Map(rows.map((r) => [r.beat_id, r]));
      const items = []; let conflict = null;
      for (const m of take) {
        const row = byId.get(m.beat_id);
        if (!row) { items.push({ beatId: m.beat_id, result: 'NOT_EXECUTED', detail: 'NOT_FOUND' }); continue; }
        if (o.kind !== 'TAG_RENAME' && row.version !== m.expected_version) { conflict = { beatId: m.beat_id, reason: 'VERSION_CONFLICT', expected: m.expected_version, current: row.version }; break; }
        items.push({ beatId: m.beat_id, row, fromVersion: row.version });
      }
      if (conflict) {
        await client.query('INSERT INTO catalog_operation_batches(user_id, operation_id, batch_seq, from_slot, to_slot, item_count, status) VALUES ($1,$2,$3,$4::bigint,$5::bigint,$6,\'CONFLICT\')', [uid, operationId, batchSeq, take[0].slot ?? 0, take[take.length - 1].slot ?? 0, take.length]);
        await client.query('INSERT INTO catalog_operation_batch_items(user_id, operation_id, batch_seq, beat_id, result, from_version, detail) VALUES ($1,$2,$3,$4,\'CONFLICT\',$5::bigint,$6)', [uid, operationId, batchSeq, conflict.beatId, conflict.current, conflict.reason]);
        await client.query(`UPDATE catalog_operations SET status = 'CONFLICT', conflict_batch_seq = $3 WHERE user_id = $1 AND operation_id = $2`, [uid, operationId, batchSeq]);
        return opDto((await client.query(OP_SQL, [uid, operationId])).rows[0], { advanced: 0, conflict });
      }
      // Aplicar
      let applied = 0; let notExecuted = 0; const touched = []; const keys = new Set(); let delta = { active: 0, trash: 0 }; const events = [];
      for (const it of items) {
        if (!it.row) { notExecuted++; continue; }
        const row = it.row; const doc = JSON.parse(row.legacy_json);
        if (o.kind === 'BULK_PATCH') {
          if (row.state !== 'ACTIVE') { it.result = 'NOT_EXECUTED'; it.detail = `STATE_${row.state}`; notExecuted++; continue; }
          const after = applyPatchToDoc(doc, payload.patch);
          if (!docChanged(doc, after)) { it.result = 'NOOP'; it.toVersion = row.version; applied++; continue; }
          for (const k of await normKeysOf(client, uid, gen, [row.beat_id])) keys.add(k);
          const w = await writeBeatDoc(client, uid, gen, row.beat_id, after); w.normKeys.forEach((k) => keys.add(k));
          it.result = 'APPLIED'; it.toVersion = w.version; applied++; touched.push(row.beat_id); events.push(['BEAT_PATCHED', row.beat_id, w.version]);
        } else if (o.kind === 'BULK_TRASH' || o.kind === 'BULK_RESTORE') {
          const want = o.kind === 'BULK_TRASH' ? 'ACTIVE' : 'TRASH';
          if (row.state !== want) { it.result = 'NOT_EXECUTED'; it.detail = `STATE_${row.state}`; notExecuted++; continue; }
          if (o.kind === 'BULK_RESTORE') { const tomb = await client.query('SELECT 1 FROM catalog_tombstones WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, row.beat_id]); if (tomb.rows.length) { it.result = 'NOT_EXECUTED'; it.detail = 'PURGE_PENDING'; notExecuted++; continue; } }
          const version = o.kind === 'BULK_TRASH' ? await trashOne(client, uid, gen, row) : await restoreOne(client, uid, gen, row);
          delta = o.kind === 'BULK_TRASH' ? { active: delta.active - 1, trash: delta.trash + 1 } : { active: delta.active + 1, trash: delta.trash - 1 };
          for (const k of await normKeysOf(client, uid, gen, [row.beat_id])) keys.add(k);
          it.result = 'APPLIED'; it.toVersion = version; applied++; touched.push(row.beat_id); events.push([o.kind === 'BULK_TRASH' ? 'BEAT_TRASHED' : 'BEAT_RESTORED', row.beat_id, version]);
        } else { // TAG_RENAME: metadata de tags, sin tocar estado, fechas ni referencias
          const after = renameTagsInDoc(doc, payload.rename.from, payload.rename.to);
          if (!after) { it.result = 'NOOP'; it.toVersion = row.version; applied++; continue; }
          keys.add(payload.rename.from); keys.add(payload.rename.to);
          const w = await writeBeatDoc(client, uid, gen, row.beat_id, after); w.normKeys.forEach((k) => keys.add(k));
          it.result = 'APPLIED'; it.toVersion = w.version; applied++; touched.push(row.beat_id); events.push(['TAGS_RENAMED', row.beat_id, w.version]);
        }
      }
      const revision = touched.length ? await bumpRevision(client, uid, delta) : ctx.revision;
      if (touched.length) await refreshGroupsAndFacets(client, uid, gen, touched, [...keys], revision);
      for (const [kind, beatId, version] of events) await emitEvent(client, uid, gen, revision, kind, { beatId, version, operationId });
      await client.query('INSERT INTO catalog_operation_batches(user_id, operation_id, batch_seq, from_slot, to_slot, item_count, status, committed_revision) VALUES ($1,$2,$3,$4::bigint,$5::bigint,$6,\'COMMITTED\',$7::bigint)',
        [uid, operationId, batchSeq, take[0].slot ?? 0, take[take.length - 1].slot ?? 0, take.length, revision]);
      for (const it of items) await client.query('INSERT INTO catalog_operation_batch_items(user_id, operation_id, batch_seq, beat_id, result, from_version, to_version, detail) VALUES ($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8)',
        [uid, operationId, batchSeq, it.beatId, it.result, it.fromVersion ?? null, it.toVersion ?? null, it.detail ?? null]);
      const nextSlot = o.kind === 'TAG_RENAME' ? o.next_slot : (BigInt(take[take.length - 1].slot) + 1n).toString();
      const frontier = o.kind === 'TAG_RENAME' ? take[take.length - 1].beat_id : o.frontier_beat_id;
      const finished = !more;
      const confirmed = Number(o.confirmed) + applied; const ne = Number(o.not_executed) + notExecuted;
      const status = finished ? (ne > 0 ? 'PARTIAL' : 'COMPLETED') : 'RUNNING';
      await client.query(`UPDATE catalog_operations SET status = $3, confirmed = $4::bigint, not_executed = $5::bigint, next_slot = $6::bigint, frontier_beat_id = $7, expected_revision = $8::bigint, committed_revision = $8::bigint,
          completed_at = CASE WHEN $3 IN ('COMPLETED', 'PARTIAL') THEN now() ELSE NULL END WHERE user_id = $1 AND operation_id = $2`, [uid, operationId, status, confirmed, ne, nextSlot, frontier, revision]);
      if (finished && o.selection_id) await client.query("UPDATE catalog_selections SET status = 'INVALIDATED', updated_at = now() WHERE user_id = $1 AND selection_id = $2 AND status = 'FROZEN'", [uid, o.selection_id]);
      if (finished) await emitEvent(client, uid, gen, revision, 'OPERATION_STATUS', { operationId, payload: { status } });
      return opDto((await client.query(OP_SQL, [uid, operationId])).rows[0], { advanced: take.length, batchSeq, revision });
    });
  }
  async function getOperation({ userId, operationId, detailsAfter = null } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    return readTx(userId, async (client, uid) => {
      const o = (await client.query(OP_SQL, [uid, operationId])).rows[0];
      if (!o) throw notFound('operation');
      const params = [uid, operationId, BATCH_MAX + 1];
      let after = '';
      if (detailsAfter) { const m = /^([0-9]+):(.+)$/.exec(String(detailsAfter)); if (!m) throw inputInvalid('DETAILS_CURSOR'); params.push(Number(m[1]), m[2]); after = ' AND (i.batch_seq, i.beat_id COLLATE "C") > ($4::int, $5::text COLLATE "C")'; }
      const items = (await client.query(`SELECT i.batch_seq, i.beat_id, i.result, i.from_version::text AS from_version, i.to_version::text AS to_version, i.detail FROM catalog_operation_batch_items i
        WHERE i.user_id = $1 AND i.operation_id = $2${after} ORDER BY i.batch_seq, i.beat_id COLLATE "C" LIMIT $3`, params)).rows;
      const page = items.slice(0, BATCH_MAX);
      const batches = (await client.query('SELECT batch_seq, status, item_count, committed_revision::text AS committed_revision FROM catalog_operation_batches WHERE user_id = $1 AND operation_id = $2 ORDER BY batch_seq', [uid, operationId])).rows;
      return opDto(o, { batches: batches.map((b) => ({ batchSeq: b.batch_seq, status: b.status, itemCount: b.item_count, committedRevision: b.committed_revision })),
        details: page.map((i) => ({ batchSeq: i.batch_seq, beatId: i.beat_id, result: i.result, fromVersion: i.from_version, toVersion: i.to_version, detail: i.detail })),
        detailsNext: items.length > BATCH_MAX ? `${page[page.length - 1].batch_seq}:${page[page.length - 1].beat_id}` : null });
    });
  }
  async function cancelOperation({ userId, era, epoch, operationId } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
      if (!o) throw notFound('operation');
      if (['COMPLETED', 'PARTIAL', 'CANCELLED'].includes(o.status)) return opDto(o, { changed: false });
      const pending = Number(o.total_frozen) - Number(o.confirmed) - Number(o.not_executed);
      const direct = o.status === 'QUEUED' || o.status === 'CONFLICT' || o.status === 'BLOCKED';
      if (direct) {
        await client.query(`UPDATE catalog_operations SET status = 'CANCELLED', cancelled = $3::bigint, completed_at = now() WHERE user_id = $1 AND operation_id = $2`, [uid, operationId, Math.max(0, pending)]);
        if (o.selection_id) await client.query("UPDATE catalog_selections SET status = 'INVALIDATED', updated_at = now() WHERE user_id = $1 AND selection_id = $2 AND status = 'FROZEN'", [uid, o.selection_id]);
      } else if (o.status === 'RUNNING') {
        await client.query(`UPDATE catalog_operations SET status = 'CANCELLING' WHERE user_id = $1 AND operation_id = $2`, [uid, operationId]);
      }
      return opDto((await client.query(OP_SQL, [uid, operationId])).rows[0], { changed: true });
    });
  }
  // CONFLICT → RUNNING solo con una revisión explícita igual a la actual (reanudar no es retry ciego).
  async function resumeOperation({ userId, era, epoch, operationId, revision } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    if (!/^[1-9][0-9]{0,17}$/.test(String(revision ?? ''))) throw inputInvalid('REVISION');
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
      if (!o) throw notFound('operation');
      if (o.status !== 'CONFLICT') throw new CatalogQueryError('OPERATION_TRANSITION_INVALID', 409, `operation is ${o.status}`, { status: o.status });
      if (String(revision) !== ctx.revision) throw new CatalogQueryError('REVISION_MISMATCH', 409, 'revision provided is not the current one', { current_revision: ctx.revision });
      await client.query(`UPDATE catalog_operations SET status = 'RUNNING', expected_revision = $3::bigint, conflict_batch_seq = NULL WHERE user_id = $1 AND operation_id = $2`, [uid, operationId, ctx.revision]);
      return opDto((await client.query(OP_SQL, [uid, operationId])).rows[0], { resumed: true });
    });
  }

  // ---------- GET /catalog/v1/changes?after= (feed durable C5) ----------
  async function listChanges({ userId, query = {} } = {}) {
    const after = query.after;
    if (typeof after !== 'string' || !/^(0|[1-9][0-9]{0,17})$/.test(after)) throw inputInvalid('AFTER');
    return readTx(userId, async (client, uid) => {
      const lib = (await client.query("SELECT revision::text AS revision, authority_epoch::text AS epoch, authority_era::text AS era, active_generation_id FROM catalog_libraries WHERE user_id = $1 AND authority = 'POSTGRES'", [uid])).rows[0];
      if (!lib) throw new CatalogQueryError('LIBRARY_RESET_REQUIRED', 409, 'no PostgreSQL library for this tenant', {});
      const bounds = (await client.query('SELECT coalesce(min(event_seq), 0)::text AS lo, coalesce(max(event_seq), 0)::text AS hi FROM catalog_events WHERE user_id = $1', [uid])).rows[0];
      const hi = BigInt(bounds.hi); const a = BigInt(after);
      if (a > hi) throw inputInvalid('AFTER_AHEAD', { latest: bounds.hi });
      if (hi - a > BigInt(EVENTS_RETENTION) || (a > 0n && a < BigInt(bounds.lo) - 1n)) throw new CatalogQueryError('RESYNC_REQUIRED', 410, 'feed cursor is outside the retention window: reload the visible pages', { latest: bounds.hi });
      const rows = (await client.query('SELECT event_seq::text AS seq, revision::text AS revision, kind, beat_id, version::text AS version, operation_id, payload_json, created_at FROM catalog_events WHERE user_id = $1 AND event_seq > $2::bigint ORDER BY event_seq LIMIT $3', [uid, after, EVENTS_PAGE_MAX + 1])).rows;
      const page = rows.slice(0, EVENTS_PAGE_MAX);
      return { events: page.map((e) => ({ seq: e.seq, revision: e.revision, kind: e.kind, beatId: e.beat_id, version: e.version, operationId: e.operation_id, payload: JSON.parse(e.payload_json), at: e.created_at })),
        next: page.length ? page[page.length - 1].seq : after, hasMore: rows.length > EVENTS_PAGE_MAX, latest: bounds.hi, revision: lib.revision, epoch: lib.epoch, authorityEra: lib.era, generationId: lib.active_generation_id };
    });
  }

  return Object.freeze({
    patchBeat, trashBeats, restoreBeats, createSelection, applySelectionOp, getSelection, releaseSelection, previewTagRename, createOperation, stepOperation, getOperation, cancelOperation, resumeOperation, listChanges,
    limits: Object.freeze({ BATCH_MAX, BODY_METADATA_BYTES, BODY_BATCH_BYTES, TRASH_RETENTION_DAYS, EVENTS_PAGE_MAX, EVENTS_RETENTION }),
  });
}

let configured = null;
function configureCatalogCommands(options = null) { configured = options && options.pool && options.authority ? createCatalogCommands(options) : null; return configured; }
function currentCatalogCommands() { return configured; }

module.exports = { BATCH_MAX, BODY_METADATA_BYTES, BODY_BATCH_BYTES, TRASH_RETENTION_DAYS, EVENTS_PAGE_MAX, EVENTS_RETENTION, BULK_KINDS, applyPatchToDoc, docChanged, createCatalogCommands, configureCatalogCommands, currentCatalogCommands };
