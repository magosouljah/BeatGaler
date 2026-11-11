'use strict';
// T04 — Import a generación STAGING y export desde SQL. Nunca cambia autoridad, época, revisión ni
// generación activa; nunca toca library_* ni Telegram. Lotes de 250 beats con checkpoint (snapshot_hash, ordinal):
// cada lote (beat + tags + papelera + archivos/partes/ubicaciones/slots) es una transacción breve; reanudar
// continúa en el primer ordinal no escrito y verifica que lo escrito coincide con el snapshot.

const crypto = require('crypto');
const codec = require('./legacy-codec');
const { decompose, compose } = require('./migration');
const { requireScope } = require('./contract');

const BATCH = 250;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const err = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });

async function tx(pool, fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { try { await c.query('ROLLBACK'); } catch { /* el error original manda */ } throw e; }
  finally { c.release(); }
}

function prepare(rawBytes, ctx) {
  const raw = Buffer.from(rawBytes);
  const parsed = codec.parseStrict(raw);
  if (!parsed.ok) throw err('CATALOG_IMPORT_REVIEW', { review: parsed.issues });
  const rows = decompose(parsed.value, ctx); // lanza CATALOG_IMPORT_REVIEW antes de escribir
  return { raw, snapshotHash: sha(raw), rows, source: parsed.value };
}

