'use strict';
// T04 — Transformación INDEX ⇄ filas del catálogo (solo transformación: no escribe DB ni cambia autoridad).
// decompose(doc, ctx) produce las filas de las tablas T03; compose(rows, {mode}) reconstruye el INDEX:
//  - 'source-roundtrip': semántica exacta del INDEX fuente.
//  - 'authoritative-export': añade tombstones SQL-only validados y, si la fuente era v1 implícita,
//    version:2 y trash:[]; cada adición se lista en `deltas`, nunca se oculta como igualdad.
// El beat se conserva como legacy_json = JSON.stringify(objeto parseado) en orden de claves de origen (D-03).

const crypto = require('crypto');
const codec = require('./legacy-codec');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const J = (v) => JSON.stringify(v);
const ROOT_ARRAYS = ['beats', 'trash', 'deleted', 'garbage'];
const FILE_TYPE_ROLE = { wav: 'WAV', stems: 'STEMS', samples: 'SAMPLES', loop: 'LOOP', loops: 'LOOP', mp3: 'LEGACY_OTHER' };

function toTimestamp(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

// Archivos/partes/ubicaciones de un beat (D-04, D-05, D-10).
function fileRows(beat, beatId, base, chatId) {
  const files = []; const parts = []; const locations = []; const objects = []; const current = [];
  const add = (role, slotKey, legacyPath, section) => {
    if (!codec.sectionPresent(section)) return;
    const fileId = `f_${sha(`${beatId}\u0000${legacyPath}`).slice(0, 40)}`;
    const sec = codec.isObj(section) ? section : {};
    const size = Number.isSafeInteger(sec.size) && sec.size > 0 ? sec.size : null; // size 0 => NULL (D-10)
    files.push({ fileId, beatId, role, legacyPath, filename: typeof sec.filename === 'string' ? sec.filename : null, mime: typeof sec.mime === 'string' ? sec.mime : null, sizeBytes: size, originalJson: J(section) });
    current.push({ beatId, slotKey, fileId });
    const manifestParts = codec.isObj(sec.manifest) && Array.isArray(sec.manifest.parts) ? sec.manifest.parts : null;
    const list = manifestParts || (Array.isArray(sec.parts) ? sec.parts : null);
    const partList = list ? list.map((p, k) => ({ p, k })) : [{ p: sec, k: 0 }];
    const refHolders = []; // la referencia a nivel manifest solo se admite si coincide con una parte (validateIndex)
    for (const { p, k } of partList) {
      parts.push({ fileId, partIndex: k, sizeBytes: codec.isObj(p) && Number.isSafeInteger(p.size) && p.size > 0 ? p.size : null, originalJson: J(p) });
      refHolders.push({ holder: p, partIndex: k, location: 'PRIMARY' });
    }
    if (role === 'METADATA') { refHolders.length = 0; refHolders.push({ holder: { telegram_message_id: section }, partIndex: 0, location: 'PRIMARY' }); }
    for (const { holder, partIndex, location } of refHolders) {
      if (!codec.isObj(holder)) continue;
      const loc = typeof holder.telegram_file_id === 'string' ? holder.telegram_file_id : null;
      const mid = Number.isSafeInteger(holder.telegram_message_id) && holder.telegram_message_id > 0 ? holder.telegram_message_id : null;
      if (loc === null && mid === null) continue;
      if (locations.some((l) => l.fileId === fileId && l.partIndex === partIndex && l.location === location)) continue;
      const d = codec.directId(loc);
      const known = chatId != null && mid !== null && (loc === null || d === mid);
      const objectId = known ? `tg:${chatId}:${mid}` : null;
      if (known && !objects.some((o) => o.objectId === objectId)) objects.push({ objectId, chatId: String(chatId), messageId: mid });
      locations.push({ fileId, partIndex, location, referenceClass: known ? 'KNOWN' : 'OPAQUE', objectId, locator: loc ?? `msg:${mid}` });
    }
  };
  for (const k of codec.SLOT_KEYS) add(k.toUpperCase(), k.toUpperCase(), `${base}.${k}`, beat[k]);
  if (Array.isArray(beat.files)) beat.files.forEach((f, k) => add(FILE_TYPE_ROLE[codec.isObj(f) && typeof f.type === 'string' ? f.type.toLowerCase() : ''] || 'LEGACY_OTHER', `FILES:${k}`, `${base}.files[${k}]`, f));
  if (Number.isSafeInteger(beat.metadata_message_id) && beat.metadata_message_id > 0) add('METADATA', 'METADATA', `${base}.metadata_message_id`, beat.metadata_message_id);
  return { files, parts, locations, objects, current };
}

function decompose(doc, ctx = {}) {
  const v = codec.validateIndex(doc, ctx);
  if (v.review.length) { const e = new Error('CATALOG_IMPORT_REVIEW'); e.code = 'CATALOG_IMPORT_REVIEW'; e.review = v.review; throw e; }
  const rows = { rootKeys: Object.keys(doc), rootFields: [], beats: [], tags: [], trash: [], tombstones: [], garbage: [], files: [], parts: [], locations: [], objects: [], current: [], flags: v.flags };
  for (const [key, value] of Object.entries(doc)) if (!ROOT_ARRAYS.includes(key)) rows.rootFields.push({ key, valueJson: J(value) });
  let rank = 0;
  const addBeat = (beat, state, base) => {
    const legacyJson = J(beat);
    const p = codec.projectBeat(beat);
    rows.beats.push({ beatId: beat.id, state, manualRank: String(rank++), legacyJson, legacySha256: sha(Buffer.from(legacyJson, 'utf8')), legacyExportBytes: Buffer.byteLength(legacyJson, 'utf8'), ...p, tags: undefined });
    for (const t of p.tags) rows.tags.push({ beatId: beat.id, ...t });
    const f = fileRows(beat, beat.id, base, ctx.chatId);
    rows.files.push(...f.files); rows.parts.push(...f.parts); rows.locations.push(...f.locations); rows.current.push(...f.current);
    for (const o of f.objects) if (!rows.objects.some((x) => x.objectId === o.objectId)) rows.objects.push(o);
  };
  doc.beats.forEach((b, k) => addBeat(b, 'ACTIVE', `$.beats[${k}]`));
  (doc.trash || []).forEach((item, k) => {
    const wrapped = codec.isObj(item) && Object.prototype.hasOwnProperty.call(item, 'beat');
    const beat = wrapped ? item.beat : item;
    addBeat(beat, 'TRASH', wrapped ? `$.trash[${k}].beat` : `$.trash[${k}]`);
    const wrapper = wrapped ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'beat')) : null;
    rows.trash.push({ beatId: beat.id, wrapperPresent: wrapped, trashId: wrapped && typeof item.trash_id === 'string' ? item.trash_id : null,
      trashedAt: wrapped ? toTimestamp(item.trashed_at) : null, purgeAfter: wrapped ? toTimestamp(item.purge_after) : null,
      wrapperJson: wrapped ? J(wrapper) : null, beatKeyIndex: wrapped ? Object.keys(item).indexOf('beat') : null, exportPosition: k });
  });
  const sqlById = new Map((ctx.sqlTombstones || []).map((t) => [t.beat_id, t]));
  (doc.deleted || []).forEach((d, k) => {
    const id = d.beat_id !== undefined ? d.beat_id : d.id;
    const rawKey = d.beat_id !== undefined && d.id !== undefined ? 'both' : d.beat_id !== undefined ? 'beat_id' : 'id';
    const sql = sqlById.get(id); sqlById.delete(id);
    rows.tombstones.push({ beatId: id, source: sql ? 'BOTH' : 'INDEX', rawKey, originalJson: J(d), exportPosition: k, deletedAt: toTimestamp(d.deleted_at ?? d.at), sqlState: sql ? sql.state : null, beatSha256: sql && sql.beat_sha256 ? sql.beat_sha256 : null });
  });
  for (const t of sqlById.values()) rows.tombstones.push({ beatId: t.beat_id, source: 'SQL', rawKey: null, originalJson: null, exportPosition: null, deletedAt: toTimestamp(t.confirmed_at), sqlState: t.state, beatSha256: t.beat_sha256 || null });
  (doc.garbage || []).forEach((g, k) => rows.garbage.push({ ordinal: k, valueJson: J(g) }));
  return rows;
}

