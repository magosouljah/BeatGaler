'use strict';
// E75 — MAIN de prefijos de audio: coordinación SOLO de metadatos. El Cloud nunca lee ni envía bytes de MP3 ni de paquetes.
//  - Un único MAIN vigente por biblioteca (catalog_prefix_packs PUBLISHED). Lo construye y lo sube el NAVEGADOR por Direct B; aquí solo se
//    persiste la identidad del envío antes del efecto (STAGED), se comprueba el mensaje en el proveedor (RPC de metadatos: tamaño, remitente y
//    marcador `catalog:v1 pack=…`) y se publica con compare-and-swap sobre la versión que vio el constructor.
//  - PostgreSQL es la autoridad: una entrada solo se sirve si su (file_id, sha256) sigue siendo el MASTER MP3 vigente de un beat ACTIVE. Los
//    archivos vigentes que el MAIN no cubre (beats nuevos, MP3 reemplazados) son los «pendientes»: ese recuento derivado ES el contador de cambios
//    (vuelve a cero al publicar un MAIN que los cubre; una subida fallida nunca cuenta; una reconstrucción fallida no pierde nada).
//  - Concurrencia: una sola construcción en curso por biblioteca (índice único sobre STAGED, caduca sola) y publicación condicionada a que el MAIN
//    vigente siga siendo el que el constructor tomó como base: una publicación antigua nunca pisa a otra más reciente.
//  - MAIN es una optimización para dispositivos con la caché vacía, nunca una dependencia de reproducción. En Telegram no se borra nada: un MAIN
//    sustituido o una publicación perdedora quedan como mensajes sin referencia.
const crypto = require('crypto');
const { requireUserId } = require('./contract');
const { CatalogQueryError } = require('./cursor');
const { createLibraryTx } = require('./library-tx');
const { packCaptionFor } = require('./transport-gateway');

const PREFIX_BYTES = 128 * 1024;
const MAIN_REBUILD_THRESHOLD = 5; // decisión del propietario (E75): reconstruir con 5 o más cambios confirmados
const MAIN_BUILD_TTL_MS = 10 * 60_000; // una construcción STAGED más antigua se da por abandonada
const MAX_ENTRIES = 20_000;
const PACK_ID_RE = /^pk-[A-Za-z0-9_-]{8,60}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const FILE_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const MP3_SQL = "(lower(coalesce(fv.mime, '')) IN ('audio/mpeg', 'audio/mp3') OR lower(coalesce(fv.filename, '')) LIKE '%.mp3')";

const inputInvalid = (reason) => new CatalogQueryError('INPUT_INVALID', 400, 'invalid MAIN pack request', { reason });

// Prefijos vigentes: MASTER MP3 VERIFIED de beats ACTIVE con hash declarado y ubicación PRIMARY conocida de la parte 0.
const CANDIDATES_SQL = `SELECT cf.file_id, coalesce(fv.verified_sha256, fv.declared_sha256) AS file_sha256, fv.size_bytes::text AS file_size,
    o.chat_id AS chat_id, o.message_id::text AS message_id, p.size_bytes::text AS part0_size
  FROM catalog_current_files cf
  JOIN catalog_file_versions fv ON fv.user_id = cf.user_id AND fv.generation_id = cf.generation_id AND fv.file_id = cf.file_id
  JOIN catalog_beats b ON b.user_id = cf.user_id AND b.generation_id = cf.generation_id AND b.beat_id = cf.beat_id
  JOIN catalog_file_parts p ON p.user_id = fv.user_id AND p.generation_id = fv.generation_id AND p.file_id = fv.file_id AND p.part_index = 0
  JOIN catalog_part_locations l ON l.user_id = p.user_id AND l.generation_id = p.generation_id AND l.file_id = p.file_id AND l.part_index = 0 AND l.location = 'PRIMARY' AND l.reference_class = 'KNOWN'
  JOIN catalog_media_objects o ON o.user_id = l.user_id AND o.object_id = l.object_id AND o.status = 'PRESENT'
  WHERE cf.user_id = $1 AND cf.generation_id = $2 AND cf.slot_key = 'MASTER' AND b.state = 'ACTIVE' AND fv.status = 'VERIFIED'
    AND coalesce(fv.verified_sha256, fv.declared_sha256) IS NOT NULL AND ${MP3_SQL}
  ORDER BY cf.file_id`;
