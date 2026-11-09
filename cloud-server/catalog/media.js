'use strict';
// T14 — Acceso a medios por referencia SQL y gateway (NATIVO r2.1 §8.6; TAREAS §T14.1–3; CONTRATO C7.9, §C9 acceso denegado).
//  - `issueAccess(fileId)`: autoriza por tenant + generación activa + beat ACTIVE (TRASH/PURGING/tombstone → 403 ACCESS_DENIED) + archivo
//    vigente en su slot (`catalog_current_files`) con versión VERIFIED + ubicaciones KNOWN con objeto PRESENT (chat CURRENT o RETIRED).
//    Devuelve una concesión opaca POR PARTE (solo su hash en SQL), con tamaño/hash disponibles y la clave de caché
//    `(epoch, beat, fileId, revision)`: la caché del cliente se invalida por versión/época, no solo por id de beat.
//  - `stream(token, range)`: redime la concesión (vigente, mismo usuario), resuelve chat/message desde la ubicación y transmite los bytes
//    del gateway por trozos con `Range` (206/200) sin cargar la parte en memoria ni exponer ids del proveedor. Errores del proveedor
//    antes del primer byte → 502/404/403 estables; "no encontrado" no se interpreta como borrado (C9).
//  - Multipart: todas las partes en orden; el cliente verifica tamaño total y hash cuando existe (sin comportamiento de "primera parte").
// Solo SQL + crypto. El gateway (T11) se inyecta.

const crypto = require('crypto');
const { requireUserId } = require('./contract');
const { CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');
const { STATEMENT_TIMEOUT_MS } = require('./queries');

const GRANT_TTL_MS = 15 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const FILE_ID_RE = /^[A-Za-z0-9._:@+-]{1,256}$/;
const CHUNK_BYTES = 512 * 1024;

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const notFound = (what) => new CatalogQueryError('NOT_FOUND', 404, `${what} is not accessible`, {});
const sqlError = (error) => {
  if (error instanceof CatalogAuthorityError || error instanceof CatalogQueryError) return error;
  if (error?.code === '57014') return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog statement timed out', { sqlstate: '57014' });
  return new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog is unavailable (SQL_ERROR)', { reason: 'SQL_ERROR', sqlstate: error?.code || null, sql_message: error?.code ? String(error.message).slice(0, 200) : null });
};
const LIB_SQL = `SELECT l.authority, l.authority_era::text AS authority_era, l.authority_epoch::text AS authority_epoch, l.revision::text AS revision, l.active_generation_id FROM catalog_libraries l WHERE l.user_id = $1`;

function newToken(randomBytes = crypto.randomBytes) { return randomBytes(32).toString('base64url'); }
function tokenHash(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new CatalogQueryError('MEDIA_GRANT_INVALID', 403, 'media grant is invalid', { reason: 'FORMAT' });
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}
// Range (RFC 9110 §14): un solo rango `bytes=a-b` | `bytes=a-` | `bytes=-n`; inválido/insatisfacible → 416.
function parseRange(header, size) {
  if (header == null || header === '') return { start: 0, end: size - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) throw new CatalogQueryError('RANGE_NOT_SATISFIABLE', 416, 'range header is invalid', { size });
  let start; let end;
  if (m[1] === '') { const n = Number(m[2]); if (!Number.isSafeInteger(n) || n <= 0) throw new CatalogQueryError('RANGE_NOT_SATISFIABLE', 416, 'range suffix is invalid', { size }); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2])); }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) throw new CatalogQueryError('RANGE_NOT_SATISFIABLE', 416, 'range is not satisfiable', { size });
  return { start, end, partial: true };
}

