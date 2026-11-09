'use strict';
// T12 — Transferencias y PROJECT sobre operaciones C7 (CONTRATO C7.3–C7.9; NATIVO r2.1 §8.6; TAREAS §T12; MATRIZ-T §T12).
//  - El cliente nunca recibe chat, message_id, bot_token ni random_id: obtiene una CAPACIDAD de subida opaca, de vida corta y un
//    solo uso, ligada a usuario + operationId/partKey + dirección; en SQL se guarda solo su hash (catalog_transfer_capabilities).
//  - Secuencia por parte: redimir capacidad (SQL breve) → recibir bytes en un temporal acotado calculando tamaño y SHA-256 SIN
//    cliente SQL → comparar con lo declarado (archivo reseleccionado distinto → 409, sin efecto) → markDispatched (SQL breve, misma
//    identidad random_id en reintentos) → envío por el gateway (remoto, sin SQL) → recibo candidato (SQL breve) → el worker T10
//    verifica con el proveedor. Ningún lock durante hash, envío o verificación.
//  - Resultado del envío fail-closed: REJECTED/UPLOAD_FAILED (sin efecto) → 503 + Retry-After y nueva capacidad con la misma identidad;
//    PERMANENT → 403; REVOKED → 503 cerco; UNCERTAIN o error desconocido → journal UNCERTAIN + job TRANSFER_RECONCILE y 202; una parte
//    incierta no admite otra capacidad hasta reconciliar (RESEND_POLICY.uncertain = BLOCKED). Recibo enviado pero no persistido → incierto.
//  - PROJECT: va por MASTER (ruta de temporal + Access + admisión preservadas), nunca por el bot Direct; intención durable (journal +
//    markDispatched) ANTES de publicar, recibo después; el remitente MASTER se fija antes del primer despacho (D-T09-4). El caption es el
//    marcador catalog:v1 para que la reconciliación del gateway funcione igual.
//  - Evidencia de hash con nivel veraz: el hash de los bytes que el gateway entregó al proveedor se guarda como nivel GATEWAY (journal y
//    recibo); el nivel BYTES (lectura remota) queda para T14/T19; PROVIDER es la verificación del worker. Nunca se etiqueta BYTES por
//    tamaño/caption.
// Solo SQL + crypto + fs (temporal acotado). El gateway (T11) y el transporte MASTER se inyectan; nunca se importan.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { requireUserId } = require('./contract');
const { canonicalJson, CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');
const { STATEMENT_TIMEOUT_MS } = require('./queries');
const { captionFor } = require('./transport-gateway');

const CAPABILITY_TTL_MS = 10 * 60_000;
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PART_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const INFLIGHT = Object.freeze(['PREPARED', 'TRANSFERRING', 'VERIFYING']);
const EVIDENCE_LEVELS = Object.freeze({ GATEWAY: 'GATEWAY', PROVIDER: 'PROVIDER', BYTES: 'BYTES' });
const DEFAULT_ADMISSION = Object.freeze({ maxConcurrent: 2, tempBudgetBytes: 2_000_000_000 });

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const notFound = (what) => new CatalogQueryError('NOT_FOUND', 404, `${what} is not accessible`, {});
const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sqlError = (error) => {
  if (error instanceof CatalogAuthorityError || error instanceof CatalogQueryError) return error;
  if (error?.code === '57014') return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog statement timed out', { sqlstate: '57014' });
  if (['BGL01', 'BGN04', 'BGA05', 'BGC02'].includes(error?.code)) return new CatalogQueryError('CATALOG_NATIVE_RULE', 409, 'database native rule rejected the mutation', { sqlstate: error.code, detail: error.detail || null });
  return new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog is unavailable (SQL_ERROR)', { reason: 'SQL_ERROR', sqlstate: error?.code || null, sql_message: error?.code ? String(error.message).slice(0, 200) : null });
};

// ---------- utilidades puras ----------
function newCapabilityToken(randomBytes = crypto.randomBytes) { return randomBytes(TOKEN_BYTES).toString('base64url'); }
function capabilityHash(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new CatalogQueryError('CAPABILITY_INVALID', 403, 'transfer capability is invalid', { reason: 'FORMAT' });
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// Transform que cuenta bytes y calcula SHA-256; corta en el primer byte que excede el tope (C7.9: no se guardan bytes en SQL).
function createMeasuringStream(maxBytes) {
  const hash = crypto.createHash('sha256');
  const t = new Transform({
    transform(chunk, _enc, cb) {
      t.bytes += chunk.length;
      if (t.bytes > maxBytes) return cb(Object.assign(new Error('transfer exceeds the declared size'), { code: 'TRANSFER_TOO_LARGE', bytes: t.bytes, maxBytes }));
      hash.update(chunk); cb(null, chunk);
    },
  });
  t.bytes = 0;
  t.digest = () => hash.digest('hex');
  return t;
}
async function spoolToFile(stream, { filePath, maxBytes }) {
  const m = createMeasuringStream(maxBytes);
  await pipeline(stream, m, fs.createWriteStream(filePath, { flags: 'wx' }));
  return { size: m.bytes, sha256: m.digest() };
}

// Admisión de temporales (misma semántica que project-upload-admission: concurrencia y presupuesto de bytes; 503 + Retry-After 5 s).
function createTempAdmission({ maxConcurrent = DEFAULT_ADMISSION.maxConcurrent, tempBudgetBytes = DEFAULT_ADMISSION.tempBudgetBytes } = {}) {
  let active = 0; let reservedBytes = 0;
  return Object.freeze({
    snapshot: () => ({ active, reservedBytes, maxConcurrent, tempBudgetBytes }),
    acquire({ maxBytes, contentLength } = {}) {
      const stated = Number(contentLength);
      const bytes = Number.isSafeInteger(stated) && stated > 0 ? stated : maxBytes;
      if (active >= maxConcurrent || bytes > tempBudgetBytes || reservedBytes + bytes > tempBudgetBytes) {
        throw new CatalogQueryError('TRANSFER_BUSY', 503, 'transfer capacity is busy; retry shortly', { retry_after_ms: 5000, reason: active >= maxConcurrent ? 'CONCURRENCY' : 'TEMP_BUDGET' });
      }
      active += 1; reservedBytes += bytes; let released = false;
      return Object.freeze({ bytes, release() { if (released) return; released = true; active -= 1; reservedBytes -= bytes; } });
    },
  });
}

// Clasificación del fallo de envío (gateway T11 o transporte MASTER) → journal + respuesta. Desconocido = incierto (fail-closed).
function classifySendFailure(error) {
  const c = error && error.classification;
  const code = error && error.code;
  if (code === 'CREDENTIAL_REVOKED' || (c && c.kind === 'REVOKED')) return { outcome: 'REVOKED', status: 'FAILED', http: 503, code: 'CREDENTIAL_REVOKED', retryAfterMs: 0, effect: false };
  if (code === 'UPLOAD_FAILED') return { outcome: c && c.kind === 'PERMANENT' ? 'PERMANENT' : 'UPLOAD_FAILED', status: 'FAILED', http: c && c.kind === 'PERMANENT' ? 403 : 503, code: c && c.kind === 'PERMANENT' ? 'SEND_REJECTED_PERMANENT' : 'UPLOAD_FAILED', retryAfterMs: Number(c?.retryAfterMs || error?.retryAfterMs || 5000) || 5000, effect: false };
  if (c && c.kind === 'REJECTED') return { outcome: 'REJECTED', status: 'FAILED', http: 503, code: 'SEND_REJECTED', retryAfterMs: Number(c.retryAfterMs || error.retryAfterMs || 5000) || 5000, effect: false };
  if (c && c.kind === 'PERMANENT') return { outcome: 'PERMANENT', status: 'FAILED', http: 403, code: 'SEND_REJECTED_PERMANENT', retryAfterMs: 0, effect: false };
  if ((c && c.effectPossible === false) || (error && error.effectPossible === false)) return { outcome: 'UPLOAD_FAILED', status: 'FAILED', http: 503, code: 'UPLOAD_FAILED', retryAfterMs: Number(c?.retryAfterMs || error?.retryAfterMs || 5000) || 5000, effect: false };
  return { outcome: 'UNCERTAIN', status: 'CONSUMED', http: 202, code: 'SEND_UNCERTAIN', retryAfterMs: Number(c?.retryAfterMs || error?.retryAfterMs || 60_000) || 60_000, effect: true };
}

function createCatalogTransport({ pool = null, authority = null, operations = null, gateway = null, master = null, resolveProjectAccess = null, tempDir = null, admission = null, projectAdmission = null, capabilityTtlMs = CAPABILITY_TTL_MS, now = () => new Date(), randomBytes = crypto.randomBytes, randomUUID = () => crypto.randomUUID(), log = () => {} } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createCatalogTransport requires a pool');
  if (!authority || typeof authority.requireLibraryForMutation !== 'function') throw new Error('createCatalogTransport requires the catalog authority');
  if (!operations || typeof operations.markDispatched !== 'function' || typeof operations.putReceipt !== 'function') throw new Error('createCatalogTransport requires catalog operations');
  if (typeof tempDir !== 'string' || !tempDir) throw new Error('createCatalogTransport requires a tempDir for bounded spooling');
  const directAdmission = admission || createTempAdmission();
  const masterAdmission = projectAdmission || createTempAdmission({ maxConcurrent: 1 });
  const metrics = { capabilitiesIssued: 0, uploads: 0, sent: 0, uncertain: 0, rejected: 0, permanent: 0, revoked: 0, mismatches: 0, aborted: 0, projectUploads: 0 };

  async function mutationTx(userId, { era, epoch }, fn) {
    const uid = requireUserId(userId);
    await authority.availability();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        const q = await client.query('SELECT 1 FROM control_plane_flush_quarantine WHERE user_id = $1 AND resolved_at IS NULL LIMIT 1', [uid]);
        if (q.rows.length) throw new CatalogAuthorityError('VAULT_QUARANTINED', 409, 'vault is quarantined by the control-plane flush', {});
        const ctx = await authority.requireLibraryForMutation(client, { userId: uid, era, epoch });
        if (ctx.migration_state !== 'IDLE') throw new CatalogQueryError('LIBRARY_FROZEN', 409, 'library is not accepting mutations', { migration_state: ctx.migration_state });
        const out = await fn(client, ctx, uid);
        await client.query('COMMIT');
        return out;
      } catch (error) { if (error && error.commit === true) await client.query('COMMIT').catch(() => {}); else await client.query('ROLLBACK').catch(() => {}); throw error; }
    } catch (error) { throw sqlError(error); } finally { client.release(); }
  }
  // Escritura breve fuera del cerco de era/época (journal): nunca retiene cliente entre pasos.
  async function journal(sql, params) { try { return await pool.query(sql, params); } catch (error) { throw sqlError(error); } }

  const PART_SQL = `SELECT o.status AS op_status, o.kind, o.beat_id, o.authority_epoch::text AS authority_epoch, p.part_key, p.slot_key, p.role, p.part_index, p.filename, p.mime, p.declared_size::text AS declared_size, p.declared_sha256,
      p.random_id, p.sender_id, p.chat_id, p.dispatch_state, p.attempts
    FROM catalog_operation_parts p JOIN catalog_transfer_operations o ON o.user_id = p.user_id AND o.operation_id = p.operation_id
    WHERE p.user_id = $1 AND p.operation_id = $2 AND p.part_key = $3`;
  async function loadPart(client, uid, operationId, partKey, { forUpdate = false } = {}) {
    const r = await client.query(`${PART_SQL}${forUpdate ? ' FOR UPDATE OF p' : ''}`, [uid, operationId, partKey]);
    if (!r.rows.length) throw notFound('part');
    return r.rows[0];
  }
  function assertUploadable(part) {
    if (!INFLIGHT.includes(part.op_status)) throw new CatalogQueryError('OPERATION_TRANSITION_INVALID', 409, `operation is ${part.op_status}`, { status: part.op_status });
    if (!['PENDING', 'DISPATCHED'].includes(part.dispatch_state)) throw new CatalogQueryError('PART_STATE_CONFLICT', 409, 'part already has a receipt or verification', { dispatch_state: part.dispatch_state });
  }
  // Una parte con un envío incierto (o una subida en vuelo tras el despacho) no admite otra capacidad: RESEND_POLICY.uncertain = BLOCKED.
  async function assertNotUncertain(client, uid, operationId, partKey, part) {
    const r = await client.query(`SELECT capability_hash, status, outcome FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2 AND part_key = $3
      AND ((status = 'CONSUMED' AND outcome = 'UNCERTAIN') OR (status = 'REDEEMED' AND $4 = 'DISPATCHED'))`, [uid, operationId, partKey, part.dispatch_state]);
    if (!r.rows.length) return;
    await client.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, 'TRANSFER_RECONCILE', $3, $4) ON CONFLICT (job_id) DO NOTHING`, [`job-reconcile-${operationId}-${partKey}`.slice(0, 64), uid, operationId, canonicalJson({ partKey })]);
    throw Object.assign(new CatalogQueryError('PART_UNCERTAIN', 409, 'a previous dispatch of this part is uncertain or still in flight; reconciliation is pending and no resend is allowed', { partKey, reconcile: true, attempts: r.rows.length }), { commit: true });
  }
  async function nextAttempt(client, uid, operationId, partKey) {
    return (await client.query('SELECT coalesce(max(attempt), 0)::int + 1 AS n FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2 AND part_key = $3', [uid, operationId, partKey])).rows[0].n;
  }
  async function resolveCapability(hash, status, outcome, { bytes = null, error = null } = {}) {
    await journal(`UPDATE catalog_transfer_capabilities SET status = $2, outcome = $3, bytes_size = coalesce($4::bigint, bytes_size), bytes_sha256 = coalesce($5, bytes_sha256), resolved_at = now(), last_error = $6
      WHERE capability_hash = $1 AND status IN ('ISSUED', 'REDEEMED')`, [hash, status, outcome, bytes ? bytes.size : null, bytes ? bytes.sha256 : null, error ? String(error.code || error.message || error).slice(0, 1000) : null]);
  }
  async function enqueueReconcile(uid, operationId, partKey) {
    await journal(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, 'TRANSFER_RECONCILE', $3, $4) ON CONFLICT (job_id) DO NOTHING`, [`job-reconcile-${operationId}-${partKey}`.slice(0, 64), uid, operationId, canonicalJson({ partKey })]);
  }
  const drain = (stream) => { if (stream && typeof stream.resume === 'function') { try { stream.resume(); } catch { /* ignore */ } } };

  // ---------- POST /operations/:id/parts/:partKey/capability ----------
  async function issueUploadCapability({ userId, era, epoch, operationId, partKey } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId) || typeof partKey !== 'string' || !PART_RE.test(partKey)) throw inputInvalid('OPERATION_OR_PART');
    if (!gateway) throw new CatalogQueryError('TRANSFER_UNAVAILABLE', 503, 'no transfer gateway is configured', { reason: 'NO_GATEWAY' });
    const token = newCapabilityToken(randomBytes); const hash = capabilityHash(token);
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const part = await loadPart(client, uid, operationId, partKey, { forUpdate: true });
      assertUploadable(part);
      if (part.role === 'PROJECT') throw inputInvalid('PROJECT_USES_MASTER', { route: `PUT /catalog/v1/operations/${operationId}/parts/${partKey}/project` });
      await assertNotUncertain(client, uid, operationId, partKey, part);
      // Una sola capacidad viva por parte: las anteriores no redimidas se revocan; las redimidas sin despacho quedan ABORTED.
      await client.query(`UPDATE catalog_transfer_capabilities SET status = 'REVOKED', resolved_at = now(), last_error = 'SUPERSEDED' WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 AND status = 'ISSUED'`, [uid, operationId, partKey]);
      await client.query(`UPDATE catalog_transfer_capabilities SET status = 'FAILED', outcome = 'ABORTED', resolved_at = now(), last_error = 'SUPERSEDED' WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 AND status = 'REDEEMED'`, [uid, operationId, partKey]);
      const attempt = await nextAttempt(client, uid, operationId, partKey);
      const ttlS = Math.max(1, Math.round(capabilityTtlMs / 1000));
      const r = await client.query(`INSERT INTO catalog_transfer_capabilities(capability_hash, user_id, operation_id, part_key, direction, authority_epoch, attempt, status, expires_at)
        VALUES ($1, $2, $3, $4, 'UPLOAD', $5::bigint, $6, 'ISSUED', now() + make_interval(secs => $7)) RETURNING expires_at`, [hash, uid, operationId, partKey, ctx.authority_epoch, attempt, ttlS]);
      metrics.capabilitiesIssued++;
      return { operationId, partKey, token, expiresAt: r.rows[0].expires_at, attempt, uploadPath: `/catalog/v1/transfer/upload/${token}`, method: 'PUT', declaredSize: part.declared_size, declaredSha256: part.declared_sha256, singleUse: true };
    });
  }

  // Envío común (Direct por gateway o PROJECT por MASTER): despacho → remoto → recibo, con journal y clasificación fail-closed.
  async function dispatchAndSend({ uid, era, epoch, operationId, partKey, part, hash, attempt, measured, filePath, filename, send }) {
    const d = await operations.markDispatched({ userId: uid, era, epoch, operationId, partKey });
    let receipt;
    try { receipt = await send({ randomId: d.randomId, filePath, filename }); } catch (error) {
      const c = classifySendFailure(error);
      if (c.status === 'CONSUMED') {
        metrics.uncertain++;
        await resolveCapability(hash, 'CONSUMED', 'UNCERTAIN', { bytes: measured, error });
        await enqueueReconcile(uid, operationId, partKey);
        log('[catalog-transport] send uncertain', { operationId, partKey, code: error?.code });
        const dto = await operations.getOperation({ userId: uid, operationId });
        return { status: 202, body: { ...dto, upload: { partKey, attempt, state: 'UNCERTAIN', reconcile: true, resend: 'BLOCKED', retryAfterMs: c.retryAfterMs, bytesSha256: measured.sha256, level: EVIDENCE_LEVELS.GATEWAY } } };
      }
      metrics[c.outcome === 'REVOKED' ? 'revoked' : c.outcome === 'PERMANENT' ? 'permanent' : 'rejected']++;
      await resolveCapability(hash, 'FAILED', c.outcome, { bytes: measured, error });
      throw new CatalogQueryError(c.code, c.http, `send failed without effect (${c.outcome}): ${String(error?.message || error).slice(0, 200)}`, { partKey, attempt, outcome: c.outcome, retry_after_ms: c.retryAfterMs || undefined, same_identity: c.outcome !== 'REVOKED' && c.outcome !== 'PERMANENT', rpc: error?.classification?.code || error?.code || null });
    }
    if (!receipt || !Number.isSafeInteger(Number(receipt.messageId)) || Number(receipt.messageId) <= 0) {
      metrics.uncertain++;
      await resolveCapability(hash, 'CONSUMED', 'UNCERTAIN', { bytes: measured, error: new Error('NO_MESSAGE_ID') });
      await enqueueReconcile(uid, operationId, partKey);
      const dto = await operations.getOperation({ userId: uid, operationId });
      return { status: 202, body: { ...dto, upload: { partKey, attempt, state: 'UNCERTAIN', reconcile: true, resend: 'BLOCKED', bytesSha256: measured.sha256, level: EVIDENCE_LEVELS.GATEWAY } } };
    }
    let dto;
    try {
      dto = await operations.putReceipt({ userId: uid, era, epoch, operationId, partKey, receipt: { messageId: Number(receipt.messageId), documentId: receipt.documentId ?? null, size: Number.isSafeInteger(receipt.size) && receipt.size > 0 ? receipt.size : measured.size, senderId: receipt.senderId ?? null, chatId: receipt.chatId ?? part.chat_id, bytesSha256: measured.sha256 } });
    } catch (error) {
      // Enviado pero sin recibo persistido: incierto para el catálogo; nunca reenviar, reconciliar.
      metrics.uncertain++;
      await resolveCapability(hash, 'CONSUMED', 'UNCERTAIN', { bytes: measured, error }).catch(() => {});
      await enqueueReconcile(uid, operationId, partKey).catch(() => {});
      throw new CatalogQueryError('RECEIPT_PERSIST_FAILED', 503, 'the part was sent but its receipt could not be recorded; reconciliation is pending', { partKey, attempt, reconcile: true, cause: error?.code || null });
    }
    metrics.sent++;
    await resolveCapability(hash, 'CONSUMED', 'SENT', { bytes: measured });
    return { status: 200, body: { ...dto, upload: { partKey, attempt, state: 'RECEIPT', bytesSha256: measured.sha256, level: EVIDENCE_LEVELS.GATEWAY, verification: 'PENDING_PROVIDER' } } };
  }

  // Recepción acotada en temporal + comparación con lo declarado (C7.9). Falla sin efecto; el journal registra la causa.
  async function spool({ stream, contentLength, maxBytes, declaredSize, declaredSha256, hash, admissionImpl }) {
    let slot;
    try { slot = admissionImpl.acquire({ maxBytes, contentLength }); } catch (error) { drain(stream); await resolveCapability(hash, 'FAILED', 'ABORTED', { error }); throw error; }
    const filePath = path.join(tempDir, `${randomUUID()}.part`);
    let measured;
    try {
      measured = await spoolToFile(stream, { filePath, maxBytes });
    } catch (error) {
      slot.release(); await fs.promises.unlink(filePath).catch(() => {});
      if (error && error.code === 'TRANSFER_TOO_LARGE') { metrics.mismatches++; drain(stream); await resolveCapability(hash, 'FAILED', 'BYTES_MISMATCH', { error }); throw new CatalogQueryError('PART_BYTES_MISMATCH', 409, 'received bytes exceed the declared size; reselect the same file', { declared: String(declaredSize), max_bytes: maxBytes }); }
      metrics.aborted++;
      await resolveCapability(hash, 'FAILED', 'ABORTED', { error });
      throw new CatalogQueryError('UPLOAD_ABORTED', 400, 'the upload stream ended before all bytes arrived', { cause: error?.code || error?.message || null });
    }
    if (measured.size !== Number(declaredSize) || (declaredSha256 && measured.sha256 !== declaredSha256)) {
      slot.release(); await fs.promises.unlink(filePath).catch(() => {});
      metrics.mismatches++;
      await resolveCapability(hash, 'FAILED', 'BYTES_MISMATCH', { bytes: measured });
      throw new CatalogQueryError('PART_BYTES_MISMATCH', 409, 'received bytes differ from the declared size/hash; reselect the same file', { declared: String(declaredSize), received: measured.size, hash_matches: declaredSha256 ? measured.sha256 === declaredSha256 : null });
    }
    return { filePath, measured, release: async () => { slot.release(); await fs.promises.unlink(filePath).catch(() => {}); } };
  }

  // ---------- PUT /transfer/upload/:token (cuerpo = bytes de la parte) ----------
  async function uploadPart({ userId, era, epoch, token, stream, contentLength = null } = {}) {
    const uid = requireUserId(userId);
    if (!gateway || typeof gateway.sendPart !== 'function') { drain(stream); throw new CatalogQueryError('TRANSFER_UNAVAILABLE', 503, 'no transfer gateway is configured', { reason: 'NO_GATEWAY' }); }
    if (!stream || typeof stream.pipe !== 'function') throw inputInvalid('STREAM');
    let hash;
    try { hash = capabilityHash(token); } catch (error) { drain(stream); throw error; }
    metrics.uploads++;
    // 1. Redimir (un solo uso) y cargar la identidad persistida. Transacción breve; termina antes de leer un byte.
    let cap;
    try {
      cap = await mutationTx(uid, { era, epoch }, async (client, _ctx, u) => {
        const r = await client.query(`UPDATE catalog_transfer_capabilities SET status = 'REDEEMED', redeemed_at = now() WHERE capability_hash = $1 AND user_id = $2 AND direction = 'UPLOAD' AND status = 'ISSUED' AND expires_at > now() RETURNING operation_id, part_key, attempt`, [hash, u]);
        if (!r.rows.length) {
          const x = (await client.query('SELECT status, expires_at <= now() AS expired FROM catalog_transfer_capabilities WHERE capability_hash = $1 AND user_id = $2', [hash, u])).rows[0];
          if (x && x.expired && x.status === 'ISSUED') { await client.query(`UPDATE catalog_transfer_capabilities SET status = 'EXPIRED', resolved_at = now() WHERE capability_hash = $1`, [hash]); throw Object.assign(new CatalogQueryError('CAPABILITY_EXPIRED', 403, 'transfer capability expired; request a new one', { reason: 'EXPIRED' }), { commit: true }); }
          throw new CatalogQueryError('CAPABILITY_INVALID', 403, 'transfer capability is unknown, used or revoked', { reason: x ? x.status : 'UNKNOWN' });
        }
        const row = r.rows[0];
        const part = await loadPart(client, u, row.operation_id, row.part_key, { forUpdate: true });
        try { assertUploadable(part); } catch (error) { await client.query(`UPDATE catalog_transfer_capabilities SET status = 'FAILED', outcome = 'SUPERSEDED', resolved_at = now(), last_error = $2 WHERE capability_hash = $1`, [hash, error.code]); throw Object.assign(error, { commit: true }); }
        return { ...part, operationId: row.operation_id, attempt: row.attempt };
      });
    } catch (error) { drain(stream); throw error; }
    // 2. Bytes al temporal (sin SQL) y comparación con lo declarado.
    const spooled = await spool({ stream, contentLength, maxBytes: Number(cap.declared_size), declaredSize: cap.declared_size, declaredSha256: cap.declared_sha256, hash, admissionImpl: directAdmission });
    try {
      // 3–5. despacho (misma identidad en reintentos) → envío por el gateway (remoto) → recibo candidato.
      return await dispatchAndSend({ uid, era, epoch, operationId: cap.operationId, partKey: cap.part_key, part: cap, hash, attempt: cap.attempt, measured: spooled.measured, filePath: spooled.filePath, filename: cap.filename,
        send: ({ randomId, filePath, filename }) => gateway.sendPart({ operationId: cap.operationId, partKey: cap.part_key, randomId, chatId: cap.chat_id, file: { name: filename || `${cap.part_key}.bin`, size: spooled.measured.size, path: filePath, sha256: spooled.measured.sha256 }, mimeType: cap.mime || 'application/octet-stream', fileName: filename || `${cap.part_key}.bin` }) });
    } finally { await spooled.release(); }
  }

  // ---------- PUT /operations/:id/parts/:partKey/project (PROJECT por MASTER; intención durable antes de publicar) ----------
  async function uploadProjectPart({ userId, era, epoch, operationId, partKey, stream, contentLength = null, filename = null } = {}) {
    const uid = requireUserId(userId);
    if (typeof operationId !== 'string' || !ID_RE.test(operationId) || typeof partKey !== 'string' || !PART_RE.test(partKey)) { drain(stream); throw inputInvalid('OPERATION_OR_PART'); }
    if (!master || typeof master.publishProjectFile !== 'function' || typeof master.resolveSenderId !== 'function') { drain(stream); throw new CatalogQueryError('PROJECT_ACCESS_UNAVAILABLE', 503, 'PROJECT MASTER transport is unavailable', { reason: 'NO_MASTER' }); }
    if (typeof resolveProjectAccess !== 'function') { drain(stream); throw new CatalogQueryError('PROJECT_ACCESS_UNAVAILABLE', 503, 'PROJECT Access resolver is unavailable', { reason: 'NO_ACCESS' }); }
    if (!stream || typeof stream.pipe !== 'function') throw inputInvalid('STREAM');
    metrics.projectUploads++;
    // Access (como hoy): el tope de bytes del plan se resuelve antes de recibir un byte; un downgrade rechaza sin efecto.
    let access;
    try { access = await resolveProjectAccess(uid); } catch (error) { drain(stream); throw new CatalogQueryError(error?.code || 'PROJECT_ACCESS_UNAVAILABLE', Number(error?.status) || 503, String(error?.message || 'PROJECT Access is unavailable'), {}); }
    const maxBytes = Number(access && access.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) { drain(stream); throw new CatalogQueryError('PROJECT_ACCESS_UNAVAILABLE', 503, 'PROJECT Access did not return a byte ceiling', {}); }
    // 1. Intención durable: journal del intento (sin token al cliente) bajo el cerco de era/época.
    const hash = sha256Hex(`project:${randomUUID()}`);
    let cap;
    try {
      cap = await mutationTx(uid, { era, epoch }, async (client, ctx, u) => {
        const part = await loadPart(client, u, operationId, partKey, { forUpdate: true });
        assertUploadable(part);
        if (part.role !== 'PROJECT') throw inputInvalid('NOT_A_PROJECT_PART', { role: part.role });
        if (Number(part.declared_size) > maxBytes) throw new CatalogQueryError('PROJECT_TOO_LARGE', 413, 'PROJECT exceeds the plan byte limit', { declared: part.declared_size, max_bytes: maxBytes });
        await assertNotUncertain(client, u, operationId, partKey, part);
        await client.query(`UPDATE catalog_transfer_capabilities SET status = 'FAILED', outcome = 'ABORTED', resolved_at = now(), last_error = 'SUPERSEDED' WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 AND status = 'REDEEMED'`, [u, operationId, partKey]);
        const attempt = await nextAttempt(client, u, operationId, partKey);
        await client.query(`INSERT INTO catalog_transfer_capabilities(capability_hash, user_id, operation_id, part_key, direction, authority_epoch, attempt, status, expires_at, redeemed_at)
          VALUES ($1, $2, $3, $4, 'PROJECT_UPLOAD', $5::bigint, $6, 'REDEEMED', now() + make_interval(secs => $7), now())`, [hash, u, operationId, partKey, ctx.authority_epoch, attempt, Math.max(1, Math.round(capabilityTtlMs / 1000))]);
        return { ...part, attempt };
      });
    } catch (error) { drain(stream); throw error; }
    // 2. Bytes al temporal con el tope del plan y lo declarado (medir como hoy, sin SQL).
    const spooled = await spool({ stream, contentLength, maxBytes: Math.min(maxBytes, Number(cap.declared_size)), declaredSize: cap.declared_size, declaredSha256: cap.declared_sha256, hash, admissionImpl: masterAdmission });
    try {
      // 3. Remitente MASTER (remoto, sin SQL) fijado antes del primer despacho; después queda congelado (D-T09-4).
      let senderId;
      try { senderId = String(await master.resolveSenderId({ chatId: cap.chat_id, userId: uid })); } catch (error) { await resolveCapability(hash, 'FAILED', 'UPLOAD_FAILED', { bytes: spooled.measured, error }); throw new CatalogQueryError('PROJECT_ACCESS_UNAVAILABLE', 503, 'MASTER sender identity is unavailable', { cause: error?.code || null }); }
      if (!/^[0-9]{1,20}$/.test(senderId)) { await resolveCapability(hash, 'FAILED', 'UPLOAD_FAILED', { bytes: spooled.measured }); throw new CatalogQueryError('PROJECT_ACCESS_UNAVAILABLE', 503, 'MASTER sender identity is not numeric', {}); }
      if (cap.sender_id !== senderId) {
        try { await operations.assignSender({ userId: uid, era, epoch, operationId, partKey, senderId }); } catch (error) { await resolveCapability(hash, 'FAILED', 'UPLOAD_FAILED', { bytes: spooled.measured, error }); throw error; }
      }
      const caption = captionFor({ operationId, partKey });
      return await dispatchAndSend({ uid, era, epoch, operationId, partKey, part: cap, hash, attempt: cap.attempt, measured: spooled.measured, filePath: spooled.filePath, filename: filename || cap.filename,
        send: async ({ randomId, filePath, filename: name }) => {
          const sent = await master.publishProjectFile({ chatId: cap.chat_id, filePath, filename: name || cap.filename || 'project.zip', caption, sizeBytes: spooled.measured.size, sha256: spooled.measured.sha256, randomId, beatId: cap.beat_id });
          return { messageId: sent?.messageId, documentId: sent?.documentId ?? null, size: Number.isSafeInteger(sent?.sizeBytes) ? sent.sizeBytes : spooled.measured.size, senderId: sent?.senderId != null ? String(sent.senderId) : senderId, chatId: cap.chat_id };
        } });
    } finally { await spooled.release(); }
  }

  // Estado de intentos por parte (sin token ni hash): el cliente ve si hay una subida incierta pendiente de reconciliación.
  async function listAttempts({ userId, operationId } = {}) {
    const uid = requireUserId(userId);
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    const r = await journal(`SELECT part_key, direction, attempt, status, outcome, bytes_size::text AS bytes_size, bytes_sha256, issued_at, resolved_at FROM catalog_transfer_capabilities WHERE user_id = $1 AND operation_id = $2 ORDER BY part_key, attempt`, [uid, operationId]);
    return { operationId, attempts: r.rows.map((a) => ({ partKey: a.part_key, direction: a.direction, attempt: a.attempt, status: a.status, outcome: a.outcome, bytesSize: a.bytes_size, bytesSha256: a.bytes_sha256, level: a.bytes_sha256 ? EVIDENCE_LEVELS.GATEWAY : null, issuedAt: a.issued_at, resolvedAt: a.resolved_at })) };
  }

  return Object.freeze({ issueUploadCapability, uploadPart, uploadProjectPart, listAttempts, metrics, admission: directAdmission, projectAdmission: masterAdmission, limits: Object.freeze({ CAPABILITY_TTL_MS: capabilityTtlMs, TOKEN_BYTES }) });
}

module.exports = { CAPABILITY_TTL_MS, TOKEN_BYTES, TOKEN_RE, EVIDENCE_LEVELS, INFLIGHT, newCapabilityToken, capabilityHash, createMeasuringStream, spoolToFile, createTempAdmission, classifySendFailure, createCatalogTransport };
