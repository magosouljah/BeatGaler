'use strict';
// Proyección del documento de beat (columna `legacy_json`: el mismo formato JSON de beat que usaba el cliente) a las columnas SQL
// derivadas — nombre/tonalidad/BPM de presentación y búsqueda, orden por BPM, rating, tags normalizados y texto de búsqueda (0028/0037) —
// y comparación semántica de documentos. También contiene el escritor de filas y los proyectores de lectura del catálogo.

const { createHash } = require('crypto');
const facets = require('./facets');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// D-04: sección ausente sii null/ausente u objeto sin ningún escalar no-null.
function sectionPresent(v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.some(sectionPresent);
  if (isObj(v)) return Object.values(v).some(sectionPresent);
  return true;
}

// ---------- proyecciones (search-js-v1 / A2) ----------
const SEARCH_TEXT_SEP = '\u001f'; // Unit Separator; un q que lo contenga usa el predicado por campos (queries.js)
function projectBeat(beat) {
  const str = (v) => (typeof v === 'string' ? v : null);
  const bpmDisplay = typeof beat.bpm === 'string' ? beat.bpm : '';
  const n = Number(bpmDisplay);
  const bpmSortClass = Number.isNaN(n) ? 3 : n === -Infinity ? 0 : n === Infinity ? 2 : 1;
  const rating = Number.isInteger(beat.rating) && beat.rating >= 0 && beat.rating <= 255 ? beat.rating : null;
  // normKey: agrupación visual de tagSelectors (trim+lower). searchKey: predicado q de librarySelectors.ts:18 (solo lower).
  const tags = Array.isArray(beat.tags) ? beat.tags.map((t, position) => ({ position, t })).filter((x) => typeof x.t === 'string')
    .map(({ position, t }) => ({ position, label: t, normKey: t.trim().toLowerCase(), searchKey: t.toLowerCase() })) : [];
  // Display (webLibrary.ts:165-193) y búsqueda search-js-v1 (librarySelectors.ts:17-18): se materializan en SQL (0028).
  const nameDisplay = (typeof beat.name === 'string' ? beat.name : 'Untitled').trim() || 'Untitled';
  const keyDisplay = typeof beat.key === 'string' ? beat.key : '';
  const ratingDisplay = Math.max(0, Math.min(255, Math.trunc(Number(beat.rating) || 0)));
  const nameSearch = nameDisplay.toLowerCase(); const keySearch = keyDisplay.toLowerCase();
  return {
    name: str(beat.name), bpmText: str(beat.bpm), keyText: str(beat.key), color: str(beat.color), color2: str(beat.color2), rating,
    nameDisplay, nameSearch, keyDisplay, keySearch, bpmDisplay, ratingDisplay,
    // 0037: texto único de búsqueda = name_search ␟ key_search ␟ bpm_display ␟ search_key de cada tag (por posición). Con un q sin ␟,
    // `search_text LIKE %q%` es equivalente a la disyunción de los cuatro predicados (un q sin separador no puede cruzar campos).
    searchText: [nameSearch, keySearch, bpmDisplay, ...tags.map((x) => x.searchKey)].join(SEARCH_TEXT_SEP),
    bpmSortClass, bpmSort: bpmSortClass === 1 ? (Object.is(n, -0) ? 0 : n) : null,
    sortOrder: Number.isInteger(beat.sort_order) && Math.abs(beat.sort_order) <= 2147483647 ? beat.sort_order : null,
    telegramTopicId: Number.isSafeInteger(beat.telegram_topic_id) && beat.telegram_topic_id > 0 ? beat.telegram_topic_id : null,
    hasArtwork: sectionPresent(beat.artwork),
    tags,
  };
}

// ---------- comparación semántica C4 (orden de arrays, tipos, ausente vs null; no orden de claves) ----------
function deepDiff(a, b, path = '$', out = []) {
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { out.push({ path, kind: 'TYPE', a: ta, b: tb }); return out; }
  if (ta === 'array') {
    if (a.length !== b.length) out.push({ path, kind: 'LENGTH', a: a.length, b: b.length });
    for (let k = 0; k < Math.min(a.length, b.length); k++) deepDiff(a[k], b[k], `${path}[${k}]`, out);
  } else if (ta === 'object') {
    for (const k of Object.keys(a)) if (!has(b, k)) out.push({ path: `${path}.${k}`, kind: 'MISSING' }); else deepDiff(a[k], b[k], `${path}.${k}`, out);
    for (const k of Object.keys(b)) if (!has(a, k)) out.push({ path: `${path}.${k}`, kind: 'ADDED' });
  } else if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) out.push({ path, kind: 'VALUE' });
  return out;
}

