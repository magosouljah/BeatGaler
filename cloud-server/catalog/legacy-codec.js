'use strict';
// T04 — Codec del INDEX legacy (CONTRATO C4 + reglas T01-B). Puro: sin DB, red ni transporte.
//  - parseStrict: UTF-8 estricto y JSON estricto (claves duplicadas, enteros no seguros, overflow, BOM => REVIEW).
//  - validateIndex: reglas REVIEW/flags de contract-map stops[*].t01b y CS-050; nunca normaliza ni corrige.
//  - project*: proyecciones JS fijadas (search-js-v1 / A2 r4) a partir del raw, sin alterarlo.
//  - deepDiff: igualdad semántica profunda C4 (orden de arrays, tipos, ausente vs null; no orden de claves).
//  - exportBudget: cota incremental de bytes de export (C4 presupuesto reversible).

const SCHEMA = 'beatgaler.telegram.library';
const PROJECTION_VERSION = 1;
const ROLLBACK_MAX_BYTES = 15 * 1024 * 1024;
const SLOT_KEYS = Object.freeze(['master', 'artwork', 'project']);

// ---------- parseo estricto ----------
function parseStrict(input) {
  const issues = [];
  let text;
  if (typeof input === 'string') text = input;
  else {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
    catch { return { ok: false, issues: [{ code: 'INVALID_UTF8', path: '$' }] }; }
  }
  if (text.charCodeAt(0) === 0xfeff) return { ok: false, issues: [{ code: 'BOM', path: '$' }] };
  let i = 0;
  const fail = (code) => { const e = new Error(code); e.code = code; e.at = i; throw e; };
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i++; };
  function value(path, depth) {
    if (depth > 256) fail('DEPTH');
    ws();
    const c = text[i];
    if (c === '{') {
      i++; const obj = {}; const seen = new Set(); ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws(); if (text[i] !== '"') fail('INVALID_JSON');
        const key = string();
        ws(); if (text[i] !== ':') fail('INVALID_JSON'); i++;
        const p = `${path}.${key}`;
        if (seen.has(key)) issues.push({ code: 'DUPLICATE_KEY', path: p });
        seen.add(key);
        Object.defineProperty(obj, key, { value: value(p, depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('INVALID_JSON');
      }
    }
    if (c === '[') {
      i++; const arr = []; ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(`${path}[${arr.length}]`, depth + 1)); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail('INVALID_JSON');
      }
    }
    if (c === '"') return string();
    const m = /^-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (m) {
      i += m[0].length; const n = Number(m[0]);
      if (!Number.isFinite(n)) issues.push({ code: 'NUMBER_OVERFLOW', path });
      else if (!m[1] && !m[2] && !Number.isSafeInteger(n)) issues.push({ code: 'UNSAFE_INTEGER', path });
      return n;
    }
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(lit, i)) { i += lit.length; return v; }
    return fail('INVALID_JSON');
  }
  function string() {
    const start = i; i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    if (i >= text.length) fail('INVALID_JSON');
    i++;
    try { return JSON.parse(text.slice(start, i)); } catch { return fail('INVALID_JSON'); }
  }
  try {
    const v = value('$', 0); ws();
    if (i !== text.length) fail('INVALID_JSON');
    return { ok: issues.length === 0, value: v, issues, text };
  } catch (e) {
    return { ok: false, issues: [...issues, { code: e.code || 'INVALID_JSON', path: `@${e.at ?? i}` }] };
  }
}

// ---------- utilidades ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const hasNul = (s) => typeof s === 'string' && s.includes('\u0000');
const hasLoneSurrogate = (s) => typeof s === 'string' && /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
const unrepresentable = (s) => hasNul(s) || hasLoneSurrogate(s);
const directId = (loc) => { const m = typeof loc === 'string' ? /^direct:([1-9]\d{0,17})$/.exec(loc) : null; return m ? Number(m[1]) : null; };

function beatIdIssues(id) {
  if (typeof id !== 'string') return ['NOT_STRING'];
  const out = [];
  const cps = [...id].length;
  if (id.length < 1 || id.length > 256) out.push('UTF16_LENGTH');
  if (cps < 1 || cps > 256) out.push('CODEPOINT_LENGTH');
  if (id !== id.trim()) out.push('EDGE_WHITESPACE');
  if (unrepresentable(id)) out.push('UNREPRESENTABLE');
  return out;
}