function compose(rows, { mode = 'source-roundtrip' } = {}) {
  const deltas = [];
  const byRank = (a, b) => (BigInt(a.manualRank) < BigInt(b.manualRank) ? -1 : 1);
  const active = rows.beats.filter((b) => b.state === 'ACTIVE').sort(byRank).map((b) => JSON.parse(b.legacyJson));
  const trashBeats = new Map(rows.beats.filter((b) => b.state !== 'ACTIVE').map((b) => [b.beatId, JSON.parse(b.legacyJson)]));
  const trash = [...rows.trash].sort((a, b) => a.exportPosition - b.exportPosition).map((t) => {
    const beat = trashBeats.get(t.beatId);
    if (!t.wrapperPresent) return beat;
    const entries = Object.entries(JSON.parse(t.wrapperJson));
    entries.splice(t.beatKeyIndex ?? entries.length, 0, ['beat', beat]);
    return Object.fromEntries(entries);
  });
  const deleted = rows.tombstones.filter((t) => t.originalJson !== null).sort((a, b) => a.exportPosition - b.exportPosition).map((t) => JSON.parse(t.originalJson));
  const garbage = [...rows.garbage].sort((a, b) => a.ordinal - b.ordinal).map((g) => JSON.parse(g.valueJson));
  const roots = new Map(rows.rootFields.map((f) => [f.key, JSON.parse(f.valueJson)]));
  const arrays = { beats: active, trash, deleted, garbage };
  const keys = [...rows.rootKeys];
  if (mode === 'authoritative-export') {
    const sqlOnly = rows.tombstones.filter((t) => t.source === 'SQL');
    if (sqlOnly.length) {
      if (!keys.includes('deleted')) keys.push('deleted');
      for (const t of sqlOnly) { deleted.push({ beat_id: t.beatId, deleted_at: t.deletedAt ? Math.floor(Date.parse(t.deletedAt) / 1000) : null }); deltas.push({ path: '$.deleted', kind: 'SQL_ONLY_TOMBSTONE', beatId: t.beatId }); }
    }
    if (!keys.includes('version')) { keys.splice(Math.max(1, keys.indexOf('schema') + 1), 0, 'version'); roots.set('version', 2); deltas.push({ path: '$.version', kind: 'V1_TO_V2' }); }
    if (!keys.includes('trash')) { keys.push('trash'); deltas.push({ path: '$.trash', kind: 'V1_TO_V2' }); }
  } else if (mode !== 'source-roundtrip') throw new Error(`modo desconocido ${mode}`);
  const doc = {};
  for (const k of keys) doc[k] = Object.prototype.hasOwnProperty.call(arrays, k) ? arrays[k] : roots.get(k);
  return { doc, deltas };
}

// Presupuesto a partir de las filas (sin exportar la biblioteca entera).
function budgetFromRows(rows) {
  const sqlOnly = rows.tombstones.filter((t) => t.source === 'SQL').length;
  return codec.exportBudget({
    beatJsons: rows.beats.filter((b) => b.state === 'ACTIVE').map((b) => b.legacyJson),
    trashJsons: rows.trash.map((t) => (t.wrapperPresent ? t.wrapperJson : '') + rows.beats.find((b) => b.beatId === t.beatId).legacyJson + (t.wrapperPresent ? ',"beat":' : '')),
    deletedJsons: rows.tombstones.filter((t) => t.originalJson !== null).map((t) => t.originalJson),
    sqlOnlyTombstones: sqlOnly,
    garbageJsons: rows.garbage.map((g) => g.valueJson),
    rootExtraJsons: rows.rootFields.map((f) => `${J(f.key)}:${f.valueJson}`),
    rootKeyCount: rows.rootKeys.length + 3,
  });
}

module.exports = { decompose, compose, budgetFromRows, fileRows, toTimestamp };