// ---------- documento → filas ----------
const DOC_KEYS = Object.freeze({ name: 'name', bpm: 'bpm', key: 'key', tags: 'tags', rating: 'rating', color: 'color', color2: 'color2', crop: 'image_crop' });
function applyPatchToDoc(doc, set, { replace = false } = {}) {
  const out = { ...doc };
  for (const [field, value] of Object.entries(set)) {
    // REPLACE toma los valores del intent persistido, incluidos campos ajenos a PATCH.
    if (replace) out[field === 'crop' ? DOC_KEYS.crop : field] = value;
    else out[DOC_KEYS[field]] = field === 'tags' ? [...value] : field === 'crop' && value !== null ? { ...value } : value;
  }
  return out;
}

function nativeBeatDocument(beatId, metadata) {
  const doc = { id: beatId, name: metadata.name, bpm: metadata.bpm ?? '', key: metadata.key ?? '', tags: metadata.tags ?? [], rating: metadata.rating ?? 0, color: metadata.color ?? '', color2: metadata.color2 ?? '' };
  if (metadata.crop !== undefined) doc.image_crop = metadata.crop;
  return doc;
}

function tagsEqual(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

const METADATA = [
  ['name', 'name'], ['bpm_text', 'bpmText'], ['key_text', 'keyText'], ['rating', 'rating'],
  ['color', 'color'], ['color2', 'color2'], ['bpm_sort_class', 'bpmSortClass'], ['bpm_sort', 'bpmSort'],
];
const LEGACY = [['legacy_json', 'legacyJson'], ['legacy_sha256', 'legacySha256'], ['legacy_export_bytes', 'legacyExportBytes']];
const DISPLAY = [
  ['name_display', 'nameDisplay'], ['name_search', 'nameSearch'], ['key_display', 'keyDisplay'], ['key_search', 'keySearch'],
  ['bpm_display', 'bpmDisplay'], ['rating_display', 'ratingDisplay'], ['search_text', 'searchText'],
];
const ARTWORK = [['has_artwork', 'hasArtwork']];
const RANK = [['manual_rank', 'manualRank']];
const columns = (fields) => fields.map(([column]) => column).join(', ');
const assignments = (fields, start) => fields.map(([column], i) => `${column} = $${start + i}`).join(', ');

// Posiciones y formato de SQL heredados para cada camino.
const PATCH_FIELDS = [...METADATA, ...ARTWORK, ...LEGACY, ...DISPLAY];
const PATCH_SQL = `UPDATE catalog_beats SET ${assignments(METADATA, 4)},
    ${assignments(PATCH_FIELDS.slice(METADATA.length, -3), 12)},
    ${assignments(DISPLAY.slice(-3), 20)}, version = version + 1, updated_at = now()
  WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 RETURNING version::text AS version`;
const REPLACE_FIELDS = [...METADATA, ...LEGACY, ...DISPLAY];
const REPLACE_SQL = `UPDATE catalog_beats SET ${assignments([...METADATA, ...LEGACY], 4)},
              ${assignments(DISPLAY, 15)} WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3`;
const IMPORT_FIELDS = [...METADATA, ...RANK, ...ARTWORK, ...LEGACY, ...DISPLAY];
const IMPORT_SQL = `INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, ${columns(METADATA)}, sort_order, ${columns([...RANK, ...ARTWORK])},
            ${columns([...LEGACY, ...DISPLAY])})
          VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12::numeric,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`;

function beatRowsFromDoc(doc) {
  const projected = projectBeat(doc);
  const legacyJson = JSON.stringify(doc);
  return {
    ...projected, legacyJson,
    legacySha256: createHash('sha256').update(legacyJson, 'utf8').digest('hex'),
    legacyExportBytes: Buffer.byteLength(legacyJson, 'utf8'),
  };
}

const BEAT_WRITES = {
  PATCH: { sql: PATCH_SQL, fields: PATCH_FIELDS },
  IMPORT: { sql: IMPORT_SQL, fields: IMPORT_FIELDS },
  REPLACE: { sql: REPLACE_SQL, fields: REPLACE_FIELDS },
};

async function writeBeatRow(client, identity, kind, rows) {
  const { sql, fields } = BEAT_WRITES[kind];
  return client.query(sql, [...identity, ...fields.map(([, key]) => rows[key])]);
}

async function writeBeatTags(client, identity, tags, { replace = false } = {}) {
  if (replace) {
    await client.query('DELETE FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', identity);
    await client.query('DELETE FROM catalog_beat_tags WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', identity);
  }
  for (const { position, label, normKey, searchKey } of tags) {
    await client.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [...identity, position, label, normKey, searchKey]);
  }
}

