'use strict';
// T06 — Cursores opacos firmados (C12-DECISION-RECORD §4.2, MATRIZ-V V02 §11).
//  token = base64url(payloadCanónico) + '.' + base64url(HMAC-SHA256(payloadCanónico))
//  - La firma se verifica en tiempo constante antes de confiar en cualquier campo.
//  - HMAC autentica, no cifra: el payload nunca lleva rutas de medios, secretos ni raw.
//  - kid desconocido o firma inválida → 400 CURSOR_INVALID; kid retirado conocido con firma válida → 409 CURSOR_STALE.
//  - Límite de token 16 KiB. Sin expiración temporal: revisión/era/época/generación/perfil invalidan (lo decide queries.js).
// Sin DB ni red.

const crypto = require('crypto');
const { canonicalJson, CatalogAuthorityError } = require('./authority');

const CURSOR_VERSION = 1;
const CURSOR_MAX_BYTES = 16 * 1024;
const CURSOR_KEYS_ENV = 'BEATGALER_CATALOG_CURSOR_KEYS';

class CatalogQueryError extends CatalogAuthorityError {
  constructor(code, status, message, detail = {}) { super(code, status, message, detail); this.name = 'CatalogQueryError'; }
}
const invalid = (reason) => new CatalogQueryError('CURSOR_INVALID', 400, 'cursor is invalid', { reason });

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function hmac(secret, text) { return crypto.createHmac('sha256', secret).update(text, 'utf8').digest(); }

function normalizeKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('cursor signer requires at least one key');
  const out = keys.map((k) => {
    if (!k || typeof k.kid !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(k.kid)) throw new Error('cursor key kid must match ^[A-Za-z0-9_-]{1,32}$');
    const secret = Buffer.isBuffer(k.secret) ? k.secret : Buffer.from(String(k.secret || ''), /^[0-9a-f]+$/i.test(String(k.secret || '')) && String(k.secret).length % 2 === 0 ? 'hex' : 'utf8');
    if (secret.length < 32) throw new Error(`cursor key ${k.kid} must have at least 32 bytes of secret`);
    return Object.freeze({ kid: k.kid, secret, retired: k.retired === true });
  });
  if (new Set(out.map((k) => k.kid)).size !== out.length) throw new Error('cursor key kids must be unique');
  if (!out.some((k) => !k.retired)) throw new Error('cursor signer needs one active (non-retired) key');
  return out;
}

// Claves desde el entorno: JSON [{kid, secret(hex|utf8), retired?}]. Sin variable → clave efímera del proceso
// (válida solo en LOCAL/CI de un proceso; T16 exige la variable en entornos activados).
function keysFromEnv(env = process.env, { allowEphemeral = true, randomBytes = crypto.randomBytes } = {}) {
  const raw = env[CURSOR_KEYS_ENV];
  if (raw && String(raw).trim()) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${CURSOR_KEYS_ENV} must be a JSON array`); }
    return { keys: normalizeKeys(parsed), source: 'env' };
  }
  if (!allowEphemeral) throw new Error(`${CURSOR_KEYS_ENV} is required`);
  return { keys: normalizeKeys([{ kid: 'ephemeral', secret: randomBytes(32) }]), source: 'ephemeral' };
}

function createCursorSigner({ keys, activeKid = null } = {}) {
  const ring = normalizeKeys(keys);
  const active = ring.find((k) => (activeKid ? k.kid === activeKid : !k.retired));
  if (!active || active.retired) throw new Error('active cursor key not found or retired');

  function sign(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('cursor payload must be an object');
    const text = canonicalJson({ ...payload, v: CURSOR_VERSION, kid: active.kid });
    const token = `${b64u(text)}.${b64u(hmac(active.secret, text))}`;
    if (Buffer.byteLength(token, 'utf8') > CURSOR_MAX_BYTES) throw new CatalogQueryError('CURSOR_TOO_LARGE', 500, 'signed cursor exceeds 16 KiB', {});
    return token;
  }

  // Devuelve { payload, kid, retired }. Lanza CatalogQueryError 400 CURSOR_INVALID; kid retirado → 409 CURSOR_STALE.
  function verify(token) {
    if (typeof token !== 'string' || !token) throw invalid('FORMAT');
    if (Buffer.byteLength(token, 'utf8') > CURSOR_MAX_BYTES) throw invalid('TOO_LARGE');
    const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!m) throw invalid('FORMAT');
    let text; let payload;
    try { text = Buffer.from(m[1], 'base64url').toString('utf8'); payload = JSON.parse(text); } catch { throw invalid('FORMAT'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid('FORMAT');
    if (payload.v !== CURSOR_VERSION) throw invalid('VERSION');
    const key = ring.find((k) => k.kid === payload.kid);
    if (!key) throw invalid('UNKNOWN_KEY');
    // Canonicalización obligatoria: un payload re-serializado de otra forma no es el firmado.
    if (canonicalJson(payload) !== text) throw invalid('NOT_CANONICAL');
    const expected = hmac(key.secret, text);
    const given = Buffer.from(m[2], 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw invalid('SIGNATURE');
    if (key.retired) throw new CatalogQueryError('CURSOR_STALE', 409, 'cursor was signed with a retired key', { reason: 'KEY_RETIRED' });
    return { payload, kid: key.kid };
  }

  return Object.freeze({ sign, verify, activeKid: active.kid, kids: ring.map((k) => k.kid) });
}

module.exports = { CURSOR_VERSION, CURSOR_MAX_BYTES, CURSOR_KEYS_ENV, CatalogQueryError, createCursorSigner, keysFromEnv, normalizeKeys };