const MAIN_SQL = `SELECT pack_id, seq::text AS seq, chat_id, message_id::text AS message_id, size_bytes::text AS size_bytes, sha256
  FROM catalog_prefix_packs WHERE user_id = $1 AND generation_id = $2 AND status = 'PUBLISHED'`;
const ENTRIES_SQL = `SELECT file_id, file_sha256, file_size::text AS file_size, prefix_sha256, byte_offset::text AS byte_offset, byte_length
  FROM catalog_prefix_pack_entries WHERE user_id = $1 AND pack_id = $2`;
const prefixLength = (c, prefixBytes) => Math.min(prefixBytes, Number(c.part0_size), Number(c.file_size));

function createPrefixPacks({ pool = null, authority = null, gateway = null, prefixBytes = PREFIX_BYTES, threshold = MAIN_REBUILD_THRESHOLD, buildTtlMs = MAIN_BUILD_TTL_MS, directReads = false, randomBytes = crypto.randomBytes, log = () => {} } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createPrefixPacks requires a pool');
  if (!authority || typeof authority.requireLibraryForMutation !== 'function') throw new Error('createPrefixPacks requires the catalog authority');
  const metrics = { tickets: 0, published: 0, conflicts: 0, busy: 0, cancelled: 0, verifyFailed: 0 };
  const canVerify = () => Boolean(gateway && typeof gateway.verifyMessage === 'function');

  const libraryTx = createLibraryTx({ pool, authority, variant: 'prefixPacks' });
  const { translateError: sqlError } = libraryTx;

  async function lockVaultChat(client, uid) {
    const lib = (await client.query(`SELECT l.active_generation_id, v.transport_bot_id AS bot_id,
          (SELECT c.chat_id FROM catalog_library_chats c WHERE c.user_id = l.user_id AND c.state = 'CURRENT') AS chat_id
        FROM catalog_libraries l JOIN vaults v ON v.user_id = l.user_id WHERE l.user_id = $1 FOR UPDATE OF l`, [uid])).rows[0];
    if (!lib || !lib.active_generation_id) throw new CatalogQueryError('LIBRARY_NOT_PROVISIONED', 404, 'library is not native', {});
    return lib;
  }
  async function libraryOf(client, uid) {
    const lib = (await client.query('SELECT authority, active_generation_id FROM catalog_libraries WHERE user_id = $1', [uid])).rows[0];
    if (!lib || lib.authority !== 'POSTGRES' || !lib.active_generation_id) throw new CatalogQueryError('LIBRARY_NOT_PROVISIONED', 404, 'library is not native', {});
    return lib;
  }
  const currentMain = async (client, uid, generationId) => (await client.query(MAIN_SQL, [uid, generationId])).rows[0] || null;

  // ---------- GET /catalog/v1/prefix-packs/manifest ----------
  // `entries`: prefijos vigentes que el MAIN cubre (dónde leerlos). `pending`: archivos vigentes que el MAIN no cubre (el contador de cambios).
  async function manifest({ userId } = {}) {
    return libraryTx.read(userId, async ({ client, uid }) => {
      const lib = await libraryOf(client, uid);
      const cands = (await client.query(CANDIDATES_SQL, [uid, lib.active_generation_id])).rows;
      const main = await currentMain(client, uid, lib.active_generation_id);
      const covered = new Map(main ? (await client.query(ENTRIES_SQL, [uid, main.pack_id])).rows.map((r) => [r.file_id, r]) : []);
      const building = (await client.query(`SELECT 1 FROM catalog_prefix_packs WHERE user_id = $1 AND status = 'STAGED' AND created_at > now() - ($2::bigint * interval '1 millisecond')`, [uid, buildTtlMs])).rows.length > 0;
      const entries = []; const pending = [];
      for (const c of cands) {
        const e = covered.get(c.file_id);
        if (e && e.file_sha256 === c.file_sha256) entries.push({ fileId: c.file_id, fileSha256: c.file_sha256, fileSize: Number(c.file_size), prefixSha256: e.prefix_sha256, offset: Number(e.byte_offset), length: e.byte_length });
        else pending.push({ fileId: c.file_id, fileSha256: c.file_sha256, fileSize: Number(c.file_size), prefixLength: prefixLength(c, prefixBytes), ...(directReads ? { direct: { chatId: String(c.chat_id), messageId: Number(c.message_id), partSize: Number(c.part0_size) } } : {}) });
      }
      return {
        generationId: lib.active_generation_id, prefixBytes, threshold,
        main: main ? { packId: main.pack_id, version: main.seq, sizeBytes: Number(main.size_bytes), sha256: main.sha256, ...(directReads ? { direct: { chatId: String(main.chat_id), messageId: Number(main.message_id) } } : {}) } : null,
        entries, pending, current: cands.length, pendingCount: pending.length, rebuild: pending.length >= threshold, building,
      };
    });
  }

  function checkEntries(entries, sizeBytes) {
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ENTRIES) throw inputInvalid('ENTRIES');
    const seen = new Set(); let end = 0; let data = 0;
    const sorted = [...entries].sort((a, b) => Number(a && a.offset) - Number(b && b.offset));
    for (const e of sorted) {
      if (!e || typeof e !== 'object' || typeof e.fileId !== 'string' || !FILE_ID_RE.test(e.fileId) || seen.has(e.fileId)) throw inputInvalid('ENTRY_FILE');
      if (!SHA_RE.test(String(e.fileSha256)) || !SHA_RE.test(String(e.prefixSha256))) throw inputInvalid('ENTRY_HASH');
      if (!Number.isSafeInteger(e.fileSize) || e.fileSize <= 0 || !Number.isSafeInteger(e.length) || e.length <= 0 || e.length > prefixBytes) throw inputInvalid('ENTRY_SIZE');
      if (!Number.isSafeInteger(e.offset) || e.offset < end || e.offset + e.length > sizeBytes) throw inputInvalid('ENTRY_RANGE'); // sin solapes y dentro del documento
      seen.add(e.fileId); end = e.offset + e.length; data += e.length;
    }
    return { sorted, data };
  }

  // ---------- POST /catalog/v1/prefix-packs/main ----------
  // Ticket: identidad del envío persistida ANTES del efecto. Rechaza una base obsoleta (otro dispositivo ya publicó) y una construcción en curso.
  async function beginMain({ userId, era, epoch, packId, baseVersion, sizeBytes, sha256, entries } = {}) {
    if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) throw inputInvalid('PACK_ID');
    if (!/^[0-9]{1,18}$/.test(String(baseVersion))) throw inputInvalid('BASE_VERSION');
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || !SHA_RE.test(String(sha256))) throw inputInvalid('DOCUMENT');
    const { sorted, data } = checkEntries(entries, sizeBytes);
    if (!canVerify()) throw new CatalogQueryError('TRANSFER_UNAVAILABLE', 503, 'the provider verifier is not configured', { reason: 'NO_VERIFIER' });
    const caption = packCaptionFor(packId);
    const out = await libraryTx.mutate(userId, { era, epoch }, async ({ client, uid }) => {
      const lib = await lockVaultChat(client, uid);
      if (!lib.chat_id || !lib.bot_id) throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'library has no CURRENT chat or transport bot', {});
      const main = await currentMain(client, uid, lib.active_generation_id);
      const current = main ? main.seq : '0';
      if (String(baseVersion) !== current) { metrics.conflicts++; throw new CatalogQueryError('MAIN_VERSION_CONFLICT', 409, 'another device already published a newer MAIN', { currentVersion: current }); }
      await client.query(`UPDATE catalog_prefix_packs SET status = 'FAILED', last_error = 'BUILD_EXPIRED' WHERE user_id = $1 AND status = 'STAGED' AND created_at <= now() - ($2::bigint * interval '1 millisecond')`, [uid, buildTtlMs]);
      const busy = (await client.query(`SELECT pack_id, (extract(epoch FROM (created_at + ($2::bigint * interval '1 millisecond') - now())) * 1000)::bigint::text AS left_ms FROM catalog_prefix_packs WHERE user_id = $1 AND status = 'STAGED'`, [uid, buildTtlMs])).rows[0];
      if (busy) { metrics.busy++; throw new CatalogQueryError('MAIN_BUILD_IN_PROGRESS', 409, 'another MAIN build is in progress', { retryAfterMs: Math.max(1000, Number(busy.left_ms)) }); }
      // Cada entrada debe ser el MASTER MP3 vigente con su longitud de prefijo exacta: nunca se registra una versión retirada o un beat eliminado.
      const cands = new Map((await client.query(CANDIDATES_SQL, [uid, lib.active_generation_id])).rows.map((c) => [c.file_id, c]));
      const stale = sorted.filter((e) => { const c = cands.get(e.fileId); return !c || c.file_sha256 !== e.fileSha256 || Number(c.file_size) !== e.fileSize || prefixLength(c, prefixBytes) !== e.length; });
      if (stale.length) throw new CatalogQueryError('MAIN_ENTRIES_STALE', 409, 'the MAIN document references files that are no longer current', { stale: stale.length });
      const randomId = randomBytes(8).readBigInt64BE(0).toString();
      await client.query(`INSERT INTO catalog_prefix_packs(user_id, pack_id, generation_id, status, base_seq, random_id, bot_id, chat_id, size_bytes, sha256, entry_count, data_bytes)
        VALUES ($1,$2,$3,'STAGED',$4::bigint,$5,$6,$7,$8::bigint,$9,$10,$11::bigint)`, [uid, packId, lib.active_generation_id, current, randomId, String(lib.bot_id), String(lib.chat_id), sizeBytes, sha256, sorted.length, data])
        .catch((error) => { if (error && error.code === '23505') throw new CatalogQueryError('PACK_STATE_CONFLICT', 409, 'pack id already used', {}); throw error; });
      await client.query(`INSERT INTO catalog_prefix_pack_entries(user_id, pack_id, file_id, file_sha256, file_size, prefix_sha256, byte_offset, byte_length)
        SELECT $1, $2, x.file_id, x.file_sha256, x.file_size, x.prefix_sha256, x.byte_offset, x.byte_length
        FROM jsonb_to_recordset($3::jsonb) AS x(file_id text, file_sha256 text, file_size bigint, prefix_sha256 text, byte_offset bigint, byte_length integer)`,
      [uid, packId, JSON.stringify(sorted.map((e) => ({ file_id: e.fileId, file_sha256: e.fileSha256, file_size: e.fileSize, prefix_sha256: e.prefixSha256, byte_offset: e.offset, byte_length: e.length })))]);
      return { packId, attempt: 1, randomId, caption, chatId: String(lib.chat_id), botId: String(lib.bot_id), filename: `${packId}.bgpack`, mime: 'application/octet-stream', size: sizeBytes, baseVersion: current, expiresInMs: buildTtlMs };
    });
    metrics.tickets++;
    return out;
  }

  const loadPack = async (uid, packId) => (await pool.query(`SELECT pack_id, status, base_seq::text AS base_seq, seq::text AS seq, chat_id, generation_id, size_bytes::text AS size_bytes, message_id::text AS message_id
    FROM catalog_prefix_packs WHERE user_id = $1 AND pack_id = $2`, [uid, packId]).catch((e) => { throw sqlError(e); })).rows[0] || null;

  // ---------- POST /catalog/v1/prefix-packs/main/:packId/publish ----------
  // Comprobación en el proveedor (solo metadatos, fuera de SQL) y publicación atómica con compare-and-swap sobre la base del constructor.
  async function publishMain({ userId, era, epoch, packId, receipt } = {}) {
    const uid = requireUserId(userId);
    if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) throw inputInvalid('PACK_ID');
    const messageId = Number(receipt && receipt.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw inputInvalid('RECEIPT');
    const pack = await loadPack(uid, packId);
    if (!pack) throw new CatalogQueryError('NOT_FOUND', 404, 'unknown pack', {});
    if (pack.status === 'PUBLISHED' && Number(pack.message_id) === messageId) return { packId, version: pack.seq, replay: true };
    if (pack.status !== 'STAGED') throw new CatalogQueryError('PACK_STATE_CONFLICT', 409, `pack is ${pack.status}`, { status: pack.status });
    if (!canVerify()) throw new CatalogQueryError('TRANSFER_UNAVAILABLE', 503, 'the provider verifier is not configured', { reason: 'NO_VERIFIER' });
    const fail = (code) => pool.query("UPDATE catalog_prefix_packs SET status = 'FAILED', last_error = $3 WHERE user_id = $1 AND pack_id = $2 AND status = 'STAGED'", [uid, packId, String(code).slice(0, 1000)]).catch(() => {});
    let evidence;
    try { evidence = await gateway.verifyMessage({ chatId: String(pack.chat_id), messageId, packId }); } catch (error) {
      if (error && error.transient === false) { metrics.verifyFailed++; await fail(error.code || 'PACK_VERIFY_FAILED'); throw new CatalogQueryError('PACK_VERIFY_FAILED', 409, 'the published message is not this MAIN document', { code: error.code || null }); }
      throw new CatalogQueryError('TRANSFER_UNAVAILABLE', 503, 'the provider could not be reached to verify the MAIN document', { code: (error && error.code) || null, retry: true });
    }
    if (!evidence || evidence.size !== Number(pack.size_bytes)) { metrics.verifyFailed++; await fail('PACK_SIZE_MISMATCH'); throw new CatalogQueryError('PACK_VERIFY_FAILED', 409, 'the published message has a different size', { code: 'PACK_SIZE_MISMATCH' }); }
    const out = await libraryTx.mutate(uid, { era, epoch }, async ({ client }) => {
      const lib = await lockVaultChat(client, uid);
      const st = (await client.query('SELECT status, base_seq::text AS base_seq, generation_id FROM catalog_prefix_packs WHERE user_id = $1 AND pack_id = $2 FOR UPDATE', [uid, packId])).rows[0];
      if (!st || st.status !== 'STAGED') throw new CatalogQueryError('PACK_STATE_CONFLICT', 409, `pack is ${st ? st.status : 'missing'}`, {});
      const main = await currentMain(client, uid, lib.active_generation_id);
      const current = main ? main.seq : '0';
      if (st.generation_id !== lib.active_generation_id || st.base_seq !== current) {
        // Perdió la carrera: el MAIN vigente no cambia y este documento queda sin referencia (los pendientes siguen contados contra el MAIN vigente).
        await client.query("UPDATE catalog_prefix_packs SET status = 'FAILED', last_error = 'MAIN_VERSION_CONFLICT', message_id = $3::bigint WHERE user_id = $1 AND pack_id = $2", [uid, packId, messageId]);
        metrics.conflicts++;
        throw Object.assign(new CatalogQueryError('MAIN_VERSION_CONFLICT', 409, 'another device published a newer MAIN first', { currentVersion: current }), { commit: true });
      }
      // Un único MAIN vigente por biblioteca: el anterior (también el de una generación previa) pasa a SUPERSEDED en la misma transacción.
      await client.query("UPDATE catalog_prefix_packs SET status = 'SUPERSEDED', superseded_at = now() WHERE user_id = $1 AND status = 'PUBLISHED'", [uid]);
      const seq = (await client.query('SELECT (coalesce(max(seq), 0) + 1)::text AS n FROM catalog_prefix_packs WHERE user_id = $1', [uid])).rows[0].n;
      await client.query("UPDATE catalog_prefix_packs SET status = 'PUBLISHED', seq = $3::bigint, message_id = $4::bigint, document_id = $5, published_at = now() WHERE user_id = $1 AND pack_id = $2", [uid, packId, seq, messageId, evidence.documentId ?? null]);
      return { packId, version: seq, superseded: main ? main.pack_id : null, replay: false };
    });
    metrics.published++; log(`[prefix-packs] MAIN published version=${out.version}`);
    return out;
  }

  // ---------- POST /catalog/v1/prefix-packs/main/:packId/cancel ----------
  // El constructor informa de que NO hubo efecto (fallo antes de enviar o rechazo explícito): libera la construcción en curso. Idempotente.
  async function cancelMain({ userId, era, epoch, packId, code = null } = {}) {
    if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) throw inputInvalid('PACK_ID');
    const r = await libraryTx.mutate(userId, { era, epoch }, async ({ client, uid }) => {
      await lockVaultChat(client, uid);
      return (await client.query("UPDATE catalog_prefix_packs SET status = 'FAILED', last_error = $3 WHERE user_id = $1 AND pack_id = $2 AND status = 'STAGED' RETURNING pack_id",
        [uid, packId, `CANCELLED:${String(code || 'CLIENT').replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 80)}`])).rows.length;
    });
    if (r) metrics.cancelled++;
    return { cancelled: r === 1 };
  }

  return Object.freeze({ manifest, beginMain, publishMain, cancelMain, metrics, limits: Object.freeze({ PREFIX_BYTES: prefixBytes, MAIN_REBUILD_THRESHOLD: threshold, MAIN_BUILD_TTL_MS: buildTtlMs, MAX_ENTRIES }) });
}

let configured = null;
function configurePrefixPacks(options = null) { configured = options && options.pool && options.authority ? createPrefixPacks(options) : null; return configured; }
function currentPrefixPacks() { return configured; }

module.exports = { PREFIX_BYTES, MAIN_REBUILD_THRESHOLD, MAIN_BUILD_TTL_MS, createPrefixPacks, configurePrefixPacks, currentPrefixPacks };
