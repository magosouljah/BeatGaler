'use strict';
// T09 — Intenciones de transferencia, reservas y máquina de estados (CONTRATO C7/C8, C1.10; NATIVO r2.1 §10 T09 simplificada).
//  - IMPORT/REPLACE crean una operación durable en SQL bajo el lock de la biblioteca: cuota = active+trash+purging+pending < Access
//    (resolver inyectado), tombstone, Access; reserva de 15 min renovable hasta 24 h; partes con random_id (int64 firmado como texto),
//    sender, chat, partKey, tamaño y hash declarado persistidos ANTES de cualquier envío. Nunca bootstrap desde INDEX ni ledger legacy.
//  - Recibo candidato (RECEIPT) ≠ verificación (VERIFIED): el verificador (gateway T11) registra la evidencia con fencing
//    epoch/lease_generation/operation. Mismo recibo → replay; distinto → 409 RECEIPT_CONFLICT.
//  - commit: idempotente; 202 si falta verificación; 200 COMMITTED (instala archivos/objetos, beat nuevo o versión nueva, contadores,
//    reserva CONSUMED, eventos y resultado en la misma transacción, sin red); 409 ante conflicto (objetos nuevos conservados sin vincular).
//  - cancel: no revierte COMMITTED; con posible envío (DISPATCHED/RECEIPT) → RECONCILE con objetos retenidos; si no → CANCELED y la
//    reserva se libera. La reserva vencida bloquea el commit hasta una nueva admisión (readmit), nunca borra bytes.
//  - Jobs C8: claim FOR UPDATE SKIP LOCKED (lote ≤10, lease 60 s, lease_generation creciente), renew en transacción propia,
//    checkpoint con fencing; backoff exponencial con jitter ≤15 min; 8 fallos transitorios → BLOCKED. El bucle del worker es T10.
// PURGE se adscribe a T15 (501 en la API hasta entonces). Sin transporte: solo SQL + crypto.

const crypto = require('crypto');
const { requireUserId, partJobId } = require('./contract');
const { canonicalJson, CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');
const codec = require('./legacy-codec');
const rules = require('./metadata-rules');
const { STATEMENT_TIMEOUT_MS } = require('./queries');
const { refreshGroupsAndFacets, normKeysOf } = require('./commands');

const RESERVATION_TTL_MS = 15 * 60_000;
const RESERVATION_MAX_MS = 24 * 60 * 60_000;
const JOB_LEASE_MS = 60_000;
const JOB_CLAIM_MAX = 10;
const JOB_BACKOFF_MAX_MS = 15 * 60_000;
const JOB_TRANSIENT_FAILURES_TO_BLOCK = 8;
const PARTS_MAX = 64;
const INTENT_MAX_BYTES = 64 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SLOT_RE = /^(MASTER|ARTWORK|PROJECT|FILES:[0-9]{1,6})$/;
const ROLES = Object.freeze(['MASTER', 'WAV', 'ARTWORK', 'PROJECT', 'SAMPLES', 'STEMS', 'LOOP']);
const SLOT_ROLE = Object.freeze({ MASTER: ['MASTER'], ARTWORK: ['ARTWORK'], PROJECT: ['PROJECT'] });
const SHA_RE = /^[0-9a-f]{64}$/;

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const notFound = (what) => new CatalogQueryError('NOT_FOUND', 404, `${what} is not accessible`, {});
const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sqlError = (error) => {
  if (error instanceof CatalogAuthorityError) return error;
  if (error?.code === '57014') return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog statement timed out', { sqlstate: '57014' });
  if (['BGL01', 'BGN04', 'BGA05', 'BGC02'].includes(error?.code)) return new CatalogQueryError('CATALOG_NATIVE_RULE', 409, 'database native rule rejected the mutation', { sqlstate: error.code, detail: error.detail || null });
  return new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog is unavailable (SQL_ERROR)', { reason: 'SQL_ERROR', sqlstate: error?.code || null, sql_message: error?.code ? String(error.message).slice(0, 200) : null });
};

// random_id de Telegram: entero firmado de 64 bits, uniforme, como string decimal (C7.3). Se persiste antes del efecto.
function randomInt64String(bytes = crypto.randomBytes) {
  const b = bytes(8);
  return b.readBigInt64BE(0).toString();
}
const int64 = (s) => typeof s === 'string' && /^-?[0-9]{1,19}$/.test(s) && BigInt(s) >= -(2n ** 63n) && BigInt(s) <= 2n ** 63n - 1n;

// ---------- validación de la intención (C5/C7) ----------
function validateParts(parts) {
  if (!Array.isArray(parts) || parts.length < 1) throw inputInvalid('PARTS_EMPTY');
  if (parts.length > PARTS_MAX) throw inputInvalid('PARTS_TOO_MANY', { max: PARTS_MAX });
  const seenKeys = new Set(); const seenSlot = new Set(); const out = [];
  for (const [i, p] of parts.entries()) {
    if (!p || typeof p !== 'object') throw inputInvalid('PART', { index: i });
    const partKey = String(p.partKey ?? `${p.slotKey}:${p.partIndex ?? 0}`);
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(partKey)) throw inputInvalid('PART_KEY', { index: i });
    if (typeof p.slotKey !== 'string' || !SLOT_RE.test(p.slotKey)) throw inputInvalid('SLOT_KEY', { index: i });
    if (!ROLES.includes(p.role)) throw inputInvalid('ROLE', { index: i, allowed: ROLES });
    if (SLOT_ROLE[p.slotKey] && !SLOT_ROLE[p.slotKey].includes(p.role)) throw inputInvalid('ROLE_SLOT_MISMATCH', { index: i });
    const partIndex = p.partIndex ?? 0;
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex > 999_999) throw inputInvalid('PART_INDEX', { index: i });
    if (!Number.isSafeInteger(p.size) || p.size <= 0) throw inputInvalid('PART_SIZE', { index: i });
    if (p.sha256 !== undefined && p.sha256 !== null && !(typeof p.sha256 === 'string' && SHA_RE.test(p.sha256))) throw inputInvalid('PART_SHA256', { index: i });
    if (p.filename !== undefined && p.filename !== null && (typeof p.filename !== 'string' || p.filename.length > 512)) throw inputInvalid('PART_FILENAME', { index: i });
    if (p.mime !== undefined && p.mime !== null && (typeof p.mime !== 'string' || p.mime.length > 128)) throw inputInvalid('PART_MIME', { index: i });
    if (seenKeys.has(partKey)) throw inputInvalid('PART_KEY_DUPLICATE', { partKey });
    const slotIdx = `${p.slotKey}#${partIndex}`;
    if (seenSlot.has(slotIdx)) throw inputInvalid('PART_SLOT_DUPLICATE', { slotKey: p.slotKey, partIndex });
    seenKeys.add(partKey); seenSlot.add(slotIdx);
    out.push({ partKey, slotKey: p.slotKey, role: p.role, partIndex, size: p.size, sha256: p.sha256 ?? null, filename: p.filename ?? null, mime: p.mime ?? null });
  }
  return out;
}
function validateIntent(input) {
  const kind = input?.kind;
  if (!['IMPORT', 'REPLACE', 'PURGE'].includes(kind)) throw inputInvalid('OPERATION_KIND');
  if (kind === 'PURGE') throw new CatalogQueryError('INPUT_INVALID', 400, 'PURGE is a durable purge intent handled by catalog/purge.js (POST /operations {kind: PURGE})', { reason: 'PURGE_ROUTE' });
  const parts = validateParts(input.parts);
  if (kind === 'IMPORT' && !parts.some((p) => p.slotKey === 'MASTER')) throw inputInvalid('IMPORT_REQUIRES_MASTER');
  let metadata = null;
  if (input.metadata !== undefined && input.metadata !== null) {
    const v = rules.validatePatch(input.metadata);
    if (!v.ok) throw inputInvalid('METADATA', { errors: v.errors });
    metadata = v.set;
  }
  if (kind === 'IMPORT' && (!metadata || typeof metadata.name !== 'string')) throw inputInvalid('IMPORT_REQUIRES_NAME');
  let beatId = null; let expectedVersion = null;
  if (kind === 'REPLACE') {
    if (typeof input.beatId !== 'string' || !input.beatId) throw inputInvalid('BEAT_ID');
    beatId = input.beatId;
    if (!/^[1-9][0-9]{0,17}$/.test(String(input.expectedVersion ?? ''))) throw inputInvalid('EXPECTED_VERSION');
    expectedVersion = String(input.expectedVersion);
  }
  const intent = { kind, parts, metadata, beatId, expectedVersion };
  if (Buffer.byteLength(JSON.stringify(intent), 'utf8') > INTENT_MAX_BYTES) throw new CatalogQueryError('PAYLOAD_TOO_LARGE', 413, 'intent exceeds 64 KiB', { max_bytes: INTENT_MAX_BYTES });
  return intent;
}