// Referencias físicas de un beat: todas las versiones/partes (D-05). Devuelve [{path, messageId, locator}].
function collectRefs(beat, base) {
  const refs = [];
  const visit = (v, p) => {
    if (Array.isArray(v)) { v.forEach((x, k) => visit(x, `${p}[${k}]`)); return; }
    if (!isObj(v)) return;
    const loc = v.telegram_file_id;
    const mid = v.telegram_message_id;
    if (typeof loc === 'string' || (typeof mid === 'number' && mid > 0)) refs.push({ path: p, messageId: typeof mid === 'number' && mid > 0 ? mid : directId(loc), locator: typeof loc === 'string' ? loc : null });
    for (const [k, x] of Object.entries(v)) if (k !== 'telegram_file_id' && k !== 'telegram_message_id') visit(x, `${p}.${k}`);
  };
  for (const k of [...SLOT_KEYS, 'files']) if (has(beat, k)) visit(beat[k], `${base}.${k}`);
  if (typeof beat.metadata_message_id === 'number' && beat.metadata_message_id > 0) refs.push({ path: `${base}.metadata_message_id`, messageId: beat.metadata_message_id, locator: null });
  return refs;
}

// D-04: sección ausente sii null/ausente u objeto sin ningún escalar no-null.
function sectionPresent(v) {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.some(sectionPresent);
  if (isObj(v)) return Object.values(v).some(sectionPresent);
  return true;
}

function trashBeat(item) { return isObj(item) && has(item, 'beat') ? item.beat : item; }

