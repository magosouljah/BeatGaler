'use strict';
// Proyección del documento de beat (columna `legacy_json`: el mismo formato JSON de beat que usaba el cliente) a las columnas SQL
// derivadas — nombre/tonalidad/BPM de presentación y búsqueda, orden por BPM, rating, tags normalizados y texto de búsqueda (0028/0037) —
// y comparación semántica de documentos. Puro: sin DB, red ni transporte. Lo usan commands (PATCH), operations (IMPORT/REPLACE),
// name-uniqueness y queries (separador de búsqueda). (E84: antes «legacy-codec.js», que además parseaba y exportaba el INDEX de
// Telegram; esa ruta INDEX → PostgreSQL quedó anulada por NATIVO r2.1 y se retiró.)

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

module.exports = { SEARCH_TEXT_SEP, projectBeat, deepDiff };