async function writeBeatDoc(client, uid, gen, beatId, doc, { tagsChanged = true } = {}) {
  const rows = beatRowsFromDoc(doc);
  const identity = [uid, gen, beatId];
  const result = await writeBeatRow(client, identity, 'PATCH', rows);
  if (tagsChanged) await writeBeatTags(client, identity, rows.tags, { replace: true });
  return { version: result.rows[0].version };
}

async function insertBeatDoc(client, identity, rows, { manualRank, hasArtwork }) {
  await writeBeatRow(client, identity, 'IMPORT', { ...rows, manualRank, hasArtwork });
  await writeBeatTags(client, identity, rows.tags);
}

async function replaceBeatMetadata(client, uid, gen, beatId, before, metadata) {
  const rows = beatRowsFromDoc(applyPatchToDoc(before, metadata, { replace: true }));
  const identity = [uid, gen, beatId];
  await writeBeatRow(client, identity, 'REPLACE', rows);
  // REPLACE reescribe y vuelve a contar los tags en toda edición de metadata, aun si son idénticos.
  const facetsBefore = await facets.snapshotGroups(client, uid, gen, [beatId]);
  await writeBeatTags(client, identity, rows.tags, { replace: true });
  return facetsBefore;
}

async function refreshBeatTagFacets(client, uid, gen, beatIds, before, revision) {
  await facets.insertGroups(client, uid, gen, beatIds);
  await facets.applyFacetDelta(client, uid, gen, before, await facets.snapshotGroups(client, uid, gen, beatIds), revision);
}

// ---------- filas → cable ----------
const BEAT_HEADER = 'b.beat_id AS id, b.version::text AS version, b.state, b.name_display AS name, b.bpm_display AS bpm, b.key_display AS key,';
const BEAT_DISPLAY = 'b.rating_display AS rating, b.color, b.color2, b.has_artwork';
const BEAT_TAGS = "(SELECT coalesce(array_agg(t.label ORDER BY t.position), '{}') FROM catalog_beat_tags t WHERE t.user_id = b.user_id AND t.generation_id = b.generation_id AND t.beat_id = b.beat_id) AS tags";
const PATCH_BEAT_COLUMNS = `${BEAT_HEADER} ${BEAT_DISPLAY},
        ${BEAT_TAGS}`;
const QUERY_BEAT_COLUMNS = `${BEAT_HEADER}
  ${BEAT_DISPLAY}, b.manual_rank::text AS manual_rank,
  ${BEAT_TAGS},
  (SELECT coalesce(json_agg(json_build_object('slot', cf.slot_key, 'fileId', cf.file_id, 'role', fv.role, 'revision', fv.revision::text) ORDER BY cf.slot_key), '[]'::json)
     FROM catalog_current_files cf JOIN catalog_file_versions fv ON fv.user_id = cf.user_id AND fv.generation_id = cf.generation_id AND fv.file_id = cf.file_id
     WHERE cf.user_id = b.user_id AND cf.generation_id = b.generation_id AND cf.beat_id = b.beat_id) AS files`;

function beatFields(row, tags) {
  return {
    id: row.id, version: row.version, state: row.state, name: row.name, bpm: row.bpm, key: row.key,
    tags, rating: row.rating, color: row.color, color2: row.color2,
  };
}

function patchBeatDto(row) {
  return row ? { ...beatFields(row, row.tags), hasArtwork: row.has_artwork } : null;
}

function itemDto(row) {
  const files = Array.isArray(row.files) ? row.files : [];
  const slot = (k) => files.find((f) => f.slot === k) || null;
  const ref = (f) => (f ? { fileId: f.fileId, revision: f.revision } : null);
  return {
    ...beatFields(row, row.tags || []),
    artwork: ref(slot('ARTWORK')), playback: ref(slot('MASTER')),
    hasArtwork: row.has_artwork === true || slot('ARTWORK') !== null, hasWav: files.some((f) => f.role === 'WAV'), hasStems: files.some((f) => f.role === 'STEMS'),
    hasProject: slot('PROJECT') !== null, fileCount: files.length,
  };
}

module.exports = {
  SEARCH_TEXT_SEP, projectBeat, deepDiff, applyPatchToDoc, nativeBeatDocument, tagsEqual, beatRowsFromDoc,
  writeBeatDoc, insertBeatDoc, replaceBeatMetadata, refreshBeatTagFacets,
  PATCH_BEAT_COLUMNS, QUERY_BEAT_COLUMNS, patchBeatDto, itemDto,
};