// ---------- validación (REVIEW bloquea la biblioteca; flags se preservan) ----------
function validateIndex(doc, ctx = {}) {
  const review = []; const flags = [];
  const R = (code, path) => review.push({ code, path });
  const F = (code, path) => flags.push({ code, path });
  if (!isObj(doc)) { R('ROOT_NOT_OBJECT', '$'); return { eligible: false, review, flags }; }
  if (doc.schema !== SCHEMA) R('SCHEMA', '$.schema');
  if (has(doc, 'version') && !(doc.version === 1 || doc.version === 2)) R('VERSION_UNSUPPORTED', '$.version');
  if (!has(doc, 'version')) F('VERSION_IMPLICIT_V1', '$.version');
  if (!Array.isArray(doc.beats)) R('BEATS_NOT_ARRAY', '$.beats');
  for (const k of ['trash', 'deleted', 'garbage']) if (has(doc, k) && !Array.isArray(doc[k])) R(`${k.toUpperCase()}_NOT_ARRAY`, `$.${k}`);
  if (review.length) return { eligible: false, review, flags };

  const ids = new Map(); // id -> primera ruta
  const live = new Set();
  const refOwners = new Map(); // messageId -> beat path
  const checkBeat = (beat, path) => {
    if (!isObj(beat)) { R('BEAT_NOT_OBJECT', path); return; }
    const issues = beatIdIssues(beat.id);
    for (const x of issues) R(`BEAT_ID_${x}`, `${path}.id`);
    if (!issues.length) {
      if (ids.has(beat.id)) R('ID_DUPLICATE', `${path}.id`); else ids.set(beat.id, path);
      live.add(beat.id);
      if (!/^[A-Za-z0-9._:@+-]{1,192}$/.test(beat.id)) F('DIRECT_SCOPE_INCOMPATIBLE', `${path}.id`);
    }
    for (const k of ['name', 'bpm', 'key', 'color', 'color2']) if (unrepresentable(beat[k])) R('PROJECTED_UNREPRESENTABLE', `${path}.${k}`);
    if (Array.isArray(beat.tags)) beat.tags.forEach((t, k) => { if (unrepresentable(t)) R('PROJECTED_UNREPRESENTABLE', `${path}.tags[${k}]`); });
    for (const ref of collectRefs(beat, path)) {
      if (unrepresentable(ref.locator)) R('PROJECTED_UNREPRESENTABLE', ref.path);
      if (ref.locator !== null && directId(ref.locator) === null) F('OPAQUE_LOCATOR', ref.path);
      if (ref.messageId != null) {
        const owner = refOwners.get(ref.messageId);
        if (owner && owner !== path) F('SHARED_REFERENCE', ref.path); else refOwners.set(ref.messageId, path);
      }
    }
    // Referencia a nivel manifest distinta de todas sus partes: C3 no la representa (STOP-CONTRACT T04) => REVIEW.
    const sections = [...SLOT_KEYS.map((k) => [beat[k], `${path}.${k}`]), ...(Array.isArray(beat.files) ? beat.files.map((f, j) => [f, `${path}.files[${j}]`]) : [])];
    for (const [sec, sp] of sections) {
      const man = isObj(sec) && isObj(sec.manifest) ? sec.manifest : null;
      if (!man || !Array.isArray(man.parts)) continue;
      const ml = typeof man.telegram_file_id === 'string' ? man.telegram_file_id : null;
      const mm = typeof man.telegram_message_id === 'number' ? man.telegram_message_id : null;
      if (ml === null && mm === null) continue;
      const same = man.parts.some((pt) => isObj(pt) && (ml === null || pt.telegram_file_id === ml) && (mm === null || pt.telegram_message_id === mm));
      if (!same) R('MANIFEST_REF_UNREPRESENTED', `${sp}.manifest`);
    }
    const sizeZero = (v, p) => { if (Array.isArray(v)) v.forEach((x, k) => sizeZero(x, `${p}[${k}]`)); else if (isObj(v)) for (const [k, x] of Object.entries(v)) { if (k === 'size' && x === 0) F('SIZE_ZERO', `${p}.size`); else sizeZero(x, `${p}.${k}`); } };
    sizeZero(beat, path);
  };
  doc.beats.forEach((b, k) => checkBeat(b, `$.beats[${k}]`));
  (doc.trash || []).forEach((item, k) => {
    const p = `$.trash[${k}]`;
    if (!isObj(item)) { R('TRASH_SHAPE', p); return; }
    if (has(item, 'beat')) { if (!isObj(item.beat)) { R('TRASH_BEAT_NOT_OBJECT', `${p}.beat`); return; } checkBeat(item.beat, `${p}.beat`); }
    else if (typeof item.id === 'string') { F('TRASH_UNWRAPPED', p); checkBeat(item, p); }
    else R('TRASH_SHAPE', p);
  });
  (doc.deleted || []).forEach((d, k) => {
    const p = `$.deleted[${k}]`;
    if (!isObj(d)) { R('DELETED_SHAPE', p); return; }
    const a = d.beat_id; const b = d.id;
    if (a === undefined && b === undefined) { R('DELETED_KEY_MISSING', p); return; }
    if (a !== undefined && b !== undefined && a !== b) { R('DELETED_KEY_CONFLICT', p); return; }
    const id = a !== undefined ? a : b;
    if (typeof id !== 'string' || beatIdIssues(id).length) { R('DELETED_ID_INVALID', p); return; }
    if (live.has(id)) R('LIVE_VS_TOMBSTONE', p);
    else if (ids.has(id)) R('ID_DUPLICATE', p); else ids.set(id, p);
  });
  (doc.garbage || []).forEach((g, k) => {
    if (isObj(g) && typeof g.message_id === 'number' && refOwners.has(g.message_id)) R('GARBAGE_INTERSECTS_LIVE', `$.garbage[${k}].message_id`);
  });
  for (const t of ctx.sqlTombstones || []) {
    if (t.state === 'PENDING') R('PENDING_PURGE', `sql:${t.beat_id}`);
    else if (live.has(t.beat_id)) R('LIVE_VS_TOMBSTONE', `sql:${t.beat_id}`);
  }
  const cd = ctx.cloudData;
  if (cd) {
    const links = ctx.links || (ctx.link ? [ctx.link] : []);
    const user = ctx.importingUser || (ctx.link && ctx.link.user_id);
    const mine = new Set(links.filter((l) => l.user_id === user && l.verified_against_vaults).map((l) => l.installation_id));
    const owners = (inst) => new Set(links.filter((l) => l.installation_id === inst).map((l) => l.user_id));
    const byId = new Map(doc.beats.map((b) => [isObj(b) ? b.id : undefined, b]));
    for (const [key, entry] of Object.entries(cd.beatTopics || {})) {
      const [inst, ...rest] = key.split(':'); const beatId = rest.join(':');
      if (owners(inst).size !== 1 || !mine.has(inst)) { if (byId.has(beatId) || owners(inst).size > 1) R('TOPIC_MAP_LINK_AMBIGUOUS', `cloud:beatTopics.${key}`); continue; }
      const beat = byId.get(beatId);
      if (beat && beat.telegram_topic_id !== undefined && entry && entry.messageThreadId !== beat.telegram_topic_id) R('TOPIC_MAP_MISMATCH', `cloud:beatTopics.${key}`);
    }
    const slotOwner = new Map();
    doc.beats.forEach((b) => { if (isObj(b)) for (const r of collectRefs(b, '')) if (r.messageId != null) slotOwner.set(r.messageId, b.id); });
    for (const [key, entry] of Object.entries(cd.uploadedFiles || {})) {
      const mid = isObj(entry) ? entry.telegramMessageId : undefined;
      if (slotOwner.has(mid) && slotOwner.get(mid) !== entry.beatId) R('UPLOADED_FILES_BEAT_MISMATCH', `cloud:uploadedFiles.${key}`);
    }
    for (const key of Object.keys(cd.messageRedirects || {})) {
      const oldId = Number(key.split(':').pop());
      if (slotOwner.has(oldId)) R('MESSAGE_REDIRECT_STALE', `cloud:messageRedirects.${key}`);
    }
  }
  if (typeof ctx.exportBytes === 'number' && ctx.exportBytes > (ctx.rollbackMaxBytes || ROLLBACK_MAX_BYTES)) F('ROLLBACK_CAPACITY_EXCEEDED', '$');
  const eligible = review.length === 0 && !flags.some((f) => f.code === 'ROLLBACK_CAPACITY_EXCEEDED');
  return { eligible, review, flags };
}