async function insertBeatBatch(c, s, rows, batch) {
  const ids = new Set(batch.map((b) => b.beatId));
  for (const b of batch) {
    await c.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, color, color2, bpm_sort_class, bpm_sort,
        sort_order, manual_rank, telegram_topic_id, has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, projection_version,
        name_display, name_search, key_display, key_search, bpm_display, rating_display)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
    [s.userId, s.generationId, b.beatId, b.state, b.name, b.bpmText, b.keyText, b.rating, b.color, b.color2, b.bpmSortClass, b.bpmSort,
      b.sortOrder, b.manualRank, b.telegramTopicId, b.hasArtwork, b.legacyJson, b.legacySha256, b.legacyExportBytes, codec.PROJECTION_VERSION,
      b.nameDisplay, b.nameSearch, b.keyDisplay, b.keySearch, b.bpmDisplay, b.ratingDisplay]);
  }
  for (const t of rows.tags.filter((x) => ids.has(x.beatId))) {
    await c.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key, projection_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [s.userId, s.generationId, t.beatId, t.position, t.label, t.normKey, t.searchKey, codec.PROJECTION_VERSION]);
  }
  for (const t of rows.trash.filter((x) => ids.has(x.beatId))) {
    await c.query(`INSERT INTO catalog_trash_entries(user_id, generation_id, beat_id, beat_state, wrapper_present, trash_id, trashed_at, purge_after, wrapper_json, export_position)
      VALUES ($1,$2,$3,'TRASH',$4,$5,$6,$7,$8,$9)`, [s.userId, s.generationId, t.beatId, t.wrapperPresent, t.trashId, t.trashedAt, t.purgeAfter, t.wrapperJson, t.exportPosition]);
  }
  const files = rows.files.filter((f) => ids.has(f.beatId));
  const fileIds = new Set(files.map((f) => f.fileId));
  for (const f of files) {
    await c.query(`INSERT INTO catalog_file_versions(user_id, generation_id, file_id, beat_id, role, legacy_path, filename, mime, size_bytes, original_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [s.userId, s.generationId, f.fileId, f.beatId, f.role, f.legacyPath, f.filename, f.mime, f.sizeBytes, f.originalJson]);
  }
  for (const p of rows.parts.filter((x) => fileIds.has(x.fileId))) {
    await c.query('INSERT INTO catalog_file_parts(user_id, generation_id, file_id, part_index, size_bytes, original_json) VALUES ($1,$2,$3,$4,$5,$6)',
      [s.userId, s.generationId, p.fileId, p.partIndex, p.sizeBytes, p.originalJson]);
  }
  for (const l of rows.locations.filter((x) => fileIds.has(x.fileId))) {
    await c.query(`INSERT INTO catalog_part_locations(user_id, generation_id, file_id, part_index, location, reference_class, object_id, provider, locator)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'telegram',$8)`, [s.userId, s.generationId, l.fileId, l.partIndex, l.location, l.referenceClass, l.objectId, l.locator]);
  }
  for (const cur of rows.current.filter((x) => ids.has(x.beatId))) {
    await c.query('INSERT INTO catalog_current_files(user_id, generation_id, beat_id, slot_key, file_id) VALUES ($1,$2,$3,$4,$5)',
      [s.userId, s.generationId, cur.beatId, cur.slotKey, cur.fileId]);
  }
}

async function importToStaging({ pool, scope, rawBytes, ctx = {}, batchSize = BATCH, onBatchCommitted } = {}) {
  const s = requireScope(scope);
  const { raw, snapshotHash, rows } = prepare(rawBytes, ctx);
  // 1) cabecera de la generación (idempotente para el mismo snapshot)
  await tx(pool, async (c) => {
    const lib = await c.query('SELECT authority FROM catalog_libraries WHERE user_id = $1', [s.userId]);
    if (!lib.rows.length) throw err('CATALOG_LIBRARY_MISSING');
    const g = await c.query('SELECT snapshot_id, status FROM catalog_generations WHERE user_id = $1 AND generation_id = $2 FOR UPDATE', [s.userId, s.generationId]);
    if (g.rows.length) {
      if (g.rows[0].snapshot_id !== snapshotHash) throw err('CATALOG_SNAPSHOT_CHANGED');
      if (g.rows[0].status !== 'STAGING') throw err('CATALOG_GENERATION_NOT_STAGING');
      return;
    }
    const descriptor = { rootKeys: rows.rootKeys, beats: rows.beats.length, trash: rows.trash.length, tombstones: rows.tombstones.length, flags: rows.flags, codec_projection_version: codec.PROJECTION_VERSION };
    await c.query(`INSERT INTO catalog_generations(user_id, generation_id, snapshot_id, raw_index, raw_index_sha256, descriptor_json) VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.userId, s.generationId, snapshotHash, raw, snapshotHash, JSON.stringify(descriptor)]);
    for (const f of rows.rootFields) await c.query("INSERT INTO catalog_legacy_fields VALUES ($1,$2,'root',$3,0,$4,'NONE')", [s.userId, s.generationId, f.key, f.valueJson]);
    for (const g2 of rows.garbage) await c.query("INSERT INTO catalog_legacy_fields VALUES ($1,$2,'garbage','',$3,$4,'KNOWN')", [s.userId, s.generationId, g2.ordinal, g2.valueJson]);
    for (const t of rows.tombstones) {
      await c.query(`INSERT INTO catalog_tombstones(user_id, generation_id, beat_id, source, deleted_at, raw_key, original_json, export_position, sql_state, assets_known, beat_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10)`, [s.userId, s.generationId, t.beatId, t.source, t.deletedAt, t.rawKey, t.originalJson, t.exportPosition, t.sqlState, t.beatSha256]);
    }
    for (const o of rows.objects) {
      await c.query(`INSERT INTO catalog_media_objects(user_id, object_id, provider, chat_id, message_id) VALUES ($1,$2,'telegram',$3,$4)
        ON CONFLICT (user_id, object_id) DO NOTHING`, [s.userId, o.objectId, o.chatId, o.messageId]);
    }
  });
  // 2) checkpoint: beats ya escritos deben ser exactamente el prefijo por ordinal del snapshot
  const done = await pool.query(`SELECT beat_id, manual_rank::text AS r FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 ORDER BY manual_rank`, [s.userId, s.generationId]);
  done.rows.forEach((r, k) => { if (r.beat_id !== rows.beats[k]?.beatId || r.r !== rows.beats[k].manualRank) throw err('CATALOG_CHECKPOINT_MISMATCH', { ordinal: k }); });
  let written = done.rows.length; let batches = 0;
  while (written < rows.beats.length) {
    const batch = rows.beats.slice(written, written + batchSize);
    await tx(pool, (c) => insertBeatBatch(c, s, rows, batch));
    written += batch.length; batches++;
    if (onBatchCommitted) await onBatchCommitted({ snapshotHash, ordinal: written, batches });
  }
  // 3) proyecciones derivadas (tag groups / facets), reconstruidas de forma idempotente
  await tx(pool, (c) => rebuildDerivedProjections(c, s));
  return { snapshotHash, beats: rows.beats.length, batches, resumedFrom: done.rows.length, flags: rows.flags };
}

