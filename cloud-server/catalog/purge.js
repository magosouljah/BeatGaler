'use strict';
// T15 — Purge durable, retención y limpieza segura (CONTRATO C9; TAREAS §T15; MATRIZ-T §T15; NATIVO r2.1 §6.1/§7).
//  - Intención (requestPurge): bajo el lock de la biblioteca captura la revisión y el límite de papelera (export_position máximo): los beats
//    enviados a la papelera DESPUÉS quedan fuera. Una sola purga activa por biblioteca. Responde 202 con la operación durable.
//  - Enumeración por lotes (worker): cada beat TRASH del alcance pasa a PURGING (ocupa cuota; restore y REPLACE lo rechazan) y se enumeran
//    TODAS sus referencias físicas (el tombstone CATALOG se escribe al PURGED: 0026 lo prohíbe mientras el beat está vivo): versiones actuales, anteriores retenidas, STAGED/REVIEW, partes y
//    recibos de operaciones no confirmadas (objetos sin vincular). OPAQUE → item BLOCKED; objeto compartido con otro beat vivo/retenido →
//    BLOCKED (no se copia ni se borra la referencia ajena); retención vigente, `restore_hold`, `cleanup_enabled=false` u operación pendiente
//    → BLOCKED con motivo explícito. Nunca se libera cuota por un item bloqueado.
//  - Eliminación por objeto, en tres pasos y SIN cliente SQL durante las llamadas externas: (1) tx corta: revalidar referencias bajo lock de
//    biblioteca y luego del objeto, pasar a DELETING con deletion_generation (ninguna referencia nueva puede adoptarlo); (2) journal externo:
//    append + verify de persistencia — si falla, NO hay delete; (3) remoto: deleteMessage y luego probeAbsence por lector autorizado:
//    solo MessageEmpty en el peer correcto demuestra ausencia; 403/404 sin entrada/timeout → UNCERTAIN con reintento acotado; (4) tx corta:
//    DELETED condicionado a la generación. Un purge parcial conserva lo confirmado y lo pendiente.
//  - PURGED del beat solo con todos sus objetos DELETED: beat PURGING → PURGED, versiones DELETED, tombstone con deleted_at, `purging_count−1`
//    una sola vez, evento. El purge termina PURGED (todo), PARTIAL (algún BLOCKED/UNCERTAIN) o BLOCKED.
//  - `releaseRestoreHold`: solo con el journal externo reconciliado (todas sus entradas corresponden a objetos DELETED en SQL o inexistentes)
//    y `cleanup_enabled` aprobado. Cleanup real: apagado (T24); aquí solo fakes.
// Solo SQL + crypto. Gateway (T11) y journal se inyectan.