// Entrada sin INDEX: puntero ausente en biblioteca no vacía nunca es "vacía certificada" (C4).
function validateSource({ index, descriptor }) {
  if (index != null) return null;
  const n = descriptor ? Number(descriptor.library_beats_count) : 0;
  return { eligible: false, review: [{ code: n > 0 ? 'POINTER_ABSENT_NONEMPTY' : 'POINTER_ABSENT', path: '$' }], flags: [] };
}

// ---------- proyecciones (search-js-v1 / A2) ----------
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
  return {
    name: str(beat.name), bpmText: str(beat.bpm), keyText: str(beat.key), color: str(beat.color), color2: str(beat.color2), rating,
    nameDisplay, nameSearch: nameDisplay.toLowerCase(), keyDisplay, keySearch: keyDisplay.toLowerCase(), bpmDisplay, ratingDisplay,
    bpmSortClass, bpmSort: bpmSortClass === 1 ? (Object.is(n, -0) ? 0 : n) : null,
    sortOrder: Number.isInteger(beat.sort_order) && Math.abs(beat.sort_order) <= 2147483647 ? beat.sort_order : null,
    telegramTopicId: Number.isSafeInteger(beat.telegram_topic_id) && beat.telegram_topic_id > 0 ? beat.telegram_topic_id : null,
    hasArtwork: sectionPresent(beat.artwork),
    tags,
  };
}

// ---------- comparación semántica C4 ----------
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

// ---------- presupuesto de export ----------
// Cota superior de bytes del export autoritativo compacto. Por beat: bytes de su JSON + slack de sort_order
// regenerado (dígitos de n-1). Se suman wrappers, tombstones (incluidos SQL-only), garbage, extras y esqueleto.
function exportBudget({ beatJsons, trashJsons = [], deletedJsons = [], sqlOnlyTombstones = 0, garbageJsons = [], rootExtraJsons = [], rootKeyCount = 6 }) {
  const n = beatJsons.length + trashJsons.length;
  const sortSlack = String(Math.max(0, n - 1)).length + '"sort_order":,'.length;
  const bytes = (s) => Buffer.byteLength(s, 'utf8');
  let total = 2 + rootKeyCount * 4 + 64; // {} + comillas/dos puntos/comas por clave + holgura de cabecera
  for (const s of beatJsons) total += bytes(s) + 1 + sortSlack;
  for (const s of trashJsons) total += bytes(s) + 1 + sortSlack;
  for (const s of deletedJsons) total += bytes(s) + 1;
  total += sqlOnlyTombstones * (bytes('{"beat_id":,"deleted_at":}') + 2 * 258 + 32 + 1);
  for (const s of garbageJsons) total += bytes(s) + 1;
  for (const s of rootExtraJsons) total += bytes(s) + 1;
  total += 'beats trash deleted garbage'.length + 8 * 4;
  return total;
}
function checkBudget(estimate, limit = ROLLBACK_MAX_BYTES) {
  if (estimate > limit) { const e = new Error('ROLLBACK_CAPACITY_EXCEEDED'); e.code = 'ROLLBACK_CAPACITY_EXCEEDED'; e.estimate = estimate; e.limit = limit; throw e; }
  return true;
}

module.exports = {
  SCHEMA, PROJECTION_VERSION, ROLLBACK_MAX_BYTES, SLOT_KEYS, parseStrict, validateSource, validateIndex, projectBeat, collectRefs, sectionPresent,
  trashBeat, deepDiff, exportBudget, checkBudget, beatIdIssues, directId, isObj,
};