function createCatalogMedia({ pool = null, authority = null, gateway = null, grantTtlMs = GRANT_TTL_MS, randomBytes = crypto.randomBytes, log = () => {} } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createCatalogMedia requires a pool');
  if (!authority || typeof authority.availability !== 'function') throw new Error('createCatalogMedia requires the catalog authority');
  const metrics = { grants: 0, streams: 0, bytes: 0, denied: 0, providerErrors: 0 };

  async function readTx(userId, fn) {
    const uid = requireUserId(userId);
    await authority.availability();
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try { await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`); return await fn(client, uid); } finally { await client.query('COMMIT').catch(() => {}); }
    } catch (error) { throw sqlError(error); } finally { client.release(); }
  }
  async function libraryOf(client, uid) {
    const q = await client.query('SELECT 1 FROM control_plane_flush_quarantine WHERE user_id = $1 AND resolved_at IS NULL LIMIT 1', [uid]);
    if (q.rows.length) throw new CatalogAuthorityError('VAULT_QUARANTINED', 409, 'vault is quarantined by the control-plane flush', {});
    const lib = (await client.query(LIB_SQL, [uid])).rows[0];
    if (!lib || lib.authority !== 'POSTGRES' || !lib.active_generation_id) throw new CatalogQueryError('LIBRARY_NOT_PROVISIONED', 404, 'library is not native', {});
    return lib;
  }
  const denied = (reason, extra = {}) => { metrics.denied++; return new CatalogQueryError('ACCESS_DENIED', 403, `media access denied (${reason})`, { ...extra, reason }); };

  // ---------- POST /files/:fileId/access ----------
  async function issueAccess({ userId, fileId, epoch = null } = {}) {
    if (typeof fileId !== 'string' || !FILE_ID_RE.test(fileId)) throw inputInvalid('FILE_ID');
    const plan = await readTx(userId, async (client, uid) => {
      const lib = await libraryOf(client, uid);
      if (epoch !== null && String(epoch) !== lib.authority_epoch) throw new CatalogQueryError('CATALOG_EPOCH_STALE', 409, 'client epoch differs from the library epoch', { current_epoch: lib.authority_epoch });
      const gen = lib.active_generation_id;
      const fv = (await client.query(`SELECT fv.file_id, fv.beat_id, fv.role, fv.revision::text AS revision, fv.filename, fv.mime, fv.size_bytes::text AS size_bytes, fv.verified_sha256, fv.declared_sha256, fv.status,
          b.state AS beat_state, (SELECT cf.slot_key FROM catalog_current_files cf WHERE cf.user_id = fv.user_id AND cf.generation_id = fv.generation_id AND cf.file_id = fv.file_id LIMIT 1) AS slot_key,
          EXISTS (SELECT 1 FROM catalog_tombstones t WHERE t.user_id = fv.user_id AND t.generation_id = fv.generation_id AND t.beat_id = fv.beat_id) AS tombstone
        FROM catalog_file_versions fv JOIN catalog_beats b ON b.user_id = fv.user_id AND b.generation_id = fv.generation_id AND b.beat_id = fv.beat_id
        WHERE fv.user_id = $1 AND fv.generation_id = $2 AND fv.file_id = $3`, [uid, gen, fileId])).rows[0];
      if (!fv) throw notFound('file');
      if (fv.tombstone || fv.beat_state === 'PURGING' || fv.beat_state === 'PURGED') throw denied('PURGE_PENDING', { state: fv.beat_state });
      if (fv.beat_state !== 'ACTIVE') throw denied('BEAT_NOT_ACTIVE', { state: fv.beat_state });
      if (!fv.slot_key) throw denied('FILE_NOT_CURRENT', { status: fv.status });
      if (fv.status !== 'VERIFIED') throw denied('FILE_NOT_VERIFIED', { status: fv.status });
      const parts = (await client.query(`SELECT p.part_index, p.size_bytes::text AS size_bytes, coalesce(p.verified_sha256, p.declared_sha256) AS sha256, p.verified_sha256 IS NOT NULL AS hash_verified, l.object_id, l.verification_level, o.status AS object_status, o.chat_id, o.message_id::text AS message_id
          FROM catalog_file_parts p
          LEFT JOIN catalog_part_locations l ON l.user_id = p.user_id AND l.generation_id = p.generation_id AND l.file_id = p.file_id AND l.part_index = p.part_index AND l.location = 'PRIMARY' AND l.reference_class = 'KNOWN'
          LEFT JOIN catalog_media_objects o ON o.user_id = l.user_id AND o.object_id = l.object_id
          WHERE p.user_id = $1 AND p.generation_id = $2 AND p.file_id = $3 ORDER BY p.part_index`, [uid, gen, fileId])).rows;
      if (!parts.length) throw denied('NO_PARTS');
      for (const p of parts) {
        if (!p.object_id) throw denied('PART_OPAQUE', { part_index: p.part_index }); // referencia OPAQUE: no hay ubicación conocida que servir
        if (p.object_status !== 'PRESENT') throw denied('OBJECT_NOT_PRESENT', { part_index: p.part_index, status: p.object_status });
        if (!p.size_bytes) throw denied('PART_SIZE_UNKNOWN', { part_index: p.part_index });
      }
      return { lib, gen, fv, parts };
    });
    // Emisión de concesiones (escritura breve, sin transacción larga; una por parte).
    const uid = requireUserId(userId);
    const issued = [];
    const ttlS = Math.max(1, Math.round(grantTtlMs / 1000));
    for (const p of plan.parts) {
      const token = newToken(randomBytes); const hash = tokenHash(token);
      let r;
      try {
        r = await pool.query(`INSERT INTO catalog_media_grants(grant_hash, user_id, generation_id, file_id, part_index, beat_id, authority_epoch, file_revision, object_id, status, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint, $9, 'ACTIVE', now() + make_interval(secs => $10)) RETURNING expires_at`, [hash, uid, plan.gen, fileId, p.part_index, plan.fv.beat_id, plan.lib.authority_epoch, plan.fv.revision, p.object_id, ttlS]);
      } catch (error) { throw sqlError(error); }
      issued.push({ partIndex: p.part_index, size: Number(p.size_bytes), sha256: p.sha256, hashVerified: p.hash_verified, verificationLevel: p.verification_level, token, url: `/catalog/v1/media/${token}`, expiresAt: r.rows[0].expires_at });
    }
    metrics.grants += issued.length;
    const total = plan.parts.reduce((n, p) => n + Number(p.size_bytes), 0);
    return {
      fileId, beatId: plan.fv.beat_id, role: plan.fv.role, slotKey: plan.fv.slot_key, revision: plan.fv.revision, filename: plan.fv.filename, mime: plan.fv.mime,
      sizeBytes: plan.fv.size_bytes ? Number(plan.fv.size_bytes) : total, partsTotalBytes: total, sha256: plan.fv.verified_sha256 ?? null, declaredSha256: plan.fv.declared_sha256 ?? null,
      cacheKey: `${uid}:${plan.lib.authority_epoch}:${plan.fv.beat_id}:${fileId}:${plan.fv.revision}`, epoch: plan.lib.authority_epoch, revisionLibrary: plan.lib.revision, parts: issued, ttlMs: grantTtlMs,
    };
  }

  // ---------- GET /media/:token (Range) ----------
  async function resolveGrant({ userId, token } = {}) {
    const uid = requireUserId(userId);
    const hash = tokenHash(token);
    let g;
    try {
      g = (await pool.query(`SELECT g.grant_hash, g.user_id, g.generation_id, g.file_id, g.part_index, g.beat_id, g.authority_epoch::text AS epoch, g.file_revision::text AS file_revision, g.object_id, g.status, g.expires_at <= now() AS expired,
          o.chat_id, o.message_id::text AS message_id, o.status AS object_status, p.size_bytes::text AS size_bytes, fv.mime, fv.filename, l.authority_epoch::text AS lib_epoch
        FROM catalog_media_grants g JOIN catalog_media_objects o ON o.user_id = g.user_id AND o.object_id = g.object_id
        JOIN catalog_file_parts p ON p.user_id = g.user_id AND p.generation_id = g.generation_id AND p.file_id = g.file_id AND p.part_index = g.part_index
        JOIN catalog_file_versions fv ON fv.user_id = g.user_id AND fv.generation_id = g.generation_id AND fv.file_id = g.file_id
        JOIN catalog_libraries l ON l.user_id = g.user_id
        WHERE g.grant_hash = $1`, [hash])).rows[0];
    } catch (error) { throw sqlError(error); }
    if (!g || g.user_id !== uid) throw new CatalogQueryError('MEDIA_GRANT_INVALID', 403, 'media grant is unknown or belongs to another account', { reason: 'UNKNOWN' });
    if (g.status !== 'ACTIVE') throw new CatalogQueryError('MEDIA_GRANT_INVALID', 403, `media grant is ${g.status}`, { reason: g.status });
    if (g.expired) { await pool.query("UPDATE catalog_media_grants SET status = 'EXPIRED' WHERE grant_hash = $1 AND status = 'ACTIVE'", [hash]).catch(() => {}); throw new CatalogQueryError('MEDIA_GRANT_EXPIRED', 403, 'media grant expired; request access again', { reason: 'EXPIRED' }); }
    if (g.epoch !== g.lib_epoch) throw new CatalogQueryError('MEDIA_GRANT_INVALID', 403, 'media grant belongs to a previous epoch', { reason: 'EPOCH' });
    if (g.object_status !== 'PRESENT') throw denied('OBJECT_NOT_PRESENT', { status: g.object_status });
    return { hash, chatId: g.chat_id, messageId: Number(g.message_id), size: Number(g.size_bytes), mime: g.mime || 'application/octet-stream', filename: g.filename, fileId: g.file_id, partIndex: g.part_index, revision: g.file_revision, beatId: g.beat_id };
  }
  /** Transmite la parte al `res` HTTP (Range). El gateway entrega un iterable de trozos; nada se bufferiza entero. */
  async function stream({ userId, token, rangeHeader = null, res, method = 'GET' } = {}) {
    if (!gateway || typeof gateway.downloadPart !== 'function') throw new CatalogQueryError('TRANSFER_UNAVAILABLE', 503, 'no media gateway is configured', { reason: 'NO_GATEWAY' });
    const g = await resolveGrant({ userId, token });
    const range = parseRange(rangeHeader, g.size);
    const length = range.end - range.start + 1;
    res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', g.mime); res.setHeader('Content-Length', String(length));
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('ETag', `"${g.fileId}-${g.partIndex}-${g.revision}"`); res.setHeader('X-Catalog-Part', String(g.partIndex));
    if (range.partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${g.size}`);
    if (method === 'HEAD') { res.status(range.partial ? 206 : 200).end(); return { bytes: 0, partial: range.partial }; }
    let iterator; let first;
    try {
      iterator = await gateway.downloadPart({ chatId: g.chatId, messageId: g.messageId, offset: range.start, limit: length, requestSize: CHUNK_BYTES });
      first = await iterator[Symbol.asyncIterator]().next(); // el primer trozo se obtiene antes de comprometer el estado HTTP
    } catch (error) {
      metrics.providerErrors++;
      const code = error && error.code;
      if (code === 'PROVIDER_MESSAGE_NOT_FOUND') throw new CatalogQueryError('MEDIA_UNAVAILABLE', 404, 'the provider has no document for this part (not proof of deletion)', { reason: 'PROVIDER_MESSAGE_NOT_FOUND' });
      if (code === 'CREDENTIAL_REVOKED') throw new CatalogQueryError('CREDENTIAL_REVOKED', 503, 'media gateway credential revoked', { reason: 'REVOKED' });
      throw new CatalogQueryError('MEDIA_UNAVAILABLE', 502, 'media gateway failed before the first byte', { reason: code || 'PROVIDER', retry_after_ms: Number(error?.retryAfterMs) || 5000 });
    }
    res.status(range.partial ? 206 : 200);
    let sent = 0;
    const push = async (chunk) => {
      if (!chunk || !chunk.length) return;
      const slice = sent + chunk.length > length ? chunk.subarray(0, length - sent) : chunk;
      sent += slice.length; metrics.bytes += slice.length;
      if (!res.write(slice)) await new Promise((r) => res.once('drain', r));
    };
    try {
      if (!first.done) await push(first.value);
      if (sent < length && !first.done) for await (const chunk of iterator) { await push(chunk); if (sent >= length) break; }
    } catch (error) { log('[catalog-media] stream interrupted', { fileId: g.fileId, part: g.partIndex, sent, code: error?.code }); res.destroy(error); return { bytes: sent, partial: range.partial, interrupted: true }; }
    res.end(); metrics.streams++;
    pool.query('UPDATE catalog_media_grants SET uses = uses + 1, last_used_at = now() WHERE grant_hash = $1', [g.hash]).catch(() => {});
    return { bytes: sent, partial: range.partial, start: range.start, end: range.end };
  }
  /** Logout / cambio de cuenta (T16): las concesiones vivas dejan de servir. */
  async function revokeGrants({ userId } = {}) {
    const uid = requireUserId(userId);
    try { const r = await pool.query("UPDATE catalog_media_grants SET status = 'REVOKED' WHERE user_id = $1 AND status = 'ACTIVE' RETURNING grant_hash", [uid]); return { revoked: r.rows.length }; } catch (error) { throw sqlError(error); }
  }

  return Object.freeze({ issueAccess, resolveGrant, stream, revokeGrants, metrics, limits: Object.freeze({ GRANT_TTL_MS: grantTtlMs, CHUNK_BYTES }) });
}

module.exports = { GRANT_TTL_MS, CHUNK_BYTES, TOKEN_RE, newToken, tokenHash, parseRange, createCatalogMedia };
