'use strict';
// T15 / E81 — Eliminación definitiva (CONTRATO C9; TAREAS §T15; NATIVO r2.1 §6.1/§7), separada en DOS fases independientes:
//  - Catálogo (requestPurge + enumerateStep, solo SQL, bajo el lock de la biblioteca): cada beat TRASH del alcance (límite de papelera
//    capturado en la revisión de la intención) pasa DIRECTAMENTE a PURGED en la misma transacción en la que se registra su manifiesto de
//    limpieza: versiones DELETED, tombstone CATALOG, papelera −1 (la cuota se libera: PURGED no ocupa), facetas por delta, revisión y evento.
//    Desaparece de la biblioteca y de la Gallery sin esperar a Telegram. Solo quedan en la papelera (restaurables, nada cambió) los beats con
//    referencia OPAQUE (identidad física desconocida: no se podría limpiar) o con una transferencia en vuelo (sus recibos aún pueden cambiar).
//  - Limpieza física (cleanupStep, worker): el manifiesto `catalog_purge_objects` conserva, FUERA del catálogo activo, la identidad física de
//    cada objeto (chat/mensaje, archivo, parte) y su resultado durable. Por objeto, sin cliente SQL durante las llamadas externas:
//    (1) tx corta: revalidar bajo lock de biblioteca y luego del objeto — compartido con otro beat vivo/retenido u otra generación → KEPT
//    (nunca se borra lo que otro usa); `restore_hold`/`cleanup_enabled=false`/sin journal/sin gateway/otro borrado en vuelo del mismo objeto →
//    DIFERIDO (sin efecto externo); si no, objeto físico DELETING (ninguna referencia nueva lo adopta) e intento +1; (2) journal externo
//    append + verify (sin persistencia demostrada no hay delete → DIFERIDO); (3) deleteMessage + probeAbsence: solo MessageEmpty en el peer
//    correcto demuestra ausencia → DELETED; RPC rechazado (permanente/credencial) → REJECTED (no se reintenta solo); rechazo transitorio (flood)
//    → no aplicado, reintento acotado por el job; timeout/sin prueba → UNCERTAIN, que NUNCA se reenvía a ciegas: el paso siguiente solo
//    consulta (probe): ausente → DELETED; presente → el borrado no se aplicó y vuelve a PENDING (tope OBJECT_MAX_ATTEMPTS); sin respuesta →
//    UNCERTAIN aparcado. Un reinicio con el objeto en DELETING/JOURNALED se trata igual que UNCERTAIN.
//  - Nada vuelve a la papelera ni queda en PURGING por un problema de Telegram. Lo diferido o aparcado se reanuda (resumeCleanup) solo ante un
//    evento explícito (nueva purga del usuario, liberación de restore_hold, operador) y solo si su causa ya no aplica; REJECTED y el tope de
//    intentos quedan para reconciliación del operador. Sin temporizadores ni políticas nuevas.
//  - `releaseRestoreHold`: solo con el journal externo reconciliado y `cleanup_enabled` aprobado. Cleanup real: apagado (T24); aquí solo fakes.
// Solo SQL + crypto. Gateway (T11) y journal se inyectan.

