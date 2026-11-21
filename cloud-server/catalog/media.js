'use strict';
// T14/E77 — Acceso a medios por referencia SQL (NATIVO r2.1 §8.6; CONTRATO C7.9, §C9 acceso denegado). SOLO metadatos y autorización:
//  - `issueAccess(fileId)`: autoriza por tenant + generación activa + beat ACTIVE (TRASH/PURGING/tombstone → 403 ACCESS_DENIED) + archivo
//    vigente en su slot con versión VERIFIED + ubicaciones KNOWN con objeto PRESENT. Devuelve, por parte, tamaño, hash y la referencia directa
//    (chat y mensaje) para que el NAVEGADOR lea los bytes de Telegram por Direct B, con la clave de caché `(epoch, beat, fileId, revision)`.
//  - `confirmBytes`: el navegador atestigua el hash de los bytes que recibió.
//  El Cloud no transmite bytes: no hay concesiones por token, URLs de medios ni gateway de lectura. Multipart: todas las partes en orden.
// Solo SQL.

const { requireUserId } = require('./contract');
const { CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');
const { STATEMENT_TIMEOUT_MS } = require('./queries');

const ACCESS_TTL_MS = 15 * 60_000; // validez orientativa de la respuesta en la caché del cliente (las referencias cambian con la versión)
const FILE_ID_RE = /^[A-Za-z0-9._:@+-]{1,256}$/;

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const notFound = (what) => new CatalogQueryError('NOT_FOUND', 404, `${what} is not accessible`, {});
const sqlError = (error) => {
  if (error instanceof CatalogAuthorityError || error instanceof CatalogQueryError) return error;
  if (error?.code === '57014') return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog statement timed out', { sqlstate: '57014' });
  return new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog is unavailable (SQL_ERROR)', { reason: 'SQL_ERROR', sqlstate: error?.code || null, sql_message: error?.code ? String(error.message).slice(0, 200) : null });
};
const LIB_SQL = `SELECT l.authority, l.authority_era::text AS authority_era, l.authority_epoch::text AS authority_epoch, l.revision::text AS revision, l.active_generation_id FROM catalog_libraries l WHERE l.user_id = $1`;

function createCatalogMedia({ pool = null, authority = null, accessTtlMs = ACCESS_TTL_MS } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createCatalogMedia requires a pool');
  if (!authority || typeof authority.availability !== 'function') throw new Error('createCatalogMedia requires the catalog authority');
  const metrics = { accesses: 0, denied: 0 };

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
      const parts = (await client.query(`SELECT p.part_index, p.size_bytes::text AS size_bytes, coalesce(p.verified_sha256, p.declared_sha256) AS sha256, p.verified_sha256 IS NOT NULL AS hash_verified, l.object_id, l.verification_level, o.status AS object_status, o.chat_id AS object_chat_id, o.message_id::text AS object_message_id, o.chat_id, o.message_id::text AS message_id
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
    const uid = requireUserId(userId);
    const issued = plan.parts.map((p) => ({ partIndex: p.part_index, size: Number(p.size_bytes), sha256: p.sha256, hashVerified: p.hash_verified, verificationLevel: p.verification_level, bytesVerified: p.verification_level === 'BYTES', direct: { chatId: String(p.object_chat_id), messageId: Number(p.object_message_id) } }));
    metrics.accesses++;
    const total = plan.parts.reduce((n, p) => n + Number(p.size_bytes), 0);
    return {
      fileId, beatId: plan.fv.beat_id, role: plan.fv.role, slotKey: plan.fv.slot_key, revision: plan.fv.revision, filename: plan.fv.filename, mime: plan.fv.mime,
      sizeBytes: plan.fv.size_bytes ? Number(plan.fv.size_bytes) : total, partsTotalBytes: total, sha256: plan.fv.verified_sha256 ?? null, declaredSha256: plan.fv.declared_sha256 ?? null,
      cacheKey: `${uid}:${plan.lib.authority_epoch}:${plan.fv.beat_id}:${fileId}:${plan.fv.revision}`, epoch: plan.lib.authority_epoch, revisionLibrary: plan.lib.revision, parts: issued, ttlMs: accessTtlMs,
    };
  }

  // ---------- POST /files/:fileId/parts/:partIndex/bytes (Direct B, D4) ----------
  // El navegador descargó la parte de Telegram y calculó su SHA-256 con los bytes REALES recibidos. Si coincide con el hash declarado desde el
  // archivo original, la ubicación sube a nivel BYTES (atestiguado por el lector; el servidor no leyó los bytes). Una discrepancia no cambia
  // ningún estado: se devuelve 409 BYTES_MISMATCH para que el cliente avise y no reproduzca/exporte como íntegro.
  async function confirmBytes({ userId, fileId, partIndex, sha256, size } = {}) {
    if (typeof fileId !== 'string' || !FILE_ID_RE.test(fileId)) throw inputInvalid('FILE_ID');
    if (!Number.isSafeInteger(partIndex) || partIndex < 0) throw inputInvalid('PART_INDEX');
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw inputInvalid('SHA256');
    if (!Number.isSafeInteger(size) || size <= 0) throw inputInvalid('SIZE');
    const uid = requireUserId(userId);
    const row = await readTx(uid, async (client) => {
      const lib = await libraryOf(client, uid);
      const found = (await client.query(`SELECT p.size_bytes::text AS size_bytes, coalesce(p.verified_sha256, p.declared_sha256) AS expected, l.verification_level, fv.status, b.state AS beat_state
        FROM catalog_file_parts p JOIN catalog_file_versions fv ON fv.user_id = p.user_id AND fv.generation_id = p.generation_id AND fv.file_id = p.file_id
        JOIN catalog_beats b ON b.user_id = fv.user_id AND b.generation_id = fv.generation_id AND b.beat_id = fv.beat_id
        JOIN catalog_part_locations l ON l.user_id = p.user_id AND l.generation_id = p.generation_id AND l.file_id = p.file_id AND l.part_index = p.part_index AND l.location = 'PRIMARY' AND l.reference_class = 'KNOWN'
        WHERE p.user_id = $1 AND p.generation_id = $2 AND p.file_id = $3 AND p.part_index = $4`, [uid, lib.active_generation_id, fileId, partIndex])).rows[0] || null;
      return found ? { ...found, gen: lib.active_generation_id } : null;
    });
    if (!row) throw notFound('file part');
    if (row.status !== 'VERIFIED') throw denied('FILE_NOT_VERIFIED', { status: row.status });
    if (String(size) !== row.size_bytes || (row.expected && row.expected !== sha256)) { metrics.bytesMismatch = (metrics.bytesMismatch || 0) + 1; throw new CatalogQueryError('BYTES_MISMATCH', 409, 'the downloaded bytes do not match the declared size or hash', { partIndex, expected_size: row.size_bytes, hash_known: Boolean(row.expected) }); }
    if (!row.expected) return { partIndex, level: row.verification_level || 'PROVIDER', bytesVerified: false, reason: 'NO_DECLARED_HASH' }; // sin hash declarado no hay contra qué atestiguar
    if (row.verification_level === 'BYTES') return { partIndex, level: 'BYTES', bytesVerified: true, replay: true };
    try {
      await pool.query(`UPDATE catalog_part_locations SET verification_level = 'BYTES', checksum_sha256 = $5, verified_at = now()
        WHERE user_id = $1 AND file_id = $2 AND part_index = $3 AND location = 'PRIMARY' AND generation_id = $4 AND verification_level IS DISTINCT FROM 'BYTES'`, [uid, fileId, partIndex, row.gen, sha256]);
    } catch (error) { throw sqlError(error); }
    metrics.bytesConfirmed = (metrics.bytesConfirmed || 0) + 1;
    return { partIndex, level: 'BYTES', bytesVerified: true };
  }
  return Object.freeze({ issueAccess, confirmBytes, metrics, limits: Object.freeze({ ACCESS_TTL_MS: accessTtlMs }) });
}

let configured = null;
function configureCatalogMedia(options = null) { configured = options && options.pool && options.authority ? createCatalogMedia(options) : null; return configured; }
function currentCatalogMedia() { return configured; }

module.exports = { ACCESS_TTL_MS, createCatalogMedia, configureCatalogMedia, currentCatalogMedia };