// Documento canónico v2 de un beat nativo nuevo (NATIVO §7: generado por el servidor; codec T04 lo valida igual).
function nativeBeatDocument(beatId, metadata) {
  const doc = { id: beatId, name: metadata.name, bpm: metadata.bpm ?? '', key: metadata.key ?? '', tags: metadata.tags ?? [], rating: metadata.rating ?? 0, color: metadata.color ?? '', color2: metadata.color2 ?? '' };
  if (metadata.crop !== undefined) doc.image_crop = metadata.crop;
  return doc;
}

function createCatalogOperations({ pool = null, authority = null, resolveAccess = null, now = () => new Date(), randomUUID = () => crypto.randomUUID(), randomBytes = crypto.randomBytes } = {}) {
  if (!authority || typeof authority.requireLibraryForMutation !== 'function') throw new Error('createCatalogOperations requires the catalog authority');
  if (typeof resolveAccess !== 'function') throw new Error('createCatalogOperations requires resolveAccess(userId) → { maxBeats: number|null }');

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
  async function readTx(userId, fn) {
    const uid = requireUserId(userId);
    await authority.availability();
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try { await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`); return await fn(client, uid); } finally { await client.query('COMMIT').catch(() => {}); }
    } catch (error) { throw sqlError(error); } finally { client.release(); }
  }

  const OP_SQL = `SELECT o.operation_id, o.kind, o.status, o.beat_id, o.expected_version::text AS expected_version, o.generation_id, o.authority_era::text AS authority_era, o.authority_epoch::text AS authority_epoch,
    o.idempotency_key, o.request_hash, o.intent_json, o.result_json, o.chat_id, o.sender_id, o.reservation_id, o.declared_bytes::text AS declared_bytes, o.last_error, o.created_at, o.updated_at, o.completed_at
    FROM catalog_transfer_operations o WHERE o.user_id = $1 AND o.operation_id = $2`;
  const PARTS_SQL = `SELECT p.part_key, p.slot_key, p.role, p.part_index, p.filename, p.mime, p.declared_size::text AS declared_size, p.declared_sha256, p.random_id, p.sender_id, p.chat_id, p.dispatch_state,
    p.dispatched_at, p.receipt_json, p.receipt_hash, p.provider_message_id::text AS provider_message_id, p.provider_document_id, p.verified_size::text AS verified_size, p.verified_sha256, p.verified_at, p.attempts
    FROM catalog_operation_parts p WHERE p.user_id = $1 AND p.operation_id = $2 ORDER BY p.slot_key, p.part_index`;
  const RES_SQL = 'SELECT reservation_id, state, expires_at, max_until, renewals, created_at FROM catalog_reservations WHERE user_id = $1 AND operation_id = $2';
  async function opDto(client, uid, operationId, extra = {}) {
    const o = (await client.query(OP_SQL, [uid, operationId])).rows[0];
    if (!o) throw notFound('operation');
    const parts = (await client.query(PARTS_SQL, [uid, operationId])).rows;
    const res = (await client.query(RES_SQL, [uid, operationId])).rows[0] || null;
    return {
      operationId: o.operation_id, kind: o.kind, status: o.status, beatId: o.beat_id, expectedVersion: o.expected_version, generationId: o.generation_id, authorityEra: o.authority_era, epoch: o.authority_epoch,
      intent: JSON.parse(o.intent_json), result: o.result_json ? JSON.parse(o.result_json) : null, lastError: o.last_error, createdAt: o.created_at, updatedAt: o.updated_at, completedAt: o.completed_at,
      // Identidad de envío expuesta solo en lo necesario para la transferencia por gateway: nunca chat ni token (§8.6).
      parts: parts.map((p) => ({ partKey: p.part_key, slotKey: p.slot_key, role: p.role, partIndex: p.part_index, filename: p.filename, mime: p.mime, declaredSize: p.declared_size, declaredSha256: p.declared_sha256,
        dispatchState: p.dispatch_state, dispatchedAt: p.dispatched_at, verified: p.dispatch_state === 'VERIFIED', verifiedSize: p.verified_size, verifiedSha256: p.verified_sha256, attempts: p.attempts })),
      reservation: res ? { reservationId: res.reservation_id, state: res.state, expiresAt: res.expires_at, maxUntil: res.max_until, renewals: res.renewals } : null,
      progress: { total: parts.length, verified: parts.filter((p) => p.dispatch_state === 'VERIFIED').length, receipts: parts.filter((p) => p.dispatch_state === 'RECEIPT').length },
      ...extra,
    };
  }
  async function idempotent(client, uid, key, hash) {
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY_RE.test(key)) throw inputInvalid('IDEMPOTENCY_KEY');
    const r = (await client.query('SELECT operation_id, request_hash FROM catalog_transfer_operations WHERE user_id = $1 AND idempotency_key = $2', [uid, key])).rows[0];
    if (!r) return null;
    if (r.request_hash !== hash) throw new CatalogQueryError('IDEMPOTENCY_MISMATCH', 409, 'idempotency key was used with a different request', { operation_id: r.operation_id });
    return r.operation_id;
  }
  // Cuota C1.10: active + trash + purging + pending contra Access (max_beats; null = sin límite). Nunca lee library_beats ni INDEX.
  async function assertQuota(client, uid, ctx) {
    const access = await resolveAccess(uid);
    const max = access && access.maxBeats !== undefined ? access.maxBeats : null;
    const c = (await client.query('SELECT active_count::int AS a, trash_count::int AS t, purging_count::int AS p, pending_count::int AS n FROM catalog_libraries WHERE user_id = $1', [uid])).rows[0];
    const used = c.a + c.t + c.p + c.n;
    if (max !== null && used >= max) throw new CatalogQueryError('QUOTA_EXCEEDED', 409, 'library quota is exhausted', { used, max, counts: { active: c.a, trash: c.t, purging: c.p, pending: c.n } });
    return { used, max };
  }
  async function senderFor(client, uid, ctx) {
    const v = (await client.query('SELECT v.transport_bot_id FROM vaults v WHERE v.user_id = $1', [uid])).rows[0];
    if (!v || !v.transport_bot_id) throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'library has no transport bot assigned', { reason: 'NO_SENDER' });
    if (!ctx.chat_id) throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'library has no CURRENT chat', { reason: 'NO_CURRENT_CHAT' });
    return { senderId: String(v.transport_bot_id), chatId: String(ctx.chat_id) };
  }

  // ---------- POST /catalog/v1/operations (IMPORT | REPLACE) ----------
  async function createOperation({ userId, era, epoch, idempotencyKey, intent } = {}) {
    const v = validateIntent(intent);
    const hash = sha256Hex(canonicalJson({ kind: v.kind, parts: v.parts, metadata: v.metadata, beatId: v.beatId, expectedVersion: v.expectedVersion }));
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const replay = await idempotent(client, uid, idempotencyKey, hash);
      if (replay) return opDto(client, uid, replay, { replay: true, created: false });
      const gen = ctx.generation_id;
      let beatId = v.beatId;
      if (v.kind === 'IMPORT') {
        await assertQuota(client, uid, ctx);
        beatId = `b-${randomUUID()}`; // servidor, dentro de ^[A-Za-z0-9._:@+-]{1,192}$ (NATIVO §7)
        const tomb = await client.query('SELECT 1 FROM catalog_tombstones WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, beatId]);
        if (tomb.rows.length) throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'generated id collides with a tombstone; retry', { reason: 'ID_COLLISION' });
      } else {
        const b = (await client.query("SELECT state, version::text AS version FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 FOR UPDATE", [uid, gen, beatId])).rows[0];
        if (!b || b.state === 'PURGED') throw notFound('beat');
        const tomb = await client.query('SELECT 1 FROM catalog_tombstones WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, beatId]);
        if (tomb.rows.length || b.state === 'PURGING') throw new CatalogQueryError('PURGE_PENDING', 409, 'beat is being purged or has a tombstone', { state: b.state });
        if (b.state !== 'ACTIVE') throw new CatalogQueryError('BEAT_NOT_ACTIVE', 409, 'only ACTIVE beats can be replaced', { state: b.state });
        if (b.version !== v.expectedVersion) throw new CatalogQueryError('VERSION_CONFLICT', 409, 'beat version does not match', { current_version: b.version, expected_version: v.expectedVersion });
      }
      const { senderId, chatId } = await senderFor(client, uid, ctx);
      const operationId = `top-${randomUUID()}`;
      const declaredBytes = v.parts.reduce((n, p) => n + p.size, 0);
      await client.query(`INSERT INTO catalog_transfer_operations(user_id, operation_id, generation_id, authority_era, authority_epoch, kind, idempotency_key, request_hash, intent_json, status, beat_id, expected_version, chat_id, sender_id, declared_bytes)
        VALUES ($1, $2, $3, $4::uuid, $5::bigint, $6, $7, $8, $9, 'PREPARED', $10, $11::bigint, $12, $13, $14::bigint)`,
      [uid, operationId, gen, ctx.authority_era, ctx.authority_epoch, v.kind, idempotencyKey, hash, canonicalJson(v), beatId, v.expectedVersion, chatId, senderId, declaredBytes]);
      // C7.3: identidad de envío por parte ANTES de cualquier efecto. UNIQUE (sender_id, random_id): un retry recupera la identidad; una operación nueva obtiene otra.
      for (const p of v.parts) {
        await client.query(`INSERT INTO catalog_operation_parts(user_id, operation_id, part_key, slot_key, role, part_index, filename, mime, declared_size, declared_sha256, random_id, sender_id, chat_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10,$11,$12,$13)`, [uid, operationId, p.partKey, p.slotKey, p.role, p.partIndex, p.filename, p.mime, p.size, p.sha256, randomInt64String(randomBytes), senderId, chatId]);
      }
      if (v.kind === 'IMPORT') {
        // Reserva atomizada por biblioteca (bajo el lock): pending_count+1 cuenta una vez; se consume una vez en el commit.
        const reservationId = `res-${randomUUID()}`;
        await client.query(`INSERT INTO catalog_reservations(user_id, reservation_id, operation_id, kind, state, expires_at, max_until)
          VALUES ($1, $2, $3, 'BEAT_SLOT', 'HELD', now() + make_interval(secs => $4), now() + make_interval(secs => $5))`, [uid, reservationId, operationId, RESERVATION_TTL_MS / 1000, RESERVATION_MAX_MS / 1000]);
        await client.query('UPDATE catalog_transfer_operations SET reservation_id = $3 WHERE user_id = $1 AND operation_id = $2', [uid, operationId, reservationId]);
        await client.query('UPDATE catalog_libraries SET pending_count = pending_count + 1, updated_at = now() WHERE user_id = $1', [uid]);
      } else {
        // REPLACE: versiones nuevas STAGED visibles como STAGED, las anteriores siguen vigentes (C7.2).
        for (const p of v.parts) {
          if (p.partIndex !== 0) continue;
          const fileId = `f-${operationId.slice(4, 12)}-${p.slotKey.replace(':', '_')}`;
          await client.query(`INSERT INTO catalog_file_versions(user_id, generation_id, file_id, beat_id, role, legacy_path, filename, mime, size_bytes, declared_sha256, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10,'STAGED') ON CONFLICT DO NOTHING`, [uid, gen, fileId, beatId, p.role, `$.${p.slotKey.toLowerCase().replace('files:', 'files[')}${p.slotKey.startsWith('FILES:') ? ']' : ''}`, p.filename, p.mime, v.parts.filter((x) => x.slotKey === p.slotKey).reduce((n, x) => n + x.size, 0), p.sha256]);
        }
      }
      return opDto(client, uid, operationId, { replay: false, created: true });
    });
  }

  // Marca de despacho (gateway T11): evidencia de que se intentó el envío; sin ella un cancel es CANCELED limpio.
  async function markDispatched({ userId, era, epoch, operationId, partKey } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId) || typeof partKey !== 'string') throw inputInvalid('OPERATION_OR_PART');
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
      if (!o) throw notFound('operation');
      if (!['PREPARED', 'TRANSFERRING', 'VERIFYING'].includes(o.status)) throw new CatalogQueryError('OPERATION_TRANSITION_INVALID', 409, `operation is ${o.status}`, { status: o.status });
      const r = await client.query(`UPDATE catalog_operation_parts SET dispatch_state = 'DISPATCHED', dispatched_at = coalesce(dispatched_at, now()), attempts = attempts + 1
        WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 AND dispatch_state IN ('PENDING', 'DISPATCHED') RETURNING random_id`, [uid, operationId, partKey]);
      if (!r.rows.length) throw new CatalogQueryError('PART_STATE_CONFLICT', 409, 'part is not dispatchable', {});
      if (o.status === 'PREPARED') await client.query("UPDATE catalog_transfer_operations SET status = 'TRANSFERRING' WHERE user_id = $1 AND operation_id = $2", [uid, operationId]);
      return { operationId, partKey, randomId: r.rows[0].random_id };
    });
  }

  // T12 (D-T09-4): el gateway/MASTER puede fijar el remitente real de una parte solo ANTES del primer despacho; nueva identidad = nuevo random_id.
  async function assignSender({ userId, era, epoch, operationId, partKey, senderId } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId) || typeof partKey !== 'string') throw inputInvalid('OPERATION_OR_PART');
    if (typeof senderId !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/.test(senderId)) throw inputInvalid('SENDER_ID');
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
      if (!o) throw notFound('operation');
      if (!['PREPARED', 'TRANSFERRING', 'VERIFYING'].includes(o.status)) throw new CatalogQueryError('OPERATION_TRANSITION_INVALID', 409, `operation is ${o.status}`, { status: o.status });
      const p = (await client.query('SELECT dispatch_state, attempts, sender_id, random_id FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 FOR UPDATE', [uid, operationId, partKey])).rows[0];
      if (!p) throw notFound('part');
      if (p.sender_id === senderId) return { operationId, partKey, senderId, randomId: p.random_id, changed: false };
      if (p.dispatch_state !== 'PENDING' || p.attempts > 0) throw new CatalogQueryError('PART_STATE_CONFLICT', 409, 'sender identity is frozen after the first dispatch', { dispatch_state: p.dispatch_state, attempts: p.attempts });
      const randomId = randomInt64String(randomBytes);
      await client.query('UPDATE catalog_operation_parts SET sender_id = $4, random_id = $5 WHERE user_id = $1 AND operation_id = $2 AND part_key = $3', [uid, operationId, partKey, senderId, randomId]);
      return { operationId, partKey, senderId, randomId, changed: true };
    });
  }

  // ---------- PUT /operations/:id/parts/:partKey/receipt (recibo candidato, no prueba) ----------
  async function putReceipt({ userId, era, epoch, operationId, partKey, receipt } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId) || typeof partKey !== 'string') throw inputInvalid('OPERATION_OR_PART');
    if (!receipt || typeof receipt !== 'object') throw inputInvalid('RECEIPT');
    const messageId = receipt.messageId; const size = receipt.size;
    if (!Number.isSafeInteger(messageId) || messageId <= 0) throw inputInvalid('RECEIPT_MESSAGE_ID');
    if (!Number.isSafeInteger(size) || size <= 0) throw inputInvalid('RECEIPT_SIZE');
    const documentId = receipt.documentId == null ? null : String(receipt.documentId);
    if (documentId !== null && !/^-?[0-9]{1,20}$/.test(documentId)) throw inputInvalid('RECEIPT_DOCUMENT_ID');
    // T12: hash calculado por el gateway sobre los bytes entregados al proveedor (nivel GATEWAY). No es verificación de bytes remotos.
    const bytesSha256 = receipt.bytesSha256 == null ? null : String(receipt.bytesSha256);
    if (bytesSha256 !== null && !SHA_RE.test(bytesSha256)) throw inputInvalid('RECEIPT_BYTES_SHA256');
    const canonical = canonicalJson({ messageId, documentId, size, senderId: receipt.senderId == null ? null : String(receipt.senderId), chatId: receipt.chatId == null ? null : String(receipt.chatId), bytesSha256 });
    const hash = sha256Hex(canonical);
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
      if (!o) throw notFound('operation');
      const p = (await client.query('SELECT dispatch_state, receipt_hash, declared_size::text AS declared_size, sender_id, chat_id FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 FOR UPDATE', [uid, operationId, partKey])).rows[0];
      if (!p) throw notFound('part');
      // Recibo de otra cuenta/vault/parte se rechaza: sender y chat deben coincidir con la identidad persistida (C7.5).
      if (receipt.senderId != null && !/^-?[0-9]{1,20}$/.test(String(receipt.senderId))) throw inputInvalid('RECEIPT_SENDER_ID');
      if (receipt.chatId != null && String(receipt.chatId) !== p.chat_id) throw new CatalogQueryError('RECEIPT_CONFLICT', 409, 'receipt chat does not match the operation chat', {});
      // T12: si la identidad persistida ya es un id numérico del proveedor (p. ej. MASTER asignado), el remitente del recibo debe coincidir.
      if (receipt.senderId != null && /^-?[0-9]{1,20}$/.test(p.sender_id) && String(receipt.senderId) !== p.sender_id) throw new CatalogQueryError('RECEIPT_CONFLICT', 409, 'receipt sender does not match the persisted sender identity', {});
      if (p.receipt_hash) {
        if (p.receipt_hash === hash) return opDto(client, uid, operationId, { replay: true, partKey });
        throw new CatalogQueryError('RECEIPT_CONFLICT', 409, 'a different receipt was already recorded for this part', { partKey });
      }
      if (!['PREPARED', 'TRANSFERRING', 'VERIFYING', 'RECONCILE'].includes(o.status)) throw new CatalogQueryError('OPERATION_TRANSITION_INVALID', 409, `operation is ${o.status}`, { status: o.status });
      if (size !== Number(p.declared_size)) throw new CatalogQueryError('RECEIPT_CONFLICT', 409, 'receipt size differs from the declared size', { declared: p.declared_size, received: size });
      await client.query(`UPDATE catalog_operation_parts SET dispatch_state = 'RECEIPT', dispatched_at = coalesce(dispatched_at, now()), receipt_json = $4, receipt_hash = $5, provider_message_id = $6::bigint, provider_document_id = $7
        WHERE user_id = $1 AND operation_id = $2 AND part_key = $3`, [uid, operationId, partKey, canonical, hash, messageId, documentId]);
      if (o.status !== 'VERIFYING') await client.query("UPDATE catalog_transfer_operations SET status = 'VERIFYING' WHERE user_id = $1 AND operation_id = $2", [uid, operationId]);
      // T10: el worker verifica con el proveedor fuera de SQL; el job nace en la misma transacción que el recibo.
      await client.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) DO NOTHING`, [partJobId('verify', operationId, partKey), uid, 'TRANSFER_VERIFY', operationId, canonicalJson({ partKey })]);
      return opDto(client, uid, operationId, { replay: false, partKey });
    });
  }

  // Verificación del proveedor (gateway T11 / worker T10), independiente del recibo del cliente, con fencing de lease (C7.5, C8).
  async function recordVerification({ userId, operationId, partKey, evidence, lease } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId) || typeof partKey !== 'string') throw inputInvalid('OPERATION_OR_PART');
    if (!evidence || !Number.isSafeInteger(evidence.size) || evidence.size <= 0 || (evidence.sha256 != null && !SHA_RE.test(String(evidence.sha256)))) throw inputInvalid('EVIDENCE');
    const uid = requireUserId(userId);
    await authority.availability();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
        if (lease) {
          const j = (await client.query('SELECT state, lease_owner, lease_generation::text AS g FROM catalog_jobs WHERE job_id = $1 FOR UPDATE', [lease.jobId])).rows[0];
          if (!j || j.state !== 'LEASED' || j.lease_owner !== lease.owner || j.g !== String(lease.generation)) throw new CatalogQueryError('LEASE_FENCED', 409, 'stale worker lease: evidence recorded as non-authoritative', { job_id: lease.jobId });
        }
        const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
        if (!o) throw notFound('operation');
        if (lease && lease.epoch !== undefined && String(lease.epoch) !== o.authority_epoch) throw new CatalogQueryError('CATALOG_EPOCH_STALE', 409, 'operation epoch differs from the lease epoch', {});
        const p = (await client.query('SELECT dispatch_state, declared_size::text AS declared_size, declared_sha256 FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND part_key = $3 FOR UPDATE', [uid, operationId, partKey])).rows[0];
        if (!p) throw notFound('part');
        if (p.dispatch_state === 'VERIFIED') { await client.query('COMMIT'); return { operationId, partKey, verified: true, replay: true }; }
        if (p.dispatch_state !== 'RECEIPT') throw new CatalogQueryError('PART_STATE_CONFLICT', 409, 'part has no receipt to verify', { dispatch_state: p.dispatch_state });
        if (evidence.size !== Number(p.declared_size)) throw new CatalogQueryError('VERIFICATION_MISMATCH', 409, 'provider size differs from the declared size', { declared: p.declared_size, provider: evidence.size });
        if (p.declared_sha256 && evidence.sha256 && evidence.sha256 !== p.declared_sha256) throw new CatalogQueryError('VERIFICATION_MISMATCH', 409, 'provider hash differs from the declared hash', {});
        await client.query(`UPDATE catalog_operation_parts SET dispatch_state = 'VERIFIED', verified_size = $4::bigint, verified_sha256 = $5, verified_json = $6, verified_at = now() WHERE user_id = $1 AND operation_id = $2 AND part_key = $3`,
          [uid, operationId, partKey, evidence.size, evidence.sha256 ?? null, canonicalJson(evidence)]);
        const pending = (await client.query("SELECT count(*)::int AS n FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND dispatch_state <> 'VERIFIED'", [uid, operationId])).rows[0].n;
        if (pending === 0 && ['VERIFYING', 'TRANSFERRING', 'PREPARED', 'RECONCILE'].includes(o.status)) await client.query("UPDATE catalog_transfer_operations SET status = 'READY' WHERE user_id = $1 AND operation_id = $2", [uid, operationId]);
        await client.query('COMMIT');
        return { operationId, partKey, verified: true, replay: false, ready: pending === 0 };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    } catch (error) { throw sqlError(error); } finally { client.release(); }
  }

  // ---------- POST /operations/:id/commit (idempotente; 202 | 200 | 409) ----------
  async function commitOperation({ userId, era, epoch, operationId } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
      if (!o) throw notFound('operation');
      if (o.status === 'COMMITTED') return { status: 200, operation: await opDto(client, uid, operationId, { replay: true }) };
      if (['CANCELED', 'FAILED', 'CONFLICT', 'BLOCKED'].includes(o.status)) throw new CatalogQueryError('OPERATION_TRANSITION_INVALID', 409, `operation is ${o.status}`, { status: o.status });
      const parts = (await client.query(PARTS_SQL, [uid, operationId])).rows;
      if (parts.some((p) => p.dispatch_state !== 'VERIFIED')) {
        // T10: el commit solicitado se completa por el worker cuando todas las partes estén verificadas (202 ahora).
        await client.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) DO NOTHING`, [`job-commit-${operationId}`, uid, 'TRANSFER_COMMIT', operationId, canonicalJson({ reason: 'CLIENT_COMMIT' })]);
        return { status: 202, operation: await opDto(client, uid, operationId, { pending: parts.filter((p) => p.dispatch_state !== 'VERIFIED').map((p) => p.part_key) }) };
      }
      if (o.status !== 'READY') await client.query("UPDATE catalog_transfer_operations SET status = 'READY' WHERE user_id = $1 AND operation_id = $2", [uid, operationId]);
      const gen = o.generation_id;
      if (gen !== ctx.generation_id || o.authority_epoch !== ctx.authority_epoch) throw new CatalogQueryError('CATALOG_EPOCH_STALE', 409, 'operation belongs to a previous epoch/generation', {});
      const intent = JSON.parse(o.intent_json);
      // Revalidación: versión/estado, Access/cuota y reserva vigente (C7.6).
      if (o.kind === 'IMPORT') {
        const res = (await client.query('SELECT state, expires_at <= now() AS expired FROM catalog_reservations WHERE user_id = $1 AND operation_id = $2 FOR UPDATE', [uid, operationId])).rows[0];
        if (!res || res.state !== 'HELD') throw new CatalogQueryError('RESERVATION_INVALID', 409, 'reservation is not held', { state: res ? res.state : null });
        if (res.expired) throw new CatalogQueryError('RESERVATION_EXPIRED', 409, 'reservation expired; request readmission', {});
        const access = await resolveAccess(uid);
        const c = (await client.query('SELECT active_count::int AS a, trash_count::int AS t, purging_count::int AS p, pending_count::int AS n FROM catalog_libraries WHERE user_id = $1', [uid])).rows[0];
        if (access && access.maxBeats !== null && access.maxBeats !== undefined && c.a + c.t + c.p + (c.n - 1) >= access.maxBeats) {
          throw new CatalogQueryError('QUOTA_EXCEEDED', 409, 'library quota no longer admits this import', { used: c.a + c.t + c.p + c.n - 1, max: access.maxBeats });
        }
      }
      let beatVersion; const touchedKeys = []; let tagsChanged = false;
      if (o.kind === 'IMPORT') {
        const doc = nativeBeatDocument(o.beat_id, intent.metadata);
        const p = codec.projectBeat(doc); const json = JSON.stringify(doc);
        const rank = (await client.query("SELECT coalesce(min(manual_rank), 1000)::text AS r FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE'", [uid, gen])).rows[0].r;
        const newRank = (BigInt(rank) - 1000n).toString(); // alta prepend (C6): rango menor que el mínimo, sin renumerar
        await client.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, color, color2, bpm_sort_class, bpm_sort, sort_order, manual_rank, has_artwork,
            legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display)
          VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12::numeric,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
        [uid, gen, o.beat_id, p.name, p.bpmText, p.keyText, p.rating, p.color, p.color2, p.bpmSortClass, p.bpmSort, newRank, parts.some((x) => x.slot_key === 'ARTWORK'), json, sha256Hex(json), Buffer.byteLength(json, 'utf8'), p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay]);
        for (const t of p.tags) await client.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uid, gen, o.beat_id, t.position, t.label, t.normKey, t.searchKey]);
        beatVersion = '1';
      } else {
        const b = (await client.query('SELECT state, version::text AS version FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 FOR UPDATE', [uid, gen, o.beat_id])).rows[0];
        if (!b || b.state !== 'ACTIVE') throw new CatalogQueryError('BEAT_NOT_ACTIVE', 409, 'beat is no longer ACTIVE', { state: b ? b.state : null });
        if (b.version !== o.expected_version) {
          // Conflicto: la versión ganadora no se sobrescribe; los objetos nuevos quedan sin vincular para resolución/cleanup (C7.6).
          await client.query("UPDATE catalog_transfer_operations SET status = 'CONFLICT', last_error = 'VERSION_CONFLICT' WHERE user_id = $1 AND operation_id = $2", [uid, operationId]);
          throw Object.assign(new CatalogQueryError('VERSION_CONFLICT', 409, 'beat version changed since the operation was created', { current_version: b.version, expected_version: o.expected_version }), { commit: true });
        }
        if (intent.metadata) {
          const before = JSON.parse((await client.query('SELECT legacy_json FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, o.beat_id])).rows[0].legacy_json);
          const after = { ...before };
          for (const [k, val] of Object.entries(intent.metadata)) after[k === 'crop' ? 'image_crop' : k] = val;
          const pj = codec.projectBeat(after); const json = JSON.stringify(after);
          await client.query(`UPDATE catalog_beats SET name = $4, bpm_text = $5, key_text = $6, rating = $7, color = $8, color2 = $9, bpm_sort_class = $10, bpm_sort = $11, legacy_json = $12, legacy_sha256 = $13, legacy_export_bytes = $14,
              name_display = $15, name_search = $16, key_display = $17, key_search = $18, bpm_display = $19, rating_display = $20 WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3`,
          [uid, gen, o.beat_id, pj.name, pj.bpmText, pj.keyText, pj.rating, pj.color, pj.color2, pj.bpmSortClass, pj.bpmSort, json, sha256Hex(json), Buffer.byteLength(json, 'utf8'), pj.nameDisplay, pj.nameSearch, pj.keyDisplay, pj.keySearch, pj.bpmDisplay, pj.ratingDisplay]);
          touchedKeys.push(...(await normKeysOf(client, uid, gen, [o.beat_id])));
          await client.query('DELETE FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, o.beat_id]);
          await client.query('DELETE FROM catalog_beat_tags WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, o.beat_id]);
          for (const t of pj.tags) await client.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uid, gen, o.beat_id, t.position, t.label, t.normKey, t.searchKey]);
          touchedKeys.push(...pj.tags.map((t) => t.normKey));
          tagsChanged = true;
        }
        beatVersion = (await client.query('UPDATE catalog_beats SET version = version + 1, updated_at = now(), has_artwork = has_artwork OR $4 WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 RETURNING version::text AS v', [uid, gen, o.beat_id, parts.some((x) => x.slot_key === 'ARTWORK')])).rows[0].v;
      }
      // Instalación de vínculos: objetos verificados (PRESENT solo tras verificación del proveedor, NATIVO §7), partes, ubicaciones KNOWN, versiones VERIFIED, slots actuales; anteriores RETIRED.
      const bySlot = new Map();
      for (const p of parts) { if (!bySlot.has(p.slot_key)) bySlot.set(p.slot_key, []); bySlot.get(p.slot_key).push(p); }
      const installed = [];
      for (const [slotKey, slotParts] of bySlot) {
        const first = slotParts.find((x) => x.part_index === 0) || slotParts[0];
        const fileId = `f-${operationId.slice(4, 12)}-${slotKey.replace(':', '_')}`;
        const total = slotParts.reduce((n, x) => n + Number(x.verified_size), 0);
        await client.query(`INSERT INTO catalog_file_versions(user_id, generation_id, file_id, beat_id, role, legacy_path, filename, mime, size_bytes, declared_sha256, verified_sha256, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,$10,$11,'VERIFIED')
          ON CONFLICT (user_id, generation_id, file_id) DO UPDATE SET status = 'VERIFIED', size_bytes = EXCLUDED.size_bytes, verified_sha256 = EXCLUDED.verified_sha256`,
        [uid, gen, fileId, o.beat_id, first.role, `$.${slotKey.toLowerCase().replace('files:', 'files[')}${slotKey.startsWith('FILES:') ? ']' : ''}`, first.filename, first.mime, total, first.declared_sha256, slotParts.length === 1 ? first.verified_sha256 : null]);
        for (const p of slotParts) {
          const objectId = `tg:${p.chat_id}:${p.provider_message_id}`;
          // sender numérico del proveedor (recibo) — la identidad del bot de transporte no es un id de Telegram.
          const providerSender = (() => { try { const r = JSON.parse(p.receipt_json || '{}'); return r && r.senderId != null && /^-?[0-9]{1,20}$/.test(String(r.senderId)) ? String(r.senderId) : null; } catch { return null; } })();
          await client.query(`INSERT INTO catalog_media_objects(user_id, object_id, provider, chat_id, message_id, document_id, sender_id, verified_at, status)
            VALUES ($1, $2, 'telegram', $3, $4::bigint, $5, $6, now(), 'PRESENT') ON CONFLICT (user_id, object_id) DO UPDATE SET status = 'PRESENT', verified_at = now()`, [uid, objectId, p.chat_id, p.provider_message_id, p.provider_document_id, providerSender]);
          await client.query('INSERT INTO catalog_file_parts(user_id, generation_id, file_id, part_index, size_bytes, declared_sha256, verified_sha256) VALUES ($1,$2,$3,$4,$5::bigint,$6,$7) ON CONFLICT DO NOTHING', [uid, gen, fileId, p.part_index, p.verified_size, p.declared_sha256, p.verified_sha256]);
          await client.query(`INSERT INTO catalog_part_locations(user_id, generation_id, file_id, part_index, location, reference_class, object_id, provider, locator, verification_level, checksum_sha256, verified_at)
            VALUES ($1,$2,$3,$4,'PRIMARY','KNOWN',$5,'telegram',$6,'PROVIDER',$7,now()) ON CONFLICT DO NOTHING`, [uid, gen, fileId, p.part_index, objectId, `direct:${p.provider_message_id}`, p.verified_sha256]);
        }
        const prev = (await client.query('SELECT file_id FROM catalog_current_files WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 AND slot_key = $4', [uid, gen, o.beat_id, slotKey])).rows[0];
        if (prev && prev.file_id !== fileId) {
          await client.query("UPDATE catalog_file_versions SET status = 'RETIRED', retained_until = now() + interval '35 days' WHERE user_id = $1 AND generation_id = $2 AND file_id = $3", [uid, gen, prev.file_id]);
          await client.query('UPDATE catalog_current_files SET file_id = $5 WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 AND slot_key = $4', [uid, gen, o.beat_id, slotKey, fileId]);
        } else if (!prev) {
          await client.query('INSERT INTO catalog_current_files(user_id, generation_id, beat_id, slot_key, file_id) VALUES ($1,$2,$3,$4,$5)', [uid, gen, o.beat_id, slotKey, fileId]);
        }
        installed.push({ slotKey, fileId, retired: prev && prev.file_id !== fileId ? prev.file_id : null });
      }
      // Contadores, reserva consumida una vez, revisión, evento y resultado en la misma transacción.
      const revision = (await client.query(`UPDATE catalog_libraries SET revision = revision + 1, active_count = active_count + $2, pending_count = pending_count - $3, updated_at = now() WHERE user_id = $1 RETURNING revision::text AS revision`,
        [uid, o.kind === 'IMPORT' ? 1 : 0, o.kind === 'IMPORT' ? 1 : 0])).rows[0].revision;
      if (o.kind === 'IMPORT') await client.query("UPDATE catalog_reservations SET state = 'CONSUMED', resolved_at = now() WHERE user_id = $1 AND operation_id = $2", [uid, operationId]);
      const seq = (await client.query('SELECT coalesce(max(event_seq), 0) + 1 AS seq FROM catalog_events WHERE user_id = $1', [uid])).rows[0].seq;
      await client.query('INSERT INTO catalog_events(user_id, event_seq, generation_id, revision, kind, beat_id, version, operation_id, payload_json) VALUES ($1,$2,$3,$4::bigint,$5,$6,$7::bigint,$8,$9)',
        [uid, seq, gen, revision, 'BEAT_PATCHED', o.beat_id, beatVersion, operationId, canonicalJson({ kind: o.kind, slots: installed.map((i) => i.slotKey) })]);
      if (o.kind === 'REPLACE' && tagsChanged) await refreshGroupsAndFacets(client, uid, gen, [o.beat_id], touchedKeys, revision);
      if (o.kind === 'IMPORT') {
        // grupos/facetas del beat nuevo (misma transacción)
        await client.query(`INSERT INTO catalog_beat_tag_groups(user_id, generation_id, beat_id, norm_key, projection_version, state, manual_rank, first_position, label_at_first_position)
          SELECT DISTINCT ON (t.norm_key) t.user_id, t.generation_id, t.beat_id, t.norm_key, t.projection_version, b.state, b.manual_rank, t.position, t.label FROM catalog_beat_tags t JOIN catalog_beats b USING (user_id, generation_id, beat_id)
          WHERE t.user_id = $1 AND t.generation_id = $2 AND t.beat_id = $3 ORDER BY t.norm_key, t.position`, [uid, gen, o.beat_id]);
        const keys = (await client.query('SELECT DISTINCT norm_key FROM catalog_beat_tags WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3', [uid, gen, o.beat_id])).rows.map((r) => r.norm_key);
        if (keys.length) {
          await client.query('DELETE FROM catalog_facets WHERE user_id = $1 AND generation_id = $2 AND norm_key = ANY($3::text[])', [uid, gen, keys]);
          await client.query(`WITH grp AS (SELECT * FROM catalog_beat_tag_groups WHERE user_id = $1 AND generation_id = $2 AND norm_key = ANY($3::text[]) AND state IN ('ACTIVE','TRASH')),
            cnt AS (SELECT state, norm_key, projection_version, count(*) AS n FROM grp GROUP BY 1, 2, 3),
            rep AS (SELECT DISTINCT ON (state, norm_key, projection_version) state, norm_key, projection_version, beat_id, first_position, label_at_first_position FROM grp ORDER BY state, norm_key, projection_version, manual_rank, beat_id COLLATE "C")
            INSERT INTO catalog_facets(user_id, generation_id, scope, norm_key, projection_version, beat_count, rep_beat_id, rep_position, rep_label, updated_revision)
            SELECT $1, $2, c.state, c.norm_key, c.projection_version, c.n, r.beat_id, r.first_position, r.label_at_first_position, $4::bigint FROM cnt c JOIN rep r USING (state, norm_key, projection_version)`, [uid, gen, keys, revision]);
        }
      }
      const result = { beatId: o.beat_id, version: beatVersion, revision, installed, eventSeq: String(seq) };
      await client.query("UPDATE catalog_transfer_operations SET status = 'COMMITTED', result_json = $3, completed_at = now() WHERE user_id = $1 AND operation_id = $2", [uid, operationId, canonicalJson(result)]);
      return { status: 200, operation: await opDto(client, uid, operationId, { replay: false }) };
    });
  }

  // ---------- POST /operations/:id/cancel ----------
  async function cancelOperation({ userId, era, epoch, operationId } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
      if (!o) throw notFound('operation');
      if (o.status === 'COMMITTED') throw new CatalogQueryError('OPERATION_TRANSITION_INVALID', 409, 'a committed operation cannot be cancelled', { status: o.status });
      if (['CANCELED', 'FAILED'].includes(o.status)) return opDto(client, uid, operationId, { changed: false });
      const sent = (await client.query("SELECT count(*)::int AS n FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND dispatch_state IN ('DISPATCHED', 'RECEIPT', 'VERIFIED')", [uid, operationId])).rows[0].n;
      if (sent > 0 && o.status !== 'RECONCILE') {
        // Pudo haber envío: RECONCILE con objetos retenidos; la reserva sigue HELD hasta resolver (nada se borra, C7).
        await client.query("UPDATE catalog_transfer_operations SET status = 'RECONCILE', last_error = 'CANCEL_AFTER_DISPATCH' WHERE user_id = $1 AND operation_id = $2", [uid, operationId]);
        // T10: reconciliación por parte con envío incierto (nunca reenvío automático).
        const uncertain = (await client.query("SELECT part_key FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND dispatch_state IN ('DISPATCHED', 'RECEIPT')", [uid, operationId])).rows;
        for (const p of uncertain) await client.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (job_id) DO NOTHING`, [partJobId('reconcile', operationId, p.part_key), uid, 'TRANSFER_RECONCILE', operationId, canonicalJson({ partKey: p.part_key })]);
        return opDto(client, uid, operationId, { changed: true });
      }
      if (sent > 0 && o.status === 'RECONCILE') return opDto(client, uid, operationId, { changed: false });
      await client.query("UPDATE catalog_transfer_operations SET status = 'CANCELED', completed_at = now() WHERE user_id = $1 AND operation_id = $2", [uid, operationId]);
      const r = await client.query("UPDATE catalog_reservations SET state = 'RELEASED', resolved_at = now() WHERE user_id = $1 AND operation_id = $2 AND state = 'HELD' RETURNING reservation_id", [uid, operationId]);
      if (r.rows.length) await client.query('UPDATE catalog_libraries SET pending_count = pending_count - 1, updated_at = now() WHERE user_id = $1', [uid]);
      await client.query("UPDATE catalog_file_versions SET status = 'RETIRED' WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 AND status = 'STAGED' AND file_id LIKE $4", [uid, o.generation_id, o.beat_id, `f-${operationId.slice(4, 12)}-%`]);
      return opDto(client, uid, operationId, { changed: true });
    });
  }

  // ---------- reservas: renovar (15 min, máximo 24 h) y readmitir tras vencimiento (re-comprueba cuota) ----------
  async function renewReservation({ userId, era, epoch, operationId } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const res = (await client.query('SELECT reservation_id, state, expires_at <= now() AS expired, max_until <= now() AS capped FROM catalog_reservations WHERE user_id = $1 AND operation_id = $2 FOR UPDATE', [uid, operationId])).rows[0];
      if (!res) throw notFound('reservation');
      if (res.state !== 'HELD') throw new CatalogQueryError('RESERVATION_INVALID', 409, `reservation is ${res.state}`, { state: res.state });
      if (res.capped) throw new CatalogQueryError('RESERVATION_EXPIRED', 409, 'reservation reached its 24 h maximum', { readmit: true });
      if (res.expired) throw new CatalogQueryError('RESERVATION_EXPIRED', 409, 'reservation expired; request readmission', { readmit: true });
      await client.query('UPDATE catalog_reservations SET expires_at = least(now() + make_interval(secs => $3), max_until), renewals = renewals + 1 WHERE user_id = $1 AND reservation_id = $2', [uid, res.reservation_id, RESERVATION_TTL_MS / 1000]);
      return opDto(client, uid, operationId, { renewed: true });
    });
  }
  async function readmitReservation({ userId, era, epoch, operationId } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const o = (await client.query(`${OP_SQL} FOR UPDATE OF o`, [uid, operationId])).rows[0];
      if (!o || o.kind !== 'IMPORT') throw notFound('operation');
      const res = (await client.query('SELECT reservation_id, state, expires_at <= now() AS expired FROM catalog_reservations WHERE user_id = $1 AND operation_id = $2 FOR UPDATE', [uid, operationId])).rows[0];
      if (!res) throw notFound('reservation');
      if (res.state === 'HELD' && !res.expired) return opDto(client, uid, operationId, { readmitted: false });
      if (res.state === 'HELD') {
        // La plaza vencida deja de contar; se vuelve a comprobar la cuota antes de volver a admitirla.
        await client.query("UPDATE catalog_reservations SET state = 'EXPIRED', resolved_at = now() WHERE user_id = $1 AND reservation_id = $2", [uid, res.reservation_id]);
        await client.query('UPDATE catalog_libraries SET pending_count = pending_count - 1, updated_at = now() WHERE user_id = $1', [uid]);
      }
      await assertQuota(client, uid, ctx);
      const reservationId = `res-${randomUUID()}`;
      await client.query('DELETE FROM catalog_reservations WHERE user_id = $1 AND operation_id = $2', [uid, operationId]);
      await client.query(`INSERT INTO catalog_reservations(user_id, reservation_id, operation_id, kind, state, expires_at, max_until) VALUES ($1, $2, $3, 'BEAT_SLOT', 'HELD', now() + make_interval(secs => $4), now() + make_interval(secs => $5))`, [uid, reservationId, operationId, RESERVATION_TTL_MS / 1000, RESERVATION_MAX_MS / 1000]);
      await client.query('UPDATE catalog_transfer_operations SET reservation_id = $3 WHERE user_id = $1 AND operation_id = $2', [uid, operationId, reservationId]);
      await client.query('UPDATE catalog_libraries SET pending_count = pending_count + 1, updated_at = now() WHERE user_id = $1', [uid]);
      return opDto(client, uid, operationId, { readmitted: true });
    });
  }
  // Vencimiento de reservas (paso de mantenimiento invocable; T10 lo programa): libera plazas vencidas sin tocar bytes ni operaciones.
  async function expireReservations({ userId, era, epoch, limit = 50 } = {}) {
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const r = await client.query(`UPDATE catalog_reservations SET state = 'EXPIRED', resolved_at = now() WHERE (user_id, reservation_id) IN (
          SELECT user_id, reservation_id FROM catalog_reservations WHERE user_id = $1 AND state = 'HELD' AND expires_at <= now() ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING reservation_id`, [uid, limit]);
      if (r.rows.length) await client.query('UPDATE catalog_libraries SET pending_count = pending_count - $2, updated_at = now() WHERE user_id = $1', [uid, r.rows.length]);
      return { expired: r.rows.length };
    });
  }
  async function getOperation({ userId, operationId } = {}) {
    if (typeof operationId !== 'string' || !ID_RE.test(operationId)) throw inputInvalid('OPERATION_ID');
    return readTx(userId, (client, uid) => opDto(client, uid, operationId));
  }

  // ---------- Jobs C8 (primitivas; el bucle es T10) ----------
  async function enqueueJob({ userId, kind, operationId = null, payload = {}, jobId = `job-${randomUUID()}` } = {}) {
    const uid = requireUserId(userId);
    if (!['TRANSFER_VERIFY', 'TRANSFER_COMMIT', 'TRANSFER_RECONCILE', 'QUERY_SET_BUILD', 'OPERATION_STEP', 'PURGE'].includes(kind)) throw inputInvalid('JOB_KIND');
    try {
      await pool.query('INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1,$2,$3,$4,$5)', [jobId, uid, kind, operationId, canonicalJson(payload)]);
      return { jobId };
    } catch (error) { throw sqlError(error); }
  }
  async function claimJobs({ owner, limit = JOB_CLAIM_MAX, leaseMs = JOB_LEASE_MS, kinds = null } = {}) {
    if (typeof owner !== 'string' || !owner) throw inputInvalid('OWNER');
    const n = Math.min(JOB_CLAIM_MAX, Math.max(1, limit));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const params = [n]; let kindSql = '';
        if (kinds) { params.push(kinds); kindSql = ' AND kind = ANY($2::text[])'; }
        // T12: paréntesis explícitos; sin ellos el filtro de tipos solo aplicaba a los leases vencidos y un claim por tipo reclamaba cualquier QUEUED.
        // T19-N: una corrida de restore sin reconciliar (HELD/BLOCKED) apaga el reclamo de jobs en toda la instancia (§11: workers apagados).
        const picked = (await client.query(`SELECT job_id FROM catalog_jobs WHERE ((state = 'QUEUED' AND next_attempt_at <= now()) OR (state = 'LEASED' AND lease_until <= now()))${kindSql}
          AND NOT EXISTS (SELECT 1 FROM catalog_restore_runs r WHERE r.status <> 'RECONCILED')
          ORDER BY next_attempt_at, created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, params)).rows.map((r) => r.job_id);
        const claimed = [];
        for (const jobId of picked) {
          const r = await client.query(`UPDATE catalog_jobs SET state = 'LEASED', lease_owner = $2, lease_generation = lease_generation + 1, lease_until = now() + make_interval(secs => $3), attempts = attempts + 1
            WHERE job_id = $1 RETURNING job_id, user_id, kind, operation_id, payload_json, lease_generation::text AS lease_generation, lease_until, attempts`, [jobId, owner, leaseMs / 1000]);
          const j = r.rows[0];
          claimed.push({ jobId: j.job_id, userId: j.user_id, kind: j.kind, operationId: j.operation_id, payload: JSON.parse(j.payload_json), lease: { owner, generation: j.lease_generation, until: j.lease_until }, attempts: j.attempts });
        }
        await client.query('COMMIT'); // COMMIT y release antes de ejecutar (C8)
        return claimed;
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    } catch (error) { throw sqlError(error); } finally { client.release(); }
  }
  // Renovación en transacción independiente; fencing por owner + generación.
  async function renewJobLease({ jobId, lease, leaseMs = JOB_LEASE_MS } = {}) {
    try {
      const r = await pool.query(`UPDATE catalog_jobs SET lease_until = now() + make_interval(secs => $4) WHERE job_id = $1 AND state = 'LEASED' AND lease_owner = $2 AND lease_generation = $3::bigint RETURNING lease_until`, [jobId, lease.owner, lease.generation, leaseMs / 1000]);
      if (!r.rows.length) throw new CatalogQueryError('LEASE_FENCED', 409, 'lease is no longer owned', { job_id: jobId });
      return { jobId, until: r.rows[0].lease_until };
    } catch (error) { throw sqlError(error); }
  }
  async function completeJob({ jobId, lease } = {}) {
    try {
      const r = await pool.query(`UPDATE catalog_jobs SET state = 'DONE', completed_at = now(), lease_owner = NULL, lease_until = NULL WHERE job_id = $1 AND state = 'LEASED' AND lease_owner = $2 AND lease_generation = $3::bigint RETURNING job_id`, [jobId, lease.owner, lease.generation]);
      if (!r.rows.length) throw new CatalogQueryError('LEASE_FENCED', 409, 'stale worker: completion ignored', { job_id: jobId });
      return { jobId, state: 'DONE' };
    } catch (error) { throw sqlError(error); }
  }
  // Fallo: transitorio → backoff exponencial con jitter (≤15 min; FLOOD_WAIT/Retry-After manda si es mayor); 8 transitorios → BLOCKED; permanente → BLOCKED inmediato.
  function backoffMs(attempts, retryAfterMs = 0, jitter = Math.random) {
    const base = Math.min(JOB_BACKOFF_MAX_MS, 1000 * 2 ** Math.min(attempts, 10));
    const withJitter = Math.round(base * (0.5 + jitter() * 0.5));
    return Math.max(withJitter, retryAfterMs);
  }
  async function failJob({ jobId, lease, error, transient = true, retryAfterMs = 0 } = {}) {
    try {
      const j = (await pool.query('SELECT attempts FROM catalog_jobs WHERE job_id = $1 AND state = \'LEASED\' AND lease_owner = $2 AND lease_generation = $3::bigint', [jobId, lease.owner, lease.generation])).rows[0];
      if (!j) throw new CatalogQueryError('LEASE_FENCED', 409, 'stale worker: failure ignored', { job_id: jobId });
      const blocked = !transient || j.attempts >= JOB_TRANSIENT_FAILURES_TO_BLOCK;
      const delay = backoffMs(j.attempts, retryAfterMs);
      const r = await pool.query(`UPDATE catalog_jobs SET state = $2, lease_owner = NULL, lease_until = NULL, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE job_id = $1 RETURNING state, next_attempt_at`,
        [jobId, blocked ? 'BLOCKED' : 'QUEUED', String(error ?? '').slice(0, 1000), delay / 1000]);
      return { jobId, state: r.rows[0].state, nextAttemptAt: r.rows[0].next_attempt_at, delayMs: delay };
    } catch (error) { throw sqlError(error); }
  }

  return Object.freeze({
    createOperation, markDispatched, assignSender, putReceipt, recordVerification, commitOperation, cancelOperation, renewReservation, readmitReservation, expireReservations, getOperation,
    enqueueJob, claimJobs, renewJobLease, completeJob, failJob, backoffMs,
    limits: Object.freeze({ RESERVATION_TTL_MS, RESERVATION_MAX_MS, JOB_LEASE_MS, JOB_CLAIM_MAX, JOB_BACKOFF_MAX_MS, JOB_TRANSIENT_FAILURES_TO_BLOCK, PARTS_MAX }),
  });
}

let configured = null;
function configureCatalogOperations(options = null) { configured = options && options.pool && options.authority && options.resolveAccess ? createCatalogOperations(options) : null; return configured; }
function currentCatalogOperations() { return configured; }

module.exports = { RESERVATION_TTL_MS, RESERVATION_MAX_MS, JOB_LEASE_MS, JOB_CLAIM_MAX, JOB_BACKOFF_MAX_MS, JOB_TRANSIENT_FAILURES_TO_BLOCK, PARTS_MAX, randomInt64String, int64, validateIntent, validateParts, nativeBeatDocument, createCatalogOperations, configureCatalogOperations, currentCatalogOperations };