const crypto = require('crypto');
const { requireUserId } = require('./contract');
const { canonicalJson, CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');
const { STATEMENT_TIMEOUT_MS } = require('./queries');
const facets = require('./facets');

const ENUMERATE_BATCH = 50;
const OBJECT_MAX_ATTEMPTS = 8;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
// Motivos de item (CHECK de 0033): el beat sigue en la papelera.
const BLOCK_REASONS = Object.freeze(['OPAQUE_REFERENCE', 'SHARED_OBJECT', 'RETENTION_WINDOW', 'RESTORE_HOLD', 'CLEANUP_DISABLED', 'PENDING_OPERATION', 'JOURNAL_UNAVAILABLE', 'PROVIDER_UNCERTAIN', 'BEAT_STATE']);
// Motivos de objeto de limpieza: KEPT = terminal, otro lo usa; DEFERRED = pendiente sin efecto externo, reanudable; REJECTED/tope = operador.
const KEPT_REASONS = Object.freeze(['SHARED_OBJECT', 'RETENTION_WINDOW']);
const DEFERRED_REASONS = Object.freeze(['RESTORE_HOLD', 'CLEANUP_DISABLED', 'JOURNAL_UNAVAILABLE', 'TRANSPORT_UNAVAILABLE', 'PENDING_OPERATION']);
const REJECTED_REASON = 'PROVIDER_REJECTED';
const PARKED_REASON = 'PROVIDER_UNCERTAIN';

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const notFound = (what) => new CatalogQueryError('NOT_FOUND', 404, `${what} is not accessible`, {});
const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const sqlError = (error) => {
  if (error instanceof CatalogAuthorityError || error instanceof CatalogQueryError || error instanceof PurgeStepError) return error;
  if (error?.code === '57014') return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog statement timed out', { sqlstate: '57014' });
  if (['BGL01', 'BGN04', 'BGA05', 'BGC02'].includes(error?.code)) return new CatalogQueryError('CATALOG_NATIVE_RULE', 409, 'database native rule rejected the mutation', { sqlstate: error.code, detail: error.detail || null });
  return new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog is unavailable (SQL_ERROR)', { reason: 'SQL_ERROR', sqlstate: error?.code || null, sql_message: error?.code ? String(error.message).slice(0, 200) : null });
};
class PurgeStepError extends Error {
  constructor(code, message, { transient = true, retryAfterMs = 0, reason = null } = {}) { super(message); this.name = 'PurgeStepError'; this.code = code; this.transient = transient; this.retryAfterMs = retryAfterMs; this.reason = reason; }
}

// Evaluaciones puras (también las usa la prueba unitaria).
// Beat: lo que impide sacarlo del catálogo (sigue en la papelera, restaurable).
function evaluateBeatBlock({ opaque = false, pendingOperations = 0 } = {}) {
  if (opaque) return 'OPAQUE_REFERENCE';
  if (pendingOperations > 0) return 'PENDING_OPERATION';
  return null;
}
// Objeto de limpieza: referencias ajenas y retención (KEPT) antes que los flags de la biblioteca (DEFERRED).
function evaluateObjectBlock({ otherLiveRefs = 0, retainedUntilFuture = false, restoreHold = false, cleanupEnabled = true } = {}) {
  if (otherLiveRefs > 0) return 'SHARED_OBJECT';
  if (retainedUntilFuture) return 'RETENTION_WINDOW';
  if (restoreHold) return 'RESTORE_HOLD';
  if (!cleanupEnabled) return 'CLEANUP_DISABLED';
  return null;
}
// Error del proveedor en deleteMessage: un RPC rechazado (permanente o credencial) no se aplicó → REJECTED; un rechazo transitorio (flood)
// tampoco se aplicó → NOT_APPLIED; todo lo demás (timeout, red, sin clasificar) pudo aplicarse → UNCERTAIN. Nada aquí prueba ausencia.
function classifyProviderError(error) {
  const c = error && error.classification;
  if (error && error.code === 'CREDENTIAL_REVOKED') return { outcome: 'REJECTED', transient: false, reason: 'REVOKED' };
  if (c && c.kind === 'PERMANENT') return { outcome: 'REJECTED', transient: false, reason: c.code || 'PERMANENT' };
  if (c && c.kind === 'REJECTED' && c.effectPossible === false) return { outcome: 'NOT_APPLIED', transient: true, reason: c.code || 'REJECTED', retryAfterMs: Number(c.retryAfterMs) || 15_000 };
  return { outcome: 'UNCERTAIN', transient: true, reason: (c && c.code) || (error && error.code) || 'PROVIDER' };
}

function createCatalogPurge({ pool = null, authority = null, gateway = null, journal = null, randomUUID = () => crypto.randomUUID(), log = () => {} } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createCatalogPurge requires a pool');
  if (!authority || typeof authority.requireLibraryForMutation !== 'function') throw new Error('createCatalogPurge requires the catalog authority');
  const metrics = { requested: 0, itemsEnumerated: 0, purged: 0, objectsDeleted: 0, objectsKept: 0, objectsDeferred: 0, objectsRejected: 0, objectsUncertain: 0, journalFailures: 0, resumed: 0 };
  const hasGateway = () => Boolean(gateway && typeof gateway.deleteMessage === 'function' && typeof gateway.probeAbsence === 'function');
  const hasJournal = () => Boolean(journal && typeof journal.append === 'function' && typeof journal.verify === 'function');

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
  const libFlags = async (client, uid) => (await client.query('SELECT restore_hold, cleanup_enabled FROM catalog_libraries WHERE user_id = $1', [uid])).rows[0];
  // Los pasos del worker no traen cabeceras C5: la era/época vigentes se leen en una consulta corta (igual que worker.libraryHeaders).
  async function libraryHeaders(userId) {
    const uid = requireUserId(userId);
    const r = await pool.query('SELECT authority_era::text AS era, authority_epoch::text AS epoch FROM catalog_libraries WHERE user_id = $1', [uid]).catch((e) => { throw sqlError(e); });
    if (!r.rows.length) throw notFound('library');
    return { era: r.rows[0].era, epoch: r.rows[0].epoch };
  }
  const PURGE_SQL = `SELECT purge_id, generation_id, authority_epoch::text AS authority_epoch, base_revision::text AS base_revision, scope, limit_position, status, enumeration_cursor, total_items, purged_items, blocked_items, last_error, created_at, updated_at, completed_at
    FROM catalog_purges WHERE user_id = $1 AND purge_id = $2`;
  // Resumen de la limpieza física: confirmado / conservado (otro lo usa) / rechazado / incierto / pendiente (en curso o diferido).
  const CLEANUP_SQL = `SELECT count(*) FILTER (WHERE status = 'DELETED')::int AS deleted,
      count(*) FILTER (WHERE status = 'BLOCKED' AND block_reason = ANY($3::text[]))::int AS kept,
      count(*) FILTER (WHERE status = 'BLOCKED' AND block_reason = $4)::int AS rejected,
      count(*) FILTER (WHERE status = 'UNCERTAIN' OR (status = 'BLOCKED' AND block_reason = $5))::int AS uncertain,
      count(*) FILTER (WHERE status IN ('PENDING', 'JOURNALED', 'DELETING') OR (status = 'BLOCKED' AND block_reason = ANY($6::text[])))::int AS pending
    FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2`;
  async function purgeDto(client, uid, purgeId, extra = {}) {
    const p = (await client.query(PURGE_SQL, [uid, purgeId])).rows[0]; if (!p) throw notFound('purge');
    const items = (await client.query('SELECT beat_id, status, block_reason, objects_total, objects_deleted FROM catalog_purge_items WHERE user_id = $1 AND purge_id = $2 ORDER BY beat_id COLLATE "C" LIMIT 240', [uid, purgeId])).rows;
    const objects = (await client.query('SELECT status, count(*)::int AS n FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 GROUP BY status', [uid, purgeId])).rows;
    const cleanup = (await client.query(CLEANUP_SQL, [uid, purgeId, KEPT_REASONS, REJECTED_REASON, PARKED_REASON, DEFERRED_REASONS])).rows[0];
    return { operationId: p.purge_id, purgeId: p.purge_id, kind: 'PURGE', status: p.status, scope: p.scope, baseRevision: p.base_revision, epoch: p.authority_epoch, progress: { total: p.total_items, purged: p.purged_items, blocked: p.blocked_items, pending: Math.max(0, p.total_items - p.purged_items - p.blocked_items), objects: Object.fromEntries(objects.map((o) => [o.status, o.n])) },
      cleanup, items: items.map((i) => ({ beatId: i.beat_id, status: i.status, blockReason: i.block_reason, objectsTotal: i.objects_total, objectsDeleted: i.objects_deleted })), lastError: p.last_error, createdAt: p.created_at, updatedAt: p.updated_at, completedAt: p.completed_at, durable: true, ...extra };
  }
  const enqueueCleanupJob = (client, uid, purgeId) => client.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, 'PURGE', $3, $4) ON CONFLICT (job_id) DO NOTHING`, [`job-pclean-${randomUUID()}`.slice(0, 64), uid, purgeId, canonicalJson({ purgeId })]);
  const hasActiveJob = async (client, uid, purgeId) => (await client.query("SELECT 1 FROM catalog_jobs WHERE user_id = $1 AND kind = 'PURGE' AND operation_id = $2 AND state IN ('QUEUED', 'LEASED') LIMIT 1", [uid, purgeId])).rows.length > 0;

  // ---------- catálogo: un beat sale definitivamente de la biblioteca (TRASH, o PURGING de antes de E81) → PURGED ----------
  async function purgeFromCatalog(client, uid, gen, beatId, purgeId, fromState, revision, objectsTotal) {
    const facetsBefore = await facets.snapshotGroups(client, uid, gen, [beatId]);
    await client.query("UPDATE catalog_beats SET state = 'PURGED', version = version + 1, updated_at = now() WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3", [uid, gen, beatId]);
    await client.query("UPDATE catalog_file_versions SET status = 'DELETED' WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 AND status <> 'DELETED'", [uid, gen, beatId]);
    // Facetas por delta (la faceta TRASH deja de contar el beat; los grupos siguen al estado por FK ON UPDATE CASCADE), bajo el lock de biblioteca.
    await facets.applyFacetDelta(client, uid, gen, facetsBefore, await facets.snapshotGroups(client, uid, gen, [beatId]), revision);
    // tombstone CATALOG (R11: compatible con el exportador) en la misma transacción que el PURGED; 0026 lo prohíbe mientras el beat está vivo
    await client.query(`INSERT INTO catalog_tombstones(user_id, generation_id, beat_id, source, deleted_at, assets_known) VALUES ($1, $2, $3, 'CATALOG', now(), true) ON CONFLICT (user_id, generation_id, beat_id) DO UPDATE SET deleted_at = coalesce(catalog_tombstones.deleted_at, now())`, [uid, gen, beatId]);
    // concesiones de medios vivas: el beat ya no es accesible (media.js también lo niega por estado)
    await client.query(`UPDATE catalog_media_grants SET status = 'REVOKED' WHERE user_id = $1 AND status = 'ACTIVE' AND object_id IN (SELECT object_id FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3)`, [uid, purgeId, beatId]);
    const counter = fromState === 'PURGING' ? 'purging_count' : 'trash_count';
    const rev = (await client.query(`UPDATE catalog_libraries SET revision = revision + 1, ${counter} = ${counter} - 1, updated_at = now() WHERE user_id = $1 RETURNING revision::text AS revision`, [uid])).rows[0].revision;
    const seq = (await client.query('SELECT coalesce(max(event_seq), 0) + 1 AS seq FROM catalog_events WHERE user_id = $1', [uid])).rows[0].seq;
    // 0029 no define BEAT_PURGED: evento OPERATION_STATUS con payload explícito (kind PURGE, status PURGED)
    await client.query('INSERT INTO catalog_events(user_id, event_seq, generation_id, revision, kind, beat_id, version, operation_id, payload_json) VALUES ($1,$2,$3,$4::bigint,$5,$6,NULL,$7,$8)', [uid, seq, gen, rev, 'OPERATION_STATUS', beatId, purgeId, canonicalJson({ kind: 'PURGE', status: 'PURGED', beatId, objects: objectsTotal })]);
    await client.query("UPDATE catalog_purge_items SET status = 'PURGED', block_reason = NULL, purged_at = now(), enumerated_at = coalesce(enumerated_at, now()), objects_total = $4 WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, beatId, objectsTotal]);
    metrics.purged++;
  }
  async function finishPurgeRow(client, uid, purgeId, status = null) {
    const agg = (await client.query("SELECT count(*) FILTER (WHERE status = 'PURGED')::int AS purged, count(*) FILTER (WHERE status = 'BLOCKED')::int AS blocked, count(*)::int AS total FROM catalog_purge_items WHERE user_id = $1 AND purge_id = $2", [uid, purgeId])).rows[0];
    const final = status || (agg.blocked === 0 ? 'PURGED' : agg.purged === 0 ? 'BLOCKED' : 'PARTIAL');
    await client.query('UPDATE catalog_purges SET status = $3, total_items = $4, purged_items = $5, blocked_items = $6, completed_at = coalesce(completed_at, now()), updated_at = now() WHERE user_id = $1 AND purge_id = $2', [uid, purgeId, final, agg.total, agg.purged, agg.blocked]);
    return final;
  }
  // Estados anteriores a E81 (beats que quedaron en PURGING, purgas DELETING): el catálogo se cierra igual que ahora (PURGED) y sus objetos
  // pendientes siguen como limpieza durable del mismo manifiesto. Bajo el lock de biblioteca.
  async function settlePriorPurging(client, uid, gen, revision) {
    const rows = (await client.query(`SELECT b.beat_id, (SELECT i.purge_id FROM catalog_purge_items i JOIN catalog_purges p ON p.user_id = i.user_id AND p.purge_id = i.purge_id
          WHERE i.user_id = b.user_id AND i.beat_id = b.beat_id AND p.generation_id = b.generation_id ORDER BY p.created_at DESC LIMIT 1) AS purge_id
        FROM catalog_beats b WHERE b.user_id = $1 AND b.generation_id = $2 AND b.state = 'PURGING' ORDER BY b.beat_id COLLATE "C" FOR UPDATE`, [uid, gen])).rows;
    for (const r of rows) {
      if (!r.purge_id) continue; // sin manifiesto no hay de dónde sacar sus referencias: se deja para el operador (no se inventa)
      const n = (await client.query('SELECT count(*)::int AS n FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3', [uid, r.purge_id, r.beat_id])).rows[0].n;
      await purgeFromCatalog(client, uid, gen, r.beat_id, r.purge_id, 'PURGING', revision, n);
    }
    const live = (await client.query("SELECT purge_id FROM catalog_purges WHERE user_id = $1 AND status = 'DELETING' FOR UPDATE", [uid])).rows;
    for (const p of live) {
      await client.query("UPDATE catalog_purge_items SET status = 'BLOCKED', block_reason = 'BEAT_STATE' WHERE user_id = $1 AND purge_id = $2 AND status IN ('PENDING', 'ENUMERATED', 'DELETING')", [uid, p.purge_id]);
      await finishPurgeRow(client, uid, p.purge_id);
    }
    return rows.length + live.length;
  }
  // Reanudación explícita: lo diferido cuya causa ya no aplica vuelve a PENDING, lo incierto aparcado vuelve a reconciliarse (solo consulta),
  // y cada purga con trabajo accionable y sin job vivo recibe uno. REJECTED y el tope de intentos no se tocan (operador).
  async function resumeCleanupTx(client, uid) {
    const flags = await libFlags(client, uid);
    const ready = [];
    if (!flags.restore_hold) ready.push('RESTORE_HOLD');
    if (!flags.restore_hold && flags.cleanup_enabled) ready.push('CLEANUP_DISABLED');
    if (hasJournal()) ready.push('JOURNAL_UNAVAILABLE');
    if (hasGateway()) ready.push('TRANSPORT_UNAVAILABLE');
    ready.push('PENDING_OPERATION');
    const requeued = (await client.query("UPDATE catalog_purge_objects SET status = 'PENDING', block_reason = NULL WHERE user_id = $1 AND status = 'BLOCKED' AND block_reason = ANY($2::text[]) AND attempts < $3", [uid, ready, OBJECT_MAX_ATTEMPTS])).rowCount;
    const unparked = hasGateway() ? (await client.query('UPDATE catalog_purge_objects SET block_reason = NULL WHERE user_id = $1 AND status = $2 AND block_reason = $3', [uid, 'UNCERTAIN', PARKED_REASON])).rowCount : 0;
    const purges = (await client.query(`SELECT DISTINCT purge_id FROM catalog_purge_objects WHERE user_id = $1 AND (status IN ('PENDING', 'JOURNALED', 'DELETING') OR (status = 'UNCERTAIN' AND block_reason IS NULL))`, [uid])).rows;
    let jobs = 0;
    for (const p of purges) if (!(await hasActiveJob(client, uid, p.purge_id))) { await enqueueCleanupJob(client, uid, p.purge_id); jobs++; }
    metrics.resumed += requeued + unparked;
    return { requeued, unparked, jobs };
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
      const gen = ctx.generation_id;
      await settlePriorPurging(client, uid, gen, ctx.revision);
      // Solo la fase de catálogo (ENUMERATING, breve y sin Telegram) es exclusiva; la limpieza física de purgas anteriores no impide otra.
      const live = (await client.query("SELECT purge_id FROM catalog_purges WHERE user_id = $1 AND status = 'ENUMERATING' FOR UPDATE", [uid])).rows[0];
      if (live) {
        if (!(await hasActiveJob(client, uid, live.purge_id))) { await enqueueCleanupJob(client, uid, live.purge_id); const e = new CatalogQueryError('PURGE_IN_PROGRESS', 409, 'another purge is already in progress for this library', { operation_id: live.purge_id, resumed: true }); e.commit = true; throw e; }
        throw new CatalogQueryError('PURGE_IN_PROGRESS', 409, 'another purge is already in progress for this library', { operation_id: live.purge_id });
      }
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
      // el worker (C8) recorre la papelera en lotes y luego limpia objetos; el job nace en la misma transacción que la intención
      await client.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, operation_id, payload_json) VALUES ($1, $2, 'PURGE', $3, $4) ON CONFLICT (job_id) DO NOTHING`, [`job-purge-${purgeId}`.slice(0, 64), uid, purgeId, canonicalJson({ purgeId })]);
      // una acción explícita del usuario reanuda la limpieza diferida de purgas anteriores (si su causa ya no aplica)
      await resumeCleanupTx(client, uid);
      metrics.requested++;
      return purgeDto(client, uid, purgeId, { replay: false, created: true, status: 'ENUMERATING' });
    });
  }

  // ---------- fase de catálogo (worker): lotes ≤50 → manifiesto de limpieza + PURGED en la misma transacción ----------
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
      const block = (beatId, reason) => client.query("UPDATE catalog_purge_items SET status = 'BLOCKED', block_reason = $4, enumerated_at = now() WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, beatId, reason]);
      for (const r of rows) {
        const b = (await client.query('SELECT state FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND beat_id = $3 FOR UPDATE', [uid, gen, r.beat_id])).rows[0];
        if (!b || b.state !== 'TRASH') { await block(r.beat_id, 'BEAT_STATE'); continue; }
        // manifiesto de objetos: versiones (todas: actuales, retenidas, STAGED, REVIEW) → partes → ubicaciones PRIMARY; recibos no confirmados → objetos sin vincular
        const locs = (await client.query(`SELECT l.object_id, l.reference_class, l.file_id, l.part_index, o.chat_id, o.message_id::text AS message_id
            FROM catalog_file_versions fv JOIN catalog_file_parts fp ON fp.user_id = fv.user_id AND fp.generation_id = fv.generation_id AND fp.file_id = fv.file_id
            JOIN catalog_part_locations l ON l.user_id = fp.user_id AND l.generation_id = fp.generation_id AND l.file_id = fp.file_id AND l.part_index = fp.part_index AND l.location = 'PRIMARY'
            LEFT JOIN catalog_media_objects o ON o.user_id = l.user_id AND o.object_id = l.object_id
            WHERE fv.user_id = $1 AND fv.generation_id = $2 AND fv.beat_id = $3 AND fv.status <> 'DELETED'`, [uid, gen, r.beat_id])).rows;
        const pendingOps = (await client.query(`SELECT count(*)::int AS n FROM catalog_transfer_operations o WHERE o.user_id = $1 AND o.beat_id = $2 AND o.status IN ('PREPARED', 'TRANSFERRING', 'VERIFYING', 'READY', 'RECONCILE')`, [uid, r.beat_id])).rows[0].n;
        // Identidad física desconocida (OPAQUE) o transferencia en vuelo (sus recibos aún pueden cambiar): el beat sigue en la papelera, intacto.
        const reason = evaluateBeatBlock({ opaque: locs.some((l) => l.reference_class !== 'KNOWN' || !l.object_id), pendingOperations: pendingOps });
        if (reason) { await block(r.beat_id, reason); continue; }
        const receipts = (await client.query(`SELECT p.chat_id, p.provider_message_id::text AS message_id, p.provider_document_id, p.receipt_json FROM catalog_operation_parts p JOIN catalog_transfer_operations o ON o.user_id = p.user_id AND o.operation_id = p.operation_id
            WHERE p.user_id = $1 AND o.beat_id = $2 AND o.status <> 'COMMITTED' AND p.provider_message_id IS NOT NULL`, [uid, r.beat_id])).rows;
        const objects = new Map();
        for (const l of locs) objects.set(l.object_id, { objectId: l.object_id, fileId: l.file_id, partIndex: l.part_index, chatId: l.chat_id, messageId: l.message_id });
        for (const rc of receipts) {
          // objeto sin vincular (recibo de una operación no confirmada, p. ej. REPLACE en CONFLICT): su identidad física se registra antes de
          // poder borrarlo (el journal y la confirmación necesitan una fila de catalog_media_objects); nunca se borra por intuición.
          const oid = `tg:${rc.chat_id}:${rc.message_id}`;
          const exists = (await client.query('SELECT 1 FROM catalog_media_objects WHERE user_id = $1 AND object_id = $2', [uid, oid])).rows.length;
          if (!exists) { const sender = (() => { try { const j = JSON.parse(rc.receipt_json || '{}'); return j && j.senderId != null && /^-?[0-9]{1,20}$/.test(String(j.senderId)) ? String(j.senderId) : null; } catch { return null; } })(); await client.query(`INSERT INTO catalog_media_objects(user_id, object_id, provider, chat_id, message_id, document_id, sender_id, verified_at, status) VALUES ($1, $2, 'telegram', $3, $4::bigint, $5, $6, now(), 'PRESENT') ON CONFLICT DO NOTHING`, [uid, oid, rc.chat_id, rc.message_id, rc.provider_document_id, sender]); }
          if (!objects.has(oid)) objects.set(oid, { objectId: oid, fileId: null, partIndex: null, chatId: rc.chat_id, messageId: rc.message_id });
        }
        // manifiesto ANTES de sacar el beat del catálogo (misma transacción): las referencias de limpieza nunca se pierden
        for (const o of objects.values()) await client.query(`INSERT INTO catalog_purge_objects(user_id, purge_id, object_id, beat_id, file_id, part_index, chat_id, message_id, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, 'PENDING') ON CONFLICT DO NOTHING`, [uid, purgeId, o.objectId, r.beat_id, o.fileId, o.partIndex, o.chatId, o.messageId]);
        await purgeFromCatalog(client, uid, gen, r.beat_id, purgeId, 'TRASH', ctx.revision, objects.size);
        enumerated++; metrics.itemsEnumerated++;
      }
      const cursor = p.scope === 'ALL_TRASH' && rows.length ? Number(rows[rows.length - 1].export_position) : p.enumeration_cursor;
      const done = rows.length < n;
      await client.query('UPDATE catalog_purges SET enumeration_cursor = $3, updated_at = now() WHERE user_id = $1 AND purge_id = $2', [uid, purgeId, cursor]);
      const status = done ? await finishPurgeRow(client, uid, purgeId) : 'ENUMERATING';
      return { purgeId, status, enumerated, done };
    }, { allowFrozen: true });
  }

  // ---------- fase de limpieza física (worker): un objeto por paso ----------
  async function nextObject(client, uid, purgeId) {
    return (await client.query(`SELECT po.object_id, po.beat_id, po.file_id, po.part_index, po.chat_id, po.message_id::text AS message_id, po.status, po.journal_ref, po.journal_sha256, po.attempts
        FROM catalog_purge_objects po WHERE po.user_id = $1 AND po.purge_id = $2 AND (po.status IN ('PENDING', 'JOURNALED', 'DELETING') OR (po.status = 'UNCERTAIN' AND po.block_reason IS NULL))
        ORDER BY po.attempts, po.beat_id COLLATE "C", po.object_id COLLATE "C" LIMIT 1 FOR UPDATE SKIP LOCKED`, [uid, purgeId])).rows[0] || null;
  }
  // Bloqueos (bajo lock de biblioteca y luego objeto): referencias vivas de otros beats u otra generación protegida, retención vigente, flags.
  async function blockReasonFor(client, uid, gen, po, flags) {
    const others = (await client.query(`SELECT count(*)::int AS n FROM catalog_part_locations l JOIN catalog_file_versions fv ON fv.user_id = l.user_id AND fv.generation_id = l.generation_id AND fv.file_id = l.file_id
        WHERE l.user_id = $1 AND l.object_id = $2 AND fv.beat_id <> $3 AND fv.status NOT IN ('DELETED', 'RETIRED')`, [uid, po.object_id, po.beat_id])).rows[0].n;
    const retained = (await client.query(`SELECT count(*)::int AS n FROM catalog_part_locations l JOIN catalog_file_versions fv ON fv.user_id = l.user_id AND fv.generation_id = l.generation_id AND fv.file_id = l.file_id
        WHERE l.user_id = $1 AND l.object_id = $2 AND fv.beat_id <> $3 AND fv.status = 'RETIRED' AND fv.retained_until IS NOT NULL AND fv.retained_until > now()`, [uid, po.object_id, po.beat_id])).rows[0].n;
    const otherGenRefs = (await client.query(`SELECT count(*)::int AS n FROM catalog_part_locations l JOIN catalog_generations g ON g.user_id = l.user_id AND g.generation_id = l.generation_id
        WHERE l.user_id = $1 AND l.object_id = $2 AND l.generation_id <> $3 AND g.status = 'RETIRED'`, [uid, po.object_id, gen])).rows[0].n; // generaciones RETIRED protegidas hasta su retención (0027)
    return evaluateObjectBlock({ otherLiveRefs: others + otherGenRefs, retainedUntilFuture: retained > 0, restoreHold: flags.restore_hold, cleanupEnabled: flags.cleanup_enabled });
  }
  // Escritura fuera de transacción tras una llamada externa: nunca pisa un resultado DELETED (un worker con lease vencido llega tarde).
  // `attempts` (opcional) la condiciona además a seguir siendo el dueño del intento: reclamación optimista antes de cualquier efecto externo.
  async function markObject(uid, purgeId, objectId, patch, { attempts = null } = {}) {
    const sets = []; const params = [uid, purgeId, objectId];
    for (const [k, v] of Object.entries(patch)) { params.push(v); sets.push(`${k} = $${params.length}`); }
    let guard = "status <> 'DELETED'";
    if (attempts != null) { params.push(attempts); guard = `status = 'PENDING' AND attempts = $${params.length}`; }
    return (await pool.query(`UPDATE catalog_purge_objects SET ${sets.join(', ')} WHERE user_id = $1 AND purge_id = $2 AND object_id = $3 AND ${guard}`, params).catch((e) => { throw sqlError(e); })).rowCount;
  }
  const countDeleted = (client, uid, purgeId, beatId) => client.query("UPDATE catalog_purge_items SET objects_deleted = (SELECT count(*) FROM catalog_purge_objects WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3 AND status = 'DELETED') WHERE user_id = $1 AND purge_id = $2 AND beat_id = $3", [uid, purgeId, beatId]);
  // DELETED condicionado a la generación de borrado (un objeto re-adoptado o restaurado no se marca); recuento del item.
  async function confirmDeleted(userId, purgeId, po, evidence) {
    return mutationTx(userId, await libraryHeaders(userId), async (client, _ctx, uid) => {
      const r = await client.query("UPDATE catalog_media_objects SET status = 'DELETED' WHERE user_id = $1 AND object_id = $2 AND status = 'DELETING' AND deletion_generation = $3 RETURNING object_id", [uid, po.object_id, po.generation]);
      if (!r.rows.length) { await client.query("UPDATE catalog_purge_objects SET status = 'UNCERTAIN', block_reason = $4, last_error = 'DELETION_GENERATION_MISMATCH' WHERE user_id = $1 AND purge_id = $2 AND object_id = $3", [uid, purgeId, po.object_id, PARKED_REASON]); metrics.objectsUncertain++; return { purgeId, objectId: po.object_id, deleted: false, outcome: 'UNCERTAIN', reason: 'GENERATION_MISMATCH' }; }
      await client.query("UPDATE catalog_purge_objects SET status = 'DELETED', block_reason = NULL, deleted_at = now(), last_error = NULL WHERE user_id = $1 AND purge_id = $2 AND object_id = $3", [uid, purgeId, po.object_id]);
      await client.query("UPDATE catalog_media_grants SET status = 'REVOKED' WHERE user_id = $1 AND object_id = $2 AND status = 'ACTIVE'", [uid, po.object_id]);
      await countDeleted(client, uid, purgeId, po.beat_id);
      metrics.objectsDeleted++;
      return { purgeId, objectId: po.object_id, deleted: true, outcome: 'DELETED', evidence };
    }, { allowFrozen: true });
  }
  async function cleanupStep({ userId, purgeId } = {}) {
    // (1) tx corta: siguiente objeto; revalidar bajo lock de biblioteca (ya tomado por requireLibraryForMutation) y luego objeto
    const h = await libraryHeaders(userId);
    const picked = await mutationTx(userId, h, async (client, ctx, uid) => {
      const p = (await client.query(PURGE_SQL, [uid, purgeId])).rows[0]; if (!p) throw notFound('purge');
      const po = await nextObject(client, uid, purgeId);
      if (!po) return { none: true, status: p.status };
      const obj = (await client.query('SELECT status, deletion_generation FROM catalog_media_objects WHERE user_id = $1 AND object_id = $2 FOR UPDATE', [uid, po.object_id])).rows[0];
      const set = (status, reason, extra = '') => client.query(`UPDATE catalog_purge_objects SET status = $4, block_reason = $5${extra} WHERE user_id = $1 AND purge_id = $2 AND object_id = $3`, [uid, purgeId, po.object_id, status, reason]);
      // (la FK de catalog_purge_objects garantiza la fila física) ya borrado por otra purga → confirmado sin otra llamada
      if (obj.status === 'DELETED') {
        await client.query("UPDATE catalog_purge_objects SET status = 'DELETED', block_reason = NULL, deleted_at = coalesce(deleted_at, now()), journal_ref = coalesce(journal_ref, 'prior') WHERE user_id = $1 AND purge_id = $2 AND object_id = $3", [uid, purgeId, po.object_id]);
        await countDeleted(client, uid, purgeId, po.beat_id);
        return { none: false, outcome: 'DELETED', skipped: true };
      }
      // un intento anterior pudo llegar a Telegram (incierto, o reinicio tras el journal): solo se consulta, nunca se reenvía a ciegas
      if (po.status !== 'PENDING') return { none: false, reconcile: true, po: { ...po, generation: obj.deletion_generation || p.generation_id }, uid };
      if (po.attempts >= OBJECT_MAX_ATTEMPTS) { await set('BLOCKED', PARKED_REASON); metrics.objectsUncertain++; return { none: false, outcome: 'UNCERTAIN', reason: 'MAX_ATTEMPTS', objectId: po.object_id }; }
      const reason = await blockReasonFor(client, uid, p.generation_id, po, await libFlags(client, uid));
      if (reason && KEPT_REASONS.includes(reason)) { await set('BLOCKED', reason); metrics.objectsKept++; return { none: false, outcome: 'KEPT', reason, objectId: po.object_id }; }
      const defer = async (why) => { await set('BLOCKED', why); metrics.objectsDeferred++; return { none: false, outcome: 'DEFERRED', reason: why, objectId: po.object_id }; };
      if (reason) return defer(reason);
      if (!hasGateway()) return defer('TRANSPORT_UNAVAILABLE');
      if (!hasJournal()) return defer('JOURNAL_UNAVAILABLE');
      // el mismo objeto físico con un borrado en vuelo en otra purga: esa fila lleva el resultado; esta espera sin efecto externo
      const elsewhere = (await client.query("SELECT 1 FROM catalog_purge_objects WHERE user_id = $1 AND object_id = $2 AND purge_id <> $3 AND (status IN ('JOURNALED', 'DELETING', 'UNCERTAIN') OR (status = 'PENDING' AND attempts > 0)) LIMIT 1", [uid, po.object_id, purgeId])).rows.length;
      if (elsewhere) return defer('PENDING_OPERATION');
      if (obj.status !== 'DELETING') await client.query("UPDATE catalog_media_objects SET status = 'DELETING', deletion_generation = $3 WHERE user_id = $1 AND object_id = $2", [uid, po.object_id, p.generation_id]);
      await client.query('UPDATE catalog_purge_objects SET attempts = attempts + 1 WHERE user_id = $1 AND purge_id = $2 AND object_id = $3', [uid, purgeId, po.object_id]);
      return { none: false, po: { ...po, attempt: po.attempts + 1, generation: obj.status === 'DELETING' && obj.deletion_generation ? obj.deletion_generation : p.generation_id }, uid };
    }, { allowFrozen: true });
    if (!picked.po) return { purgeId, ...picked };
    const { po, uid } = picked;
    if (picked.reconcile) {
      // (R) reconciliación segura: solo lectura en el proveedor
      let absence;
      try { absence = await gateway.probeAbsence({ chatId: po.chat_id, messageId: Number(po.message_id) }); } catch (error) { absence = null; await markObject(uid, purgeId, po.object_id, { status: 'UNCERTAIN', block_reason: PARKED_REASON, last_error: `RECONCILE: ${String(error?.code || error?.message || error).slice(0, 200)}` }); metrics.objectsUncertain++; return { purgeId, objectId: po.object_id, deleted: false, outcome: 'UNCERTAIN', reconciled: false }; }
      if (absence && absence.absent === true) return confirmDeleted(userId, purgeId, po, absence.evidence);
      // presente: el borrado anterior no se aplicó → puede intentarse otra vez (tope de intentos existente)
      await markObject(uid, purgeId, po.object_id, { status: 'PENDING', block_reason: null, last_error: `RECONCILED_PRESENT: ${absence && absence.evidence}` });
      return { purgeId, objectId: po.object_id, deleted: false, outcome: 'PENDING', reconciled: true };
    }
    // (2) journal externo: append + verify ANTES del delete. Sin persistencia demostrada no hay delete (diferido, sin efecto externo).
    let journalRef = po.journal_ref; let journalSha = po.journal_sha256;
    if (!journalRef) {
      try {
        const entry = { userId: uid, purgeId, objectId: po.object_id, beatId: po.beat_id, fileId: po.file_id, partIndex: po.part_index, chatId: po.chat_id, messageId: Number(po.message_id), generation: po.generation, kind: 'DELETE_INTENT' };
        const j = await journal.append(entry);
        const ok = j && j.ref && j.sha256 && await journal.verify(j.ref, j.sha256);
        if (!ok) throw Object.assign(new Error('journal persistence could not be verified'), { code: 'JOURNAL_UNVERIFIED' });
        journalRef = j.ref; journalSha = j.sha256;
      } catch (error) {
        metrics.journalFailures++; metrics.objectsDeferred++;
        await markObject(uid, purgeId, po.object_id, { status: 'BLOCKED', block_reason: 'JOURNAL_UNAVAILABLE', last_error: `JOURNAL: ${String(error?.code || error?.message || error).slice(0, 200)}` }, { attempts: po.attempt });
        return { purgeId, objectId: po.object_id, deleted: false, outcome: 'DEFERRED', reason: 'JOURNAL_UNAVAILABLE' };
      }
    }
    // a partir de aquí el borrado puede llegar a Telegram: la fila queda DELETING (un reinicio la reconcilia, no la reenvía). Solo el dueño del
    // intento vigente la reclama: otro worker que tomó el mismo objeto después (intento posterior) gana y este no envía nada.
    const claimed = await markObject(uid, purgeId, po.object_id, { journal_ref: journalRef, journal_sha256: journalSha, status: 'DELETING', block_reason: null }, { attempts: po.attempt });
    if (!claimed) return { purgeId, objectId: po.object_id, deleted: false, outcome: 'SKIPPED', reason: 'CLAIMED_ELSEWHERE' };
    // (3) remoto: borrar y comprobar ausencia con lector autorizado (sin SQL retenido)
    try { await gateway.deleteMessage({ chatId: po.chat_id, messageId: Number(po.message_id) }); } catch (error) {
      const c = classifyProviderError(error);
      if (c.outcome === 'NOT_APPLIED') {
        await markObject(uid, purgeId, po.object_id, { status: 'PENDING', last_error: `NOT_APPLIED: ${c.reason}` });
        throw new PurgeStepError('PURGE_PROVIDER_BUSY', `provider rejected the delete for now (${c.reason})`, { transient: true, retryAfterMs: c.retryAfterMs, reason: c.reason });
      }
      if (c.outcome === 'REJECTED') {
        // el RPC no se aplicó; si el mensaje ya no existe (p. ej. MESSAGE_ID_INVALID) la consulta lo demuestra
        const gone = await gateway.probeAbsence({ chatId: po.chat_id, messageId: Number(po.message_id) }).catch(() => null);
        if (gone && gone.absent === true) return confirmDeleted(userId, purgeId, po, gone.evidence);
        await markObject(uid, purgeId, po.object_id, { status: 'BLOCKED', block_reason: REJECTED_REASON, last_error: `${c.reason}: ${String(error?.message || error).slice(0, 180)}` });
        metrics.objectsRejected++;
        return { purgeId, objectId: po.object_id, deleted: false, outcome: 'REJECTED', reason: c.reason };
      }
      await markObject(uid, purgeId, po.object_id, { status: 'UNCERTAIN', last_error: `${c.reason}: ${String(error?.message || error).slice(0, 180)}` });
      metrics.objectsUncertain++;
      return { purgeId, objectId: po.object_id, deleted: false, outcome: 'UNCERTAIN', reason: c.reason };
    }
    let absence = null;
    try { absence = await gateway.probeAbsence({ chatId: po.chat_id, messageId: Number(po.message_id) }); } catch (error) { absence = { absent: false, evidence: `PROBE: ${String(error?.code || error?.message || error).slice(0, 120)}` }; }
    if (absence && absence.absent === true) return confirmDeleted(userId, purgeId, po, absence.evidence);
    await markObject(uid, purgeId, po.object_id, { status: 'UNCERTAIN', last_error: `UNPROVEN_AFTER_DELETE: ${absence && absence.evidence}` });
    metrics.objectsUncertain++;
    return { purgeId, objectId: po.object_id, deleted: false, outcome: 'UNCERTAIN', reason: 'UNPROVEN_AFTER_DELETE' };
  }

  // ---------- un paso del job PURGE (worker): catálogo y después limpieza; devuelve si queda trabajo ----------
  async function step({ userId, purgeId } = {}) {
    if (typeof purgeId !== 'string' || !ID_RE.test(purgeId)) throw inputInvalid('PURGE_ID');
    const st = (await pool.query('SELECT status FROM catalog_purges WHERE user_id = $1 AND purge_id = $2', [userId, purgeId]).catch((e) => { throw sqlError(e); })).rows[0];
    if (!st) throw notFound('purge');
    if (st.status === 'ENUMERATING') { const r = await enumerateStep({ userId, purgeId }); return { ...r, more: true }; }
    const r = await cleanupStep({ userId, purgeId });
    return { ...r, status: r.status || st.status, more: !r.none };
  }
  async function getPurge({ userId, purgeId } = {}) {
    if (typeof purgeId !== 'string' || !ID_RE.test(purgeId)) throw inputInvalid('PURGE_ID');
    return readTx(userId, (client, uid) => purgeDto(client, uid, purgeId));
  }
  // cancel: solo detiene la fase de catálogo (lo no enumerado sigue en la papelera). Lo ya eliminado de la biblioteca es definitivo y su
  // limpieza física continúa.
  async function cancelPurge({ userId, era, epoch, purgeId } = {}) {
    if (typeof purgeId !== 'string' || !ID_RE.test(purgeId)) throw inputInvalid('PURGE_ID');
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const p = (await client.query(`${PURGE_SQL} FOR UPDATE`, [uid, purgeId])).rows[0]; if (!p) throw notFound('purge');
      if (p.status !== 'ENUMERATING') return purgeDto(client, uid, purgeId, { changed: false });
      const open = (await client.query("UPDATE catalog_purge_items SET status = 'BLOCKED', block_reason = 'BEAT_STATE' WHERE user_id = $1 AND purge_id = $2 AND status = 'PENDING'", [uid, purgeId])).rowCount;
      await finishPurgeRow(client, uid, purgeId, 'CANCELLED');
      return purgeDto(client, uid, purgeId, { changed: true, stopped: open });
    });
  }
  // Reanudación de la limpieza por evento explícito (operador / CLI): mismas reglas que al pedir una purga.
  async function resumeCleanup({ userId, era, epoch } = {}) {
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => ({ settled: await settlePriorPurging(client, uid, ctx.generation_id, ctx.revision), ...(await resumeCleanupTx(client, uid)) }));
  }
  // ---------- restore_hold: solo con el journal externo reconciliado y cleanup aprobado; al liberarse se reanuda lo diferido ----------
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
      const resumed = await resumeCleanupTx(client, u);
      return { userId: u, restoreHold: false, journalEntries: entries.length, cleanupResumed: resumed.requeued };
    });
  }

  return Object.freeze({ requestPurge, enumerateStep, cleanupStep, step, getPurge, cancelPurge, resumeCleanup, releaseRestoreHold, metrics, PurgeStepError, limits: Object.freeze({ ENUMERATE_BATCH, OBJECT_MAX_ATTEMPTS }) });
}

let configured = null;
function configureCatalogPurge(options = null) { configured = options && options.pool && options.authority ? createCatalogPurge(options) : null; return configured; }
function currentCatalogPurge() { return configured; }

module.exports = { ENUMERATE_BATCH, OBJECT_MAX_ATTEMPTS, BLOCK_REASONS, KEPT_REASONS, DEFERRED_REASONS, PurgeStepError, evaluateBeatBlock, evaluateObjectBlock, classifyProviderError, createCatalogPurge, configureCatalogPurge, currentCatalogPurge };