const crypto = require('crypto');
const { requireUserId } = require('./contract');
const { canonicalJson, CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');
const { STATEMENT_TIMEOUT_MS } = require('./queries');

const ENUMERATE_BATCH = 50;
const OBJECT_MAX_ATTEMPTS = 8;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const BLOCK_REASONS = Object.freeze(['OPAQUE_REFERENCE', 'SHARED_OBJECT', 'RETENTION_WINDOW', 'RESTORE_HOLD', 'CLEANUP_DISABLED', 'PENDING_OPERATION', 'JOURNAL_UNAVAILABLE', 'PROVIDER_UNCERTAIN', 'BEAT_STATE']);

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const notFound = (what) => new CatalogQueryError('NOT_FOUND', 404, `${what} is not accessible`, {});
const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sqlError = (error) => {
  if (error instanceof CatalogAuthorityError || error instanceof CatalogQueryError) return error;
  if (error?.code === '57014') return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog statement timed out', { sqlstate: '57014' });
  if (['BGL01', 'BGN04', 'BGA05', 'BGC02'].includes(error?.code)) return new CatalogQueryError('CATALOG_NATIVE_RULE', 409, 'database native rule rejected the mutation', { sqlstate: error.code, detail: error.detail || null });
  return new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog is unavailable (SQL_ERROR)', { reason: 'SQL_ERROR', sqlstate: error?.code || null, sql_message: error?.code ? String(error.message).slice(0, 200) : null });
};
class PurgeStepError extends Error {
  constructor(code, message, { transient = true, retryAfterMs = 0, reason = null } = {}) { super(message); this.name = 'PurgeStepError'; this.code = code; this.transient = transient; this.retryAfterMs = retryAfterMs; this.reason = reason; }
}

// Evaluación pura de bloqueo de un objeto (también la usa la prueba unitaria): referencias ajenas, retención, hold, flag, operaciones.
function evaluateObjectBlock({ otherLiveRefs = 0, retainedUntilFuture = false, restoreHold = false, cleanupEnabled = true, pendingOperations = 0, opaque = false } = {}) {
  if (opaque) return 'OPAQUE_REFERENCE';
  if (otherLiveRefs > 0) return 'SHARED_OBJECT';
  if (retainedUntilFuture) return 'RETENTION_WINDOW';
  if (pendingOperations > 0) return 'PENDING_OPERATION';
  if (restoreHold) return 'RESTORE_HOLD';
  if (!cleanupEnabled) return 'CLEANUP_DISABLED';
  return null;
}
// Clasificación de errores del proveedor en la fase destructiva: nada aquí prueba ausencia (C9).
function classifyProviderError(error) {
  const c = error && error.classification;
  if (error && error.code === 'CREDENTIAL_REVOKED') return { outcome: 'UNCERTAIN', transient: false, reason: 'REVOKED' };
  if (c && c.kind === 'PERMANENT') return { outcome: 'UNCERTAIN', transient: false, reason: c.code || 'PERMANENT' };
  return { outcome: 'UNCERTAIN', transient: true, reason: (c && c.code) || (error && error.code) || 'PROVIDER' };
}

function createCatalogPurge({ pool = null, authority = null, gateway = null, journal = null, randomUUID = () => crypto.randomUUID(), log = () => {} } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createCatalogPurge requires a pool');
  if (!authority || typeof authority.requireLibraryForMutation !== 'function') throw new Error('createCatalogPurge requires the catalog authority');
  const metrics = { requested: 0, itemsEnumerated: 0, objectsDeleted: 0, objectsBlocked: 0, objectsUncertain: 0, journalFailures: 0, purged: 0 };

  async function mutationTx(userId, { era, epoch }, fn, { allowFrozen = false } = {}) {
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
        if (!allowFrozen && ctx.migration_state !== 'IDLE') throw new CatalogQueryError('LIBRARY_FROZEN', 409, 'library is not accepting mutations', { migration_state: ctx.migration_state });
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
  const libFlags = async (client, uid) => (await client.query('SELECT restore_hold, cleanup_enabled, purging_count::text AS purging FROM catalog_libraries WHERE user_id = $1', [uid])).rows[0];
  // Los pasos del worker no traen cabeceras C5: la era/época vigentes se leen en una consulta corta (igual que worker.libraryHeaders).
  async function libraryHeaders(userId) {
    const uid = requireUserId(userId);
    const r = await pool.query('SELECT authority_era::text AS era, authority_epoch::text AS epoch FROM catalog_libraries WHERE user_id = $1', [uid]).catch((e) => { throw sqlError(e); });
    if (!r.rows.length) throw notFound('library');
    return { era: r.rows[0].era, epoch: r.rows[0].epoch };
  }
  const PURGE_SQL = `SELECT purge_id, generation_id, authority_epoch::text AS authority_epoch, base_revision::text AS base_revision, scope, limit_position, status, enumeration_cursor, total_items, purged_items, blocked_items, last_error, created_at, updated_at, completed_at
    FROM catalog_purges WHERE user_id = $1 AND purge_id = $2`;
  async function purgeDto(client, uid, purgeId, extra = {}) {
    const p = (await client.query(PURGE_SQL, [uid, purgeId])).rows[0]; if (!p) throw notFound('purge');
    const items = (await client.query('SELECT beat_id, status, block_reason, objects_total, objects_deleted FROM catalog_purge_items WHERE user_id = $1 AND purge_id = $2 ORDER BY beat_id COLLATE "C" LIMIT 240', [uid, purgeId])).rows;
    const objects = (await client.query('SELECT status, count(*)::int AS n FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 GROUP BY status', [uid, purgeId])).rows;
    return { operationId: p.purge_id, purgeId: p.purge_id, kind: 'PURGE', status: p.status, scope: p.scope, baseRevision: p.base_revision, epoch: p.authority_epoch, progress: { total: p.total_items, purged: p.purged_items, blocked: p.blocked_items, pending: Math.max(0, p.total_items - p.purged_items - p.blocked_items), objects: Object.fromEntries(objects.map((o) => [o.status, o.n])) },
      items: items.map((i) => ({ beatId: i.beat_id, status: i.status, blockReason: i.block_reason, objectsTotal: i.objects_total, objectsDeleted: i.objects_deleted })), lastError: p.last_error, createdAt: p.created_at, updatedAt: p.updated_at, completedAt: p.completed_at, durable: true, ...extra };
  }

  // ---------- POST /operations {kind: PURGE, scope: ALL_TRASH | {beatIds}} → 202 ----------
  async function requestPurge({ userId, era, epoch, idempotencyKey, scope = 'ALL_TRASH', beatIds = null } = {}) {
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) throw inputInvalid('IDEMPOTENCY_KEY');
    const kind = scope === 'ITEMS' || Array.isArray(beatIds) ? 'ITEMS' : scope === 'ALL_TRASH' ? 'ALL_TRASH' : null;
    if (!kind) throw inputInvalid('PURGE_SCOPE');
    const ids = kind === 'ITEMS' ? [...new Set((beatIds || []).map(String))] : [];
    if (kind === 'ITEMS' && (ids.length === 0 || ids.length > 240)) throw inputInvalid('PURGE_ITEMS', { max: 240 });
    const hash = sha256Hex(canonicalJson({ kind, ids }));
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const replay = (await client.query('SELECT purge_id, request_hash FROM catalog_purges WHERE user_id = $1 AND idempotency_key = $2', [uid, idempotencyKey])).rows[0];
      if (replay) { if (replay.request_hash !== hash) throw new CatalogQueryError('IDEMPOTENCY_MISMATCH', 409, 'idempotency key was used with a different request', { operation_id: replay.purge_id }); return purgeDto(client, uid, replay.purge_id, { replay: true, created: false }); }
      const live = (await client.query("SELECT purge_id FROM catalog_purges WHERE user_id = $1 AND status IN ('ENUMERATING', 'DELETING')", [uid])).rows[0];
      if (live) throw new CatalogQueryError('PURGE_IN_PROGRESS', 409, 'another purge is already in progress for this library', { operation_id: live.purge_id });
      const gen = ctx.generation_id;
      // límite de papelera capturado en la revisión actual: lo enviado a la papelera después queda fuera (TAREAS §T15.1)
      const limit = (await client.query("SELECT coalesce(max(export_position), -1)::int AS p FROM catalog_trash_entries WHERE user_id = $1 AND generation_id = $2 AND beat_state = 'TRASH'", [uid, gen])).rows[0].p;
      if (kind === 'ITEMS') {
        const rows = (await client.query("SELECT beat_id, state FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = ANY($3::text[])", [uid, gen, ids])).rows;
        const byId = new Map(rows.map((r) => [r.beat_id, r.state]));
        const bad = ids.filter((id) => byId.get(id) !== 'TRASH');
        if (bad.length) throw new CatalogQueryError('BEAT_NOT_IN_TRASH', 409, 'only beats in TRASH can be purged', { beat_ids: bad.slice(0, 20) });
      }
      const purgeId = `op-purge-${randomUUID()}`;
      await client.query(`INSERT INTO catalog_purges(user_id, purge_id, generation_id, authority_epoch, base_revision, scope, limit_position, idempotency_key, request_hash, status, enumeration_cursor, total_items)
        VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6, $7, $8, $9, 'ENUMERATING', -1, $10)`, [uid, purgeId, gen, ctx.authority_epoch, ctx.revision, kind, kind === 'ALL_TRASH' && limit >= 0 ? limit : null, idempotencyKey, hash, kind === 'ITEMS' ? ids.length : 0]); // papelera vacía → limit NULL (ningún item entra)
      if (kind === 'ITEMS') for (const id of ids) await client.query("INSERT INTO catalog_purge_items(user_id, purge_id, beat_id, status) VALUES ($1, $2, $3, 'PENDING')", [uid, purgeId, id]);
      // el worker (C8) recorre la papelera en lotes y procesa objetos; el job nace en la misma transacción que la intención
      await client.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, 'PURGE', $3, $4) ON CONFLICT (job_id) DO NOTHING`, [`job-purge-${purgeId}`.slice(0, 64), uid, purgeId, canonicalJson({ purgeId })]);
      metrics.requested++;
      return purgeDto(client, uid, purgeId, { replay: false, created: true, status: 'ENUMERATING' });
    });
  }

  // ---------- paso 1 (worker): enumeración de items por lotes ≤50 → PURGING + tombstone en preparación ----------
  async function enumerateStep({ userId, purgeId, batch = ENUMERATE_BATCH } = {}) {
    const h = await libraryHeaders(userId);
    return mutationTx(userId, h, async (client, ctx, uid) => {
      const p = (await client.query(`${PURGE_SQL} FOR UPDATE`, [uid, purgeId])).rows[0]; if (!p) throw notFound('purge');
      if (p.status !== 'ENUMERATING') return { purgeId, status: p.status, enumerated: 0, done: true };
      if (p.generation_id !== ctx.generation_id || p.authority_epoch !== ctx.authority_epoch) { await client.query("UPDATE catalog_purges SET status = 'BLOCKED', last_error = 'EPOCH_CHANGED', completed_at = now(), updated_at = now() WHERE user_id = $1 AND purge_id = $2", [uid, purgeId]); return { purgeId, status: 'BLOCKED', enumerated: 0, done: true }; }
      const gen = p.generation_id; const n = Math.min(ENUMERATE_BATCH, Math.max(1, batch));
      let rows;
      if (p.scope === 'ALL_TRASH') {
        rows = (await client.query(`SELECT t.beat_id, t.export_position FROM catalog_trash_entries t WHERE t.user_id = $1 AND t.generation_id = $2 AND t.beat_state = 'TRASH' AND t.export_position > $3 AND t.export_position <= $4 ORDER BY t.export_position LIMIT $5`, [uid, gen, p.enumeration_cursor, p.limit_position, n])).rows;
        for (const r of rows) await client.query("INSERT INTO catalog_purge_items(user_id, purge_id, beat_id, status) VALUES ($1, $2, $3, 'PENDING') ON CONFLICT DO NOTHING", [uid, purgeId, r.beat_id]);
      } else {
        rows = (await client.query("SELECT i.beat_id, 0 AS export_position FROM catalog_purge_items i WHERE i.user_id = $1 AND i.purge_id = $2 AND i.status = 'PENDING' ORDER BY i.beat_id COLLATE \"C\" LIMIT $3", [uid, purgeId, n])).rows;
      }
      let enumerated = 0;
      for (const r of rows) {
        const b = (await client.query('SELECT state, version::text AS version FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 FOR UPDATE', [uid, gen, r.beat_id])).rows[0];
        if (!b || b.state !== 'TRASH') { await client.query("UPDATE catalog_purge_items SET status = 'BLOCKED', block_reason = 'BEAT_STATE' WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, r.beat_id]); continue; }
        // TRASH → PURGING (ocupa cuota; restore/REPLACE lo rechazan); el wrapper de papelera sigue al estado por la FK ON UPDATE CASCADE
        await client.query("UPDATE catalog_beats SET state = 'PURGING', version = version + 1, updated_at = now() WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3", [uid, gen, r.beat_id]);
        await client.query('UPDATE catalog_libraries SET trash_count = trash_count - 1, purging_count = purging_count + 1, updated_at = now() WHERE user_id = $1', [uid]);
        // manifiesto de objetos: versiones (todas: actuales, retenidas, STAGED, REVIEW) → partes → ubicaciones PRIMARY; recibos no confirmados → objetos sin vincular
        const locs = (await client.query(`SELECT l.object_id, l.reference_class, l.file_id, l.part_index, o.chat_id, o.message_id::text AS message_id, o.status AS object_status
            FROM catalog_file_versions fv JOIN catalog_file_parts fp ON fp.user_id = fv.user_id AND fp.generation_id = fv.generation_id AND fp.file_id = fv.file_id
            JOIN catalog_part_locations l ON l.user_id = fp.user_id AND l.generation_id = fp.generation_id AND l.file_id = fp.file_id AND l.part_index = fp.part_index AND l.location = 'PRIMARY'
            LEFT JOIN catalog_media_objects o ON o.user_id = l.user_id AND o.object_id = l.object_id
            WHERE fv.user_id = $1 AND fv.generation_id = $2 AND fv.beat_id = $3 AND fv.status <> 'DELETED'`, [uid, gen, r.beat_id])).rows;
        const receipts = (await client.query(`SELECT p.chat_id, p.provider_message_id::text AS message_id, p.provider_document_id, p.receipt_json FROM catalog_operation_parts p JOIN catalog_transfer_operations o ON o.user_id = p.user_id AND o.operation_id = p.operation_id
            WHERE p.user_id = $1 AND o.beat_id = $2 AND o.status <> 'COMMITTED' AND p.provider_message_id IS NOT NULL`, [uid, r.beat_id])).rows;
        let opaque = false; const objects = new Map();
        for (const l of locs) { if (l.reference_class !== 'KNOWN' || !l.object_id) { opaque = true; continue; } objects.set(l.object_id, { objectId: l.object_id, fileId: l.file_id, partIndex: l.part_index, chatId: l.chat_id, messageId: l.message_id }); }
        for (const rc of receipts) {
          // objeto sin vincular (recibo de una operación no confirmada, p. ej. REPLACE en CONFLICT): su identidad física se registra antes de
          // poder borrarlo (el journal y la confirmación necesitan una fila de catalog_media_objects); nunca se borra por intuición.
          const oid = `tg:${rc.chat_id}:${rc.message_id}`;
          const exists = (await client.query('SELECT 1 FROM catalog_media_objects WHERE user_id = $1 AND object_id = $2', [uid, oid])).rows.length;
          if (!exists) { const sender = (() => { try { const j = JSON.parse(rc.receipt_json || '{}'); return j && j.senderId != null && /^-?[0-9]{1,20}$/.test(String(j.senderId)) ? String(j.senderId) : null; } catch { return null; } })(); await client.query(`INSERT INTO catalog_media_objects(user_id, object_id, provider, chat_id, message_id, document_id, sender_id, verified_at, status) VALUES ($1, $2, 'telegram', $3, $4::bigint, $5, $6, now(), 'PRESENT') ON CONFLICT DO NOTHING`, [uid, oid, rc.chat_id, rc.message_id, rc.provider_document_id, sender]); }
          if (!objects.has(oid)) objects.set(oid, { objectId: oid, fileId: null, partIndex: null, chatId: rc.chat_id, messageId: rc.message_id });
        }
        if (opaque) { await client.query("UPDATE catalog_purge_items SET status = 'BLOCKED', block_reason = 'OPAQUE_REFERENCE', enumerated_at = now(), objects_total = $4 WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, r.beat_id, objects.size]); metrics.objectsBlocked++; continue; }
        for (const o of objects.values()) await client.query(`INSERT INTO catalog_purge_objects(user_id, purge_id, object_id, beat_id, file_id, part_index, chat_id, message_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, 'PENDING') ON CONFLICT DO NOTHING`, [uid, purgeId, o.objectId, r.beat_id, o.fileId, o.partIndex, o.chatId, o.messageId]);
        await client.query("UPDATE catalog_purge_items SET status = 'ENUMERATED', enumerated_at = now(), objects_total = $4 WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, r.beat_id, objects.size]);
        enumerated++; metrics.itemsEnumerated++;
      }
      const cursor = p.scope === 'ALL_TRASH' && rows.length ? Number(rows[rows.length - 1].export_position) : p.enumeration_cursor;
      const done = rows.length < n;
      const total = (await client.query('SELECT count(*)::int AS n FROM catalog_purge_items WHERE user_id = $1 AND purge_id = $2', [uid, purgeId])).rows[0].n;
      await client.query("UPDATE catalog_purges SET enumeration_cursor = $3, total_items = $4, status = $5, updated_at = now() WHERE user_id = $1 AND purge_id = $2", [uid, purgeId, cursor, total, done ? 'DELETING' : 'ENUMERATING']);
      if (done && total === 0) await client.query("UPDATE catalog_purges SET status = 'PURGED', completed_at = now(), updated_at = now() WHERE user_id = $1 AND purge_id = $2", [uid, purgeId]);
      return { purgeId, status: done ? (total === 0 ? 'PURGED' : 'DELETING') : 'ENUMERATING', enumerated, done };
    }, { allowFrozen: true });
  }

  // ---------- paso 2 (worker): un objeto → (tx) DELETING → journal → remoto delete+probe → (tx) DELETED; luego cierre de item/purge ----------
  async function nextObject(client, uid, purgeId) {
    return (await client.query(`SELECT po.object_id, po.beat_id, po.file_id, po.part_index, po.chat_id, po.message_id::text AS message_id, po.status, po.journal_ref, po.journal_sha256, po.attempts
        FROM catalog_purge_objects po WHERE po.user_id = $1 AND po.purge_id = $2 AND po.status IN ('PENDING', 'JOURNALED', 'DELETING', 'UNCERTAIN') ORDER BY po.beat_id COLLATE "C", po.object_id COLLATE "C" LIMIT 1 FOR UPDATE SKIP LOCKED`, [uid, purgeId])).rows[0] || null;
  }
  // Bloqueos (bajo lock de biblioteca y luego objeto): referencias vivas de otros beats, retención vigente, hold, flag, operaciones pendientes.
  async function blockReasonFor(client, uid, gen, po, flags) {
    const others = (await client.query(`SELECT count(*)::int AS n FROM catalog_part_locations l JOIN catalog_file_versions fv ON fv.user_id = l.user_id AND fv.generation_id = l.generation_id AND fv.file_id = l.file_id
        WHERE l.user_id = $1 AND l.object_id = $2 AND fv.beat_id <> $3 AND fv.status NOT IN ('DELETED', 'RETIRED')`, [uid, po.object_id, po.beat_id])).rows[0].n;
    const retained = (await client.query(`SELECT count(*)::int AS n FROM catalog_part_locations l JOIN catalog_file_versions fv ON fv.user_id = l.user_id AND fv.generation_id = l.generation_id AND fv.file_id = l.file_id
        WHERE l.user_id = $1 AND l.object_id = $2 AND fv.beat_id <> $3 AND fv.status = 'RETIRED' AND fv.retained_until IS NOT NULL AND fv.retained_until > now()`, [uid, po.object_id, po.beat_id])).rows[0].n;
    const pending = (await client.query(`SELECT count(*)::int AS n FROM catalog_transfer_operations o WHERE o.user_id = $1 AND o.beat_id = $2 AND o.status IN ('PREPARED', 'TRANSFERRING', 'VERIFYING', 'READY', 'RECONCILE')`, [uid, po.beat_id])).rows[0].n;
    const otherGenRefs = (await client.query(`SELECT count(*)::int AS n FROM catalog_part_locations l JOIN catalog_generations g ON g.user_id = l.user_id AND g.generation_id = l.generation_id
        WHERE l.user_id = $1 AND l.object_id = $2 AND l.generation_id <> $3 AND g.status = 'RETIRED'`, [uid, po.object_id, gen])).rows[0].n; // generaciones RETIRED protegidas hasta su retención (0027)
    return evaluateObjectBlock({ otherLiveRefs: others + otherGenRefs, retainedUntilFuture: retained > 0, restoreHold: flags.restore_hold, cleanupEnabled: flags.cleanup_enabled, pendingOperations: pending });
  }
  async function markObject(uid, purgeId, objectId, patch) {
    const sets = []; const params = [uid, purgeId, objectId];
    for (const [k, v] of Object.entries(patch)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    await pool.query(`UPDATE catalog_purge_objects SET ${sets.join(', ')} WHERE user_id = $1 AND purge_id = $2 AND object_id = $3`, params).catch((e) => { throw sqlError(e); });
  }
  async function closeItemsAndPurge(client, uid, purgeId) {
    // items cuyos objetos están todos DELETED → PURGED (cuota liberada UNA vez); items con algún BLOCKED → BLOCKED
    const items = (await client.query("SELECT i.beat_id, i.status FROM catalog_purge_items i WHERE i.user_id = $1 AND i.purge_id = $2 AND i.status IN ('ENUMERATED', 'DELETING') FOR UPDATE", [uid, purgeId])).rows;
    const p = (await client.query(PURGE_SQL, [uid, purgeId])).rows[0];
    for (const it of items) {
      const counts = (await client.query("SELECT count(*) FILTER (WHERE status = 'DELETED')::int AS deleted, count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked, count(*)::int AS total FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, it.beat_id])).rows[0];
      if (counts.blocked > 0) { const reason = (await client.query("SELECT block_reason FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3 AND status = 'BLOCKED' LIMIT 1", [uid, purgeId, it.beat_id])).rows[0].block_reason; await client.query("UPDATE catalog_purge_items SET status = 'BLOCKED', block_reason = $4, objects_deleted = $5 WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, it.beat_id, BLOCK_REASONS.includes(reason) ? reason : 'PROVIDER_UNCERTAIN', counts.deleted]); continue; }
      if (counts.deleted === counts.total) {
        const b = (await client.query("SELECT state FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 FOR UPDATE", [uid, p.generation_id, it.beat_id])).rows[0];
        if (b && b.state === 'PURGING') {
          await client.query("UPDATE catalog_beats SET state = 'PURGED', version = version + 1, updated_at = now() WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3", [uid, p.generation_id, it.beat_id]);
          await client.query("UPDATE catalog_file_versions SET status = 'DELETED' WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 AND status <> 'DELETED'", [uid, p.generation_id, it.beat_id]);
          // tombstone CATALOG (R11: compatible con el exportador) en la misma transacción que el PURGED; 0026 lo prohíbe mientras el beat está vivo
          await client.query(`INSERT INTO catalog_tombstones(user_id, generation_id, beat_id, source, deleted_at, assets_known) VALUES ($1, $2, $3, 'CATALOG', now(), true) ON CONFLICT (user_id, generation_id, beat_id) DO UPDATE SET deleted_at = coalesce(catalog_tombstones.deleted_at, now())`, [uid, p.generation_id, it.beat_id]);
          const revision = (await client.query('UPDATE catalog_libraries SET revision = revision + 1, purging_count = purging_count - 1, updated_at = now() WHERE user_id = $1 RETURNING revision::text AS revision', [uid])).rows[0].revision;
          const seq = (await client.query('SELECT coalesce(max(event_seq), 0) + 1 AS seq FROM catalog_events WHERE user_id = $1', [uid])).rows[0].seq;
          // 0029 no define BEAT_PURGED: evento OPERATION_STATUS con payload explícito (kind PURGE, status PURGED)
          await client.query('INSERT INTO catalog_events(user_id, event_seq, generation_id, revision, kind, beat_id, version, operation_id, payload_json) VALUES ($1,$2,$3,$4::bigint,$5,$6,NULL,$7,$8)', [uid, seq, p.generation_id, revision, 'OPERATION_STATUS', it.beat_id, purgeId, canonicalJson({ kind: 'PURGE', status: 'PURGED', beatId: it.beat_id, objects: counts.total })]);
          metrics.purged++;
        }
        await client.query("UPDATE catalog_purge_items SET status = 'PURGED', purged_at = now(), objects_deleted = $4 WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, it.beat_id, counts.deleted]);
      } else await client.query("UPDATE catalog_purge_items SET status = 'DELETING', objects_deleted = $4 WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, it.beat_id, counts.deleted]);
    }
    const agg = (await client.query("SELECT count(*) FILTER (WHERE status = 'PURGED')::int AS purged, count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked, count(*) FILTER (WHERE status IN ('PENDING', 'ENUMERATED', 'DELETING'))::int AS open, count(*)::int AS total FROM catalog_purge_items WHERE user_id = $1 AND purge_id = $2", [uid, purgeId])).rows[0];
    const uncertain = (await client.query("SELECT count(*)::int AS n FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 AND status = 'UNCERTAIN'", [uid, purgeId])).rows[0].n;
    let status = 'DELETING';
    if (agg.open === 0 && uncertain === 0) status = agg.blocked === 0 ? 'PURGED' : agg.purged === 0 ? 'BLOCKED' : 'PARTIAL';
    await client.query("UPDATE catalog_purges SET purged_items = $3, blocked_items = $4, status = $5, completed_at = CASE WHEN $5 IN ('PURGED', 'PARTIAL', 'BLOCKED') THEN now() ELSE NULL END, updated_at = now() WHERE user_id = $1 AND purge_id = $2", [uid, purgeId, agg.purged, agg.blocked, status]);
    return { status, purged: agg.purged, blocked: agg.blocked, open: agg.open, uncertain };
  }
  async function deleteStep({ userId, purgeId } = {}) {
    if (!gateway || typeof gateway.deleteMessage !== 'function' || typeof gateway.probeAbsence !== 'function') throw new PurgeStepError('TRANSPORT_UNAVAILABLE', 'no deletion gateway configured', { transient: true, retryAfterMs: 30_000 });
    if (!journal || typeof journal.append !== 'function' || typeof journal.verify !== 'function') throw new PurgeStepError('JOURNAL_UNAVAILABLE', 'no deletion journal configured', { transient: true, retryAfterMs: 30_000 });
    // (1) tx corta: siguiente objeto; revalidar bloqueos bajo lock de biblioteca (ya tomado por requireLibraryForMutation) y luego objeto → DELETING
    const h = await libraryHeaders(userId);
    const picked = await mutationTx(userId, h, async (client, ctx, uid) => {
      const p = (await client.query(`${PURGE_SQL} FOR UPDATE`, [uid, purgeId])).rows[0]; if (!p) throw notFound('purge');
      if (p.status !== 'DELETING') return { none: true, status: p.status };
      const po = await nextObject(client, uid, purgeId);
      if (!po) { const closed = await closeItemsAndPurge(client, uid, purgeId); return { none: true, status: closed.status, closed }; }
      if (po.attempts >= OBJECT_MAX_ATTEMPTS) { await client.query("UPDATE catalog_purge_objects SET status = 'BLOCKED', block_reason = 'PROVIDER_UNCERTAIN' WHERE user_id = $1 AND purge_id = $2 AND object_id = $3", [uid, purgeId, po.object_id]); metrics.objectsBlocked++; return { none: false, blocked: true, objectId: po.object_id }; }
      const flags = await libFlags(client, uid);
      const reason = await blockReasonFor(client, uid, p.generation_id, po, flags);
      if (reason) { await client.query("UPDATE catalog_purge_objects SET status = 'BLOCKED', block_reason = $4 WHERE user_id = $1 AND purge_id = $2 AND object_id = $3", [uid, purgeId, po.object_id, reason]); metrics.objectsBlocked++; return { none: false, blocked: true, reason, objectId: po.object_id }; }
      const obj = (await client.query('SELECT status FROM catalog_media_objects WHERE user_id = $1 AND object_id = $2 FOR UPDATE', [uid, po.object_id])).rows[0];
      if (!obj) { await client.query("UPDATE catalog_purge_objects SET status = 'DELETED', deleted_at = now(), journal_ref = coalesce(journal_ref, 'absent'), last_error = 'OBJECT_ROW_MISSING' WHERE user_id = $1 AND purge_id = $2 AND object_id = $3", [uid, purgeId, po.object_id]); return { none: false, skipped: true }; }
      if (obj.status === 'DELETED') { await client.query("UPDATE catalog_purge_objects SET status = 'DELETED', deleted_at = coalesce(deleted_at, now()), journal_ref = coalesce(journal_ref, 'prior') WHERE user_id = $1 AND purge_id = $2 AND object_id = $3", [uid, purgeId, po.object_id]); return { none: false, skipped: true }; }
      if (obj.status !== 'DELETING') await client.query("UPDATE catalog_media_objects SET status = 'DELETING', deletion_generation = $3 WHERE user_id = $1 AND object_id = $2", [uid, po.object_id, p.generation_id]);
      await client.query('UPDATE catalog_purge_objects SET attempts = attempts + 1 WHERE user_id = $1 AND purge_id = $2 AND object_id = $3', [uid, purgeId, po.object_id]);
      return { none: false, po: { ...po, generation: p.generation_id }, uid };
    }, { allowFrozen: true });
    if (picked.none || picked.blocked || picked.skipped) return { purgeId, ...picked };
    const { po, uid } = picked;
    // (2) journal externo: append + verify ANTES del delete. Sin persistencia demostrada no hay delete.
    let journalRef = po.journal_ref; let journalSha = po.journal_sha256;
    if (!journalRef) {
      try {
        const entry = { userId: uid, purgeId, objectId: po.object_id, beatId: po.beat_id, fileId: po.file_id, partIndex: po.part_index, chatId: po.chat_id, messageId: Number(po.message_id), generation: po.generation, kind: 'DELETE_INTENT' };
        const j = await journal.append(entry);
        const ok = j && j.ref && j.sha256 && await journal.verify(j.ref, j.sha256);
        if (!ok) throw Object.assign(new Error('journal persistence could not be verified'), { code: 'JOURNAL_UNVERIFIED', transient: true });
        journalRef = j.ref; journalSha = j.sha256;
        await markObject(uid, purgeId, po.object_id, { journal_ref: journalRef, journal_sha256: journalSha, status: 'JOURNALED' });
      } catch (error) {
        metrics.journalFailures++;
        await markObject(uid, purgeId, po.object_id, { last_error: `JOURNAL: ${String(error?.code || error?.message || error).slice(0, 200)}` }).catch(() => {});
        // sin journal no hay delete: el objeto sigue DELETING (sin nuevas referencias) y el job reintenta
        throw new PurgeStepError('JOURNAL_UNAVAILABLE', 'deletion journal unavailable: no delete performed', { transient: true, retryAfterMs: 30_000, reason: 'JOURNAL_UNAVAILABLE' });
      }
    }
    // (3) remoto: borrar y comprobar ausencia con lector autorizado (sin SQL retenido)
    let absence;
    try {
      await gateway.deleteMessage({ chatId: po.chat_id, messageId: Number(po.message_id) });
      absence = await gateway.probeAbsence({ chatId: po.chat_id, messageId: Number(po.message_id) });
    } catch (error) {
      const c = classifyProviderError(error); metrics.objectsUncertain++;
      await markObject(uid, purgeId, po.object_id, { status: 'UNCERTAIN', last_error: `${c.reason}: ${String(error?.message || error).slice(0, 180)}` }).catch(() => {});
      throw new PurgeStepError('PURGE_PROVIDER_UNCERTAIN', `provider did not prove deletion (${c.reason})`, { transient: c.transient, retryAfterMs: Number(error?.retryAfterMs) || 15_000, reason: 'PROVIDER_UNCERTAIN' });
    }
    if (!absence || absence.absent !== true) {
      metrics.objectsUncertain++;
      await markObject(uid, purgeId, po.object_id, { status: 'UNCERTAIN', last_error: `PRESENT_AFTER_DELETE: ${absence && absence.evidence}` }).catch(() => {});
      throw new PurgeStepError('PURGE_PROVIDER_UNCERTAIN', 'object still present after delete request', { transient: true, retryAfterMs: 15_000, reason: 'PROVIDER_UNCERTAIN' });
    }
    // (4) tx corta: DELETED condicionado a la generación; cierre de items/purge
    return mutationTx(userId, await libraryHeaders(userId), async (client, ctx, uid2) => {
      const r = await client.query("UPDATE catalog_media_objects SET status = 'DELETED' WHERE user_id = $1 AND object_id = $2 AND status = 'DELETING' AND deletion_generation = $3 RETURNING object_id", [uid2, po.object_id, po.generation]);
      if (!r.rows.length) { await client.query("UPDATE catalog_purge_objects SET status = 'UNCERTAIN', last_error = 'DELETION_GENERATION_MISMATCH' WHERE user_id = $1 AND purge_id = $2 AND object_id = $3", [uid2, purgeId, po.object_id]); return { purgeId, objectId: po.object_id, deleted: false, reason: 'GENERATION_MISMATCH' }; }
      await client.query("UPDATE catalog_purge_objects SET status = 'DELETED', deleted_at = now(), last_error = NULL WHERE user_id = $1 AND purge_id = $2 AND object_id = $3", [uid2, purgeId, po.object_id]);
      await client.query("UPDATE catalog_media_grants SET status = 'REVOKED' WHERE user_id = $1 AND object_id = $2 AND status = 'ACTIVE'", [uid2, po.object_id]);
      metrics.objectsDeleted++;
      const closed = await closeItemsAndPurge(client, uid2, purgeId);
      return { purgeId, objectId: po.object_id, deleted: true, evidence: absence.evidence, journalRef, closed };
    }, { allowFrozen: true });
  }

  // ---------- un paso del job PURGE (worker): enumerar o borrar; devuelve si queda trabajo ----------
  async function step({ userId, purgeId } = {}) {
    if (typeof purgeId !== 'string' || !ID_RE.test(purgeId)) throw inputInvalid('PURGE_ID');
    const st = (await pool.query('SELECT status FROM catalog_purges WHERE user_id = $1 AND purge_id = $2', [userId, purgeId]).catch((e) => { throw sqlError(e); })).rows[0];
    if (!st) throw notFound('purge');
    if (st.status === 'ENUMERATING') { const r = await enumerateStep({ userId, purgeId }); return { ...r, more: r.status === 'ENUMERATING' || r.status === 'DELETING' }; }
    if (st.status === 'DELETING') { const r = await deleteStep({ userId, purgeId }); return { ...r, more: !(r.none && r.status !== 'DELETING') }; }
    return { purgeId, status: st.status, more: false };
  }
  async function getPurge({ userId, purgeId } = {}) {
    if (typeof purgeId !== 'string' || !ID_RE.test(purgeId)) throw inputInvalid('PURGE_ID');
    return readTx(userId, (client, uid) => purgeDto(client, uid, purgeId));
  }
  // cancel: detiene lo no empezado; lo DELETED permanece; un objeto DELETING sigue bloqueado hasta su confirmación (nunca "des-borrar").
  async function cancelPurge({ userId, era, epoch, purgeId } = {}) {
    if (typeof purgeId !== 'string' || !ID_RE.test(purgeId)) throw inputInvalid('PURGE_ID');
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const p = (await client.query(`${PURGE_SQL} FOR UPDATE`, [uid, purgeId])).rows[0]; if (!p) throw notFound('purge');
      if (['PURGED', 'PARTIAL', 'BLOCKED', 'CANCELLED'].includes(p.status)) return purgeDto(client, uid, purgeId, { changed: false });
      const inflight = (await client.query("SELECT count(*)::int AS n FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 AND status IN ('JOURNALED', 'DELETING', 'UNCERTAIN')", [uid, purgeId])).rows[0].n;
      if (inflight > 0) throw new CatalogQueryError('PURGE_IN_FLIGHT', 409, 'objects are mid-deletion; the purge cannot be cancelled until they are confirmed', { in_flight: inflight });
      await client.query("UPDATE catalog_purge_objects SET status = 'BLOCKED', block_reason = 'CANCELLED' WHERE user_id = $1 AND purge_id = $2 AND status = 'PENDING'", [uid, purgeId]);
      // items sin ningún objeto borrado vuelven a TRASH (nada físico ocurrió): PURGING → TRASH, cuota y tombstone en preparación revertidos.
      // Un item con partes ya borradas no vuelve: el usuario no puede restaurar una entidad a la que ya se le borraron partes (C9).
      const open = (await client.query("SELECT beat_id FROM catalog_purge_items WHERE user_id = $1 AND purge_id = $2 AND status IN ('PENDING', 'ENUMERATED', 'DELETING') FOR UPDATE", [uid, purgeId])).rows;
      let reverted = 0;
      for (const it of open) {
        const deleted = (await client.query("SELECT count(*)::int AS n FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3 AND status = 'DELETED'", [uid, purgeId, it.beat_id])).rows[0].n;
        const b = (await client.query('SELECT state FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 FOR UPDATE', [uid, p.generation_id, it.beat_id])).rows[0];
        if (deleted === 0 && b && b.state === 'PURGING') {
          await client.query("UPDATE catalog_beats SET state = 'TRASH', version = version + 1, updated_at = now() WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3", [uid, p.generation_id, it.beat_id]);
          await client.query('UPDATE catalog_libraries SET trash_count = trash_count + 1, purging_count = purging_count - 1, updated_at = now() WHERE user_id = $1', [uid]);
          await client.query("UPDATE catalog_purge_items SET status = 'BLOCKED', block_reason = 'BEAT_STATE' WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, it.beat_id]);
          reverted++;
        } else await client.query("UPDATE catalog_purge_items SET status = 'BLOCKED', block_reason = 'PROVIDER_UNCERTAIN' WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, it.beat_id]);
      }
      await client.query("UPDATE catalog_purges SET status = 'CANCELLED', completed_at = now(), updated_at = now() WHERE user_id = $1 AND purge_id = $2", [uid, purgeId]);
      return purgeDto(client, uid, purgeId, { changed: true, reverted });
    });
  }
  // ---------- restore_hold: solo con el journal externo reconciliado y cleanup aprobado ----------
  async function releaseRestoreHold({ userId, era, epoch } = {}) {
    if (!journal || typeof journal.list !== 'function') throw new CatalogQueryError('JOURNAL_UNAVAILABLE', 503, 'deletion journal is required to reconcile restore_hold', {});
    const uid = requireUserId(userId);
    const entries = await journal.list(uid);
    return mutationTx(userId, { era, epoch }, async (client, _ctx, u) => {
      const flags = await libFlags(client, u);
      if (!flags.cleanup_enabled) throw new CatalogQueryError('CLEANUP_DISABLED', 409, 'cleanup is not enabled for this library (owner approval, T24)', {});
      const unresolved = [];
      for (const e of entries) {
        const o = (await client.query('SELECT status FROM catalog_media_objects WHERE user_id = $1 AND object_id = $2', [u, e.objectId])).rows[0];
        if (o && o.status !== 'DELETED') unresolved.push(e.objectId); // journal dice intención de borrado pero SQL (restaurado) lo cree presente → hold sigue
      }
      if (unresolved.length) throw new CatalogQueryError('RESTORE_HOLD_PENDING', 409, 'deletion journal has entries not reflected in SQL; reconcile before releasing restore_hold', { unresolved: unresolved.slice(0, 20), count: unresolved.length });
      await client.query('UPDATE catalog_libraries SET restore_hold = false, updated_at = now() WHERE user_id = $1', [u]);
      return { userId: u, restoreHold: false, journalEntries: entries.length };
    });
  }

  return Object.freeze({ requestPurge, enumerateStep, deleteStep, step, getPurge, cancelPurge, releaseRestoreHold, metrics, PurgeStepError, limits: Object.freeze({ ENUMERATE_BATCH, OBJECT_MAX_ATTEMPTS }) });
}

module.exports = { ENUMERATE_BATCH, OBJECT_MAX_ATTEMPTS, BLOCK_REASONS, PurgeStepError, evaluateObjectBlock, classifyProviderError, createCatalogPurge };
