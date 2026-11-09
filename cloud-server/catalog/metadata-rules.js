'use strict';
// T07 — Reglas de validación de metadata compartidas con Cloud (CONTRATO C5 "Validación de nuevos valores").
// Port exacto de src/lib/metadataValidation.ts (validateTag/validateBpm/validateMusicKey); la paridad se prueba contra el TS real.
// Nunca "limpia" en silencio: una lista de tags inválida se rechaza con detalle por posición (no cleanTags en servidor).
// Rating: entero 0–255 (dominio del lector actual). Name: string no vacío tras trim. Colores y crop: contrato UI inventariado en T01.
// Sin DB ni red.

const TAG_MAX = 40;
const TAGS_MAX = 30;
const NAME_MAX_BYTES = 64 * 1024;
const COLOR_MAX = 64;

function normalizeTag(value) { return String(value).trim().toLowerCase().replace(/\s+/g, ' '); }
function validateTag(value) {
  const normalized = normalizeTag(value);
  if (!normalized) return { valid: false, normalized, reason: 'Tag cannot be empty.' };
  if (normalized.length > TAG_MAX) return { valid: false, normalized, reason: 'Maximum length is 40 characters.' };
  if (!/^[a-z0-9]+(?:[ _-][a-z0-9]+)*$/.test(normalized)) {
    return { valid: false, normalized, reason: 'Use only letters, numbers, spaces, hyphens (-), or underscores (_). Symbols such as (), ;, commas, slashes, quotes, and colons are not allowed.' };
  }
  return { valid: true, normalized };
}
function validateBpm(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return { valid: true, normalized: '' };
  if (!/^\d{1,3}(?:\.\d{1,2})?$/.test(normalized)) return { valid: false, normalized, reason: 'BPM must be a number from 60 to 300.' };
  const bpm = Number(normalized);
  if (!Number.isFinite(bpm) || bpm < 60 || bpm > 300) return { valid: false, normalized, reason: 'BPM must be between 60 and 300.' };
  return { valid: true, normalized: String(bpm) };
}
function compactKey(value) { return String(value ?? '').trim().replace(/♯/g, '#').replace(/♭/g, 'b').replace(/\s+/g, ' '); }
function validateMusicKey(value) {
  const raw = compactKey(value);
  if (!raw) return { valid: true, normalized: '' };
  let candidate = raw;
  const longMatch = candidate.match(/^([a-gA-G])([#b]?)[ ]*(major|maj|minor|min)$/i);
  if (longMatch) candidate = `${longMatch[1]}${longMatch[2] || ''}${/^min/i.test(longMatch[3]) ? 'm' : ''}`;
  const match = candidate.match(/^([a-gA-G])([#b]?)(m)?$/i);
  if (!match) return { valid: false, normalized: raw, reason: 'Use A–G with optional # or b. For minor keys add m, for example C#, Ab, cm, c#m, or abm.' };
  const isMinor = !!match[3];
  const root = isMinor ? match[1].toLowerCase() : match[1].toUpperCase();
  const accidental = (match[2] || '').toLowerCase();
  return { valid: true, normalized: `${root}${accidental}${isMinor ? 'm' : ''}` };
}

const PATCH_FIELDS = Object.freeze(['name', 'bpm', 'key', 'tags', 'rating', 'color', 'color2', 'crop']);
const hasControl = (s) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);

// Valida un patch (solo campos presentes, C5: "transmite únicamente campos modificados"). Devuelve {ok, set, errors[]}.
// `set` contiene los valores normalizados que se escriben; los tags deben venir ya en su forma normalizada (el cliente
// normaliza antes de enviar; el servidor no corrige en silencio).
function validatePatch(input) {
  const errors = [];
  const set = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, set, errors: [{ field: '$', reason: 'patch must be an object' }] };
  const unknown = Object.keys(input).filter((k) => !PATCH_FIELDS.includes(k));
  for (const k of unknown) errors.push({ field: k, reason: 'field is not patchable' });
  if ('name' in input) {
    const v = input.name;
    if (typeof v !== 'string' || !v.trim()) errors.push({ field: 'name', reason: 'name must be a non-empty string' });
    else if (Buffer.byteLength(v, 'utf8') > NAME_MAX_BYTES) errors.push({ field: 'name', reason: 'name exceeds 64 KiB' });
    else if (hasControl(v)) errors.push({ field: 'name', reason: 'name contains control characters' });
    else set.name = v;
  }
  if ('bpm' in input) {
    if (typeof input.bpm !== 'string') errors.push({ field: 'bpm', reason: 'bpm must be a string' });
    else { const r = validateBpm(input.bpm); if (!r.valid) errors.push({ field: 'bpm', reason: r.reason }); else set.bpm = r.normalized; }
  }
  if ('key' in input) {
    if (typeof input.key !== 'string') errors.push({ field: 'key', reason: 'key must be a string' });
    else { const r = validateMusicKey(input.key); if (!r.valid) errors.push({ field: 'key', reason: r.reason }); else set.key = r.normalized; }
  }
  if ('tags' in input) {
    const tags = input.tags;
    if (!Array.isArray(tags)) errors.push({ field: 'tags', reason: 'tags must be an array' });
    else if (tags.length > TAGS_MAX) errors.push({ field: 'tags', reason: `at most ${TAGS_MAX} tags` });
    else {
      const seen = new Set(); let ok = true;
      tags.forEach((t, i) => {
        if (typeof t !== 'string') { errors.push({ field: `tags[${i}]`, reason: 'tag must be a string' }); ok = false; return; }
        const r = validateTag(t);
        if (!r.valid) { errors.push({ field: `tags[${i}]`, tag: t, reason: r.reason }); ok = false; return; }
        if (r.normalized !== t) { errors.push({ field: `tags[${i}]`, tag: t, reason: `tag must be sent normalized as "${r.normalized}"` }); ok = false; return; }
        if (seen.has(t)) { errors.push({ field: `tags[${i}]`, tag: t, reason: 'duplicate tag' }); ok = false; return; }
        seen.add(t);
      });
      if (ok) set.tags = [...tags];
    }
  }
  if ('rating' in input) {
    const v = input.rating;
    if (!Number.isInteger(v) || v < 0 || v > 255) errors.push({ field: 'rating', reason: 'rating must be an integer 0–255' });
    else set.rating = v;
  }
  for (const k of ['color', 'color2']) {
    if (!(k in input)) continue;
    const v = input[k];
    if (typeof v !== 'string' || v.length > COLOR_MAX || hasControl(v)) errors.push({ field: k, reason: `${k} must be a string of at most ${COLOR_MAX} characters` });
    else set[k] = v;
  }
  if ('crop' in input) {
    const v = input.crop;
    if (v === null) set.crop = null;
    else if (!v || typeof v !== 'object' || Array.isArray(v) || v.unit !== 'ratio'
      || !['x', 'y', 'w', 'h'].every((f) => typeof v[f] === 'number' && Number.isFinite(v[f]) && v[f] >= 0 && v[f] <= 1)
      || Object.keys(v).some((f) => !['x', 'y', 'w', 'h', 'unit'].includes(f))) {
      errors.push({ field: 'crop', reason: 'crop must be null or {x,y,w,h in [0,1], unit:"ratio"}' });
    } else set.crop = { x: v.x, y: v.y, w: v.w, h: v.h, unit: 'ratio' };
  }
  if (!errors.length && Object.keys(set).length === 0) errors.push({ field: '$', reason: 'patch has no fields' });
  return { ok: errors.length === 0, set, errors };
}

module.exports = { TAG_MAX, TAGS_MAX, NAME_MAX_BYTES, COLOR_MAX, PATCH_FIELDS, normalizeTag, validateTag, validateBpm, validateMusicKey, validatePatch };