// Grupos de tags y facetas de una generación, reconstruidos de forma idempotente dentro de la transacción dada (T04; T06 los pagina).
async function rebuildDerivedProjections(c, s) {
  {
    // 0037: texto de búsqueda derivado (name_search ␟ key_search ␟ bpm_display ␟ search_key de cada tag por posición), set-based.
    await c.query(`UPDATE catalog_beats b SET search_text = b.name_search || chr(31) || b.key_search || chr(31) || b.bpm_display
        || coalesce((SELECT chr(31) || string_agg(t.search_key, chr(31) ORDER BY t.position) FROM catalog_beat_tags t
                     WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id), '')
      WHERE b.user_id = $1 AND b.generation_id = $2`, [s.userId, s.generationId]);
    await c.query('DELETE FROM catalog_facets WHERE user_id = $1 AND generation_id = $2', [s.userId, s.generationId]);
    await c.query('DELETE FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2', [s.userId, s.generationId]);
    await c.query(`INSERT INTO catalog_beat_tag_groups(user_id, generation_id, beat_id, norm_key, projection_version, state, manual_rank, first_position, label_at_first_position)
      SELECT DISTINCT ON (t.beat_id, t.norm_key) t.user_id, t.generation_id, t.beat_id, t.norm_key, t.projection_version, b.state, b.manual_rank, t.position, t.label
      FROM catalog_beat_tags t JOIN catalog_beats b USING (user_id, generation_id, beat_id)
      WHERE t.user_id = $1 AND t.generation_id = $2 ORDER BY t.beat_id, t.norm_key, t.position`, [s.userId, s.generationId]);
    await c.query(`WITH grp AS (SELECT * FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND state IN ('ACTIVE','TRASH')),
      cnt AS (SELECT state, norm_key, projection_version, count(*) AS n FROM grp GROUP BY 1, 2, 3),
      rep AS (SELECT DISTINCT ON (state, norm_key, projection_version) state, norm_key, projection_version, beat_id, first_position, label_at_first_position
              FROM grp ORDER BY state, norm_key, projection_version, manual_rank, beat_id COLLATE "C")
      INSERT INTO catalog_facets(user_id, generation_id, scope, norm_key, projection_version, beat_count, rep_beat_id, rep_position, rep_label, updated_revision)
      SELECT $1, $2, c.state, c.norm_key, c.projection_version, c.n, r.beat_id, r.first_position, r.label_at_first_position, 1
      FROM cnt c JOIN rep r USING (state, norm_key, projection_version)`, [s.userId, s.generationId]);
  }
}

async function readRows(pool, scope) {
  const s = requireScope(scope);
  const q = (sql) => pool.query(sql, [s.userId, s.generationId]).then((r) => r.rows);
  const [gen] = await q('SELECT descriptor_json FROM catalog_generations WHERE user_id = $1 AND generation_id = $2');
  if (!gen) throw err('CATALOG_GENERATION_NOT_FOUND');
  const d = JSON.parse(gen.descriptor_json);
  const beats = await q('SELECT beat_id, state, manual_rank::text AS manual_rank, legacy_json FROM catalog_beats WHERE user_id = $1 AND generation_id = $2');
  const trash = await q('SELECT beat_id, wrapper_present, wrapper_json, export_position FROM catalog_trash_entries WHERE user_id = $1 AND generation_id = $2');
  const tombs = await q('SELECT beat_id, source, deleted_at, original_json, export_position FROM catalog_tombstones WHERE user_id = $1 AND generation_id = $2');
  const legacy = await q('SELECT scope, key, ordinal, value_json FROM catalog_legacy_fields WHERE user_id = $1 AND generation_id = $2');
  return {
    rootKeys: d.rootKeys,
    rootFields: legacy.filter((l) => l.scope === 'root').map((l) => ({ key: l.key, valueJson: l.value_json })),
    garbage: legacy.filter((l) => l.scope === 'garbage').map((l) => ({ ordinal: l.ordinal, valueJson: l.value_json })),
    beats: beats.map((b) => ({ beatId: b.beat_id, state: b.state, manualRank: b.manual_rank, legacyJson: b.legacy_json })),
    trash: trash.map((t) => ({ beatId: t.beat_id, wrapperPresent: t.wrapper_present, wrapperJson: t.wrapper_json, exportPosition: t.export_position })),
    tombstones: tombs.map((t) => ({ beatId: t.beat_id, source: t.source, deletedAt: t.deleted_at ? new Date(t.deleted_at).toISOString() : null, originalJson: t.original_json, exportPosition: t.export_position })),
  };
}

async function exportGeneration({ pool, scope, mode = 'source-roundtrip' }) {
  const rows = await readRows(pool, scope);
  const { doc, deltas } = compose(rows, { mode });
  const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
  return { doc, deltas, bytes, sha256: sha(bytes) };
}

// Compara el export SQL con el raw del snapshot; solo si no hay diferencias marca VALIDATED (no es autoridad).
async function validateGeneration({ pool, scope }) {
  const s = requireScope(scope);
  const { rows: [g] } = await pool.query('SELECT raw_index, snapshot_id, status FROM catalog_generations WHERE user_id = $1 AND generation_id = $2', [s.userId, s.generationId]);
  if (!g) throw err('CATALOG_GENERATION_NOT_FOUND');
  const source = codec.parseStrict(g.raw_index).value;
  const exp = await exportGeneration({ pool, scope: s, mode: 'source-roundtrip' });
  const diffs = codec.deepDiff(source, exp.doc);
  if (diffs.length) return { validated: false, diffs };
  if (g.status === 'STAGING') await pool.query("UPDATE catalog_generations SET status = 'VALIDATED', source_hash = $3, validated_at = now() WHERE user_id = $1 AND generation_id = $2", [s.userId, s.generationId, g.snapshot_id]);
  return { validated: true, diffs: [] };
}

module.exports = { importToStaging, exportGeneration, validateGeneration, rebuildDerivedProjections, readRows, prepare, BATCH };
