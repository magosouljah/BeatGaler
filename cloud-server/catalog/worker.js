'use strict';
// T10 — Worker durable con leases (CONTRATO C8; TAREAS §T10; MATRIZ-T §T10). Programa los pasos invocables de T06/T07/T09:
//  - claim FOR UPDATE SKIP LOCKED (≤10), lease 60 s con lease_generation creciente, COMMIT y release antes de ejecutar;
//  - concurrencia 2 global y 1 por biblioteca para efectos externos; renovación de lease en transacción independiente;
//  - ningún cliente SQL retenido mientras se espera al transporte: la verificación/búsqueda remota corre fuera de toda transacción y
//    su resultado se guarda con fencing (owner + generation + época) → un worker viejo no confirma nada;
//  - dispatch incierto → RECONCILE: cero resultados no demuestra que no se envió; múltiples → BLOCKED; nunca reenvío automático;
//  - backoff exponencial con jitter (≤15 min, FLOOD_WAIT/Retry-After manda), 8 transitorios → BLOCKED, permanentes → BLOCKED inmediato;
//  - shutdown deja checkpoint y lease (expiran solos); health: backlog, oldest_age, blocked, leased, running.
// El transporte es una interfaz inyectada (gateway T11); aquí nunca se envía nada: solo verify/search sobre identidades ya persistidas.

const crypto = require('crypto');

const DEFAULTS = Object.freeze({ claimMax: 10, leaseMs: 60_000, renewEveryMs: 20_000, globalConcurrency: 2, perLibraryConcurrency: 1, pollMs: 1000, stepsPerClaim: 4 });
const KINDS = Object.freeze(['TRANSFER_VERIFY', 'TRANSFER_COMMIT', 'TRANSFER_RECONCILE', 'QUERY_SET_BUILD', 'OPERATION_STEP', 'PURGE']);

class WorkerJobError extends Error {
  constructor(code, message, { transient = true, retryAfterMs = 0 } = {}) { super(message); this.name = 'WorkerJobError'; this.code = code; this.transient = transient; this.retryAfterMs = retryAfterMs; }
}
const isTransient = (error) => {
  if (error instanceof WorkerJobError) return error.transient;
  const code = error && error.code;
  if (['CATALOG_QUERY_TIMEOUT', 'CATALOG_UNAVAILABLE', 'LEASE_FENCED', 'FAKE_RESPONSE_LOST', 'FAKE_WORKER_KILLED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) return true;
  if (error && (error.status === 403 || error.status === 404 || error.code === 'FAKE_PERMISSION_DENIED' || error.code === 'FAKE_NOT_FOUND')) return false; // permisos/esquema/integridad → BLOCKED inmediato
  if (error && typeof error.code === 'string' && /^(42|23|BG)/.test(error.code)) return false;
  return true;
};
const retryAfterOf = (error) => Number(error?.retryAfterMs || error?.retry_after_ms || (error?.seconds ? error.seconds * 1000 : 0)) || 0;

function createCatalogWorker({ pool, operations, queries = null, commands = null, transport = null, owner = `worker-${crypto.randomBytes(4).toString('hex')}`, options = {}, log = () => {}, now = () => Date.now(), setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createCatalogWorker requires a pool');
  if (!operations) throw new Error('createCatalogWorker requires catalog operations');
  const o = { ...DEFAULTS, ...options };
  let stopped = true; let timer = null; let loopPromise = null; let wake = null;
  const running = new Map(); // jobId → { userId, kind, startedAt }
  const perLibrary = new Map(); // userId → count de efectos externos en curso
  const metrics = { claimed: 0, done: 0, failed: 0, blocked: 0, fenced: 0, renewals: 0, reconcileUncertain: 0, remoteCalls: 0, maxConcurrent: 0 };

  // Contexto de biblioteca (era/época) para las llamadas de módulo: se lee en una consulta corta; nunca se retiene conexión.
  async function libraryHeaders(userId) {
    const r = await pool.query('SELECT authority_era::text AS era, authority_epoch::text AS epoch FROM catalog_libraries WHERE user_id = $1', [userId]);
    if (!r.rows.length) throw new WorkerJobError('LIBRARY_MISSING', `library ${userId} not found`, { transient: false });
    return { userId, era: r.rows[0].era, epoch: r.rows[0].epoch };
  }
  async function partIdentity(userId, operationId, partKey) {
    const r = await pool.query(`SELECT p.part_key, p.random_id, p.sender_id, p.chat_id, p.declared_size::text AS declared_size, p.declared_sha256, p.dispatch_state, p.receipt_json, p.provider_message_id::text AS message_id
      FROM catalog_operation_parts p WHERE p.user_id = $1 AND p.operation_id = $2 AND p.part_key = $3`, [userId, operationId, partKey]);
    if (!r.rows.length) throw new WorkerJobError('PART_MISSING', 'part not found', { transient: false });
    return r.rows[0];
  }
  // Efecto remoto: nunca dentro de una transacción ni con cliente del pool retenido (C1.5). Límite por biblioteca.
  async function remote(userId, fn) {
    const inLib = perLibrary.get(userId) || 0;
    if (inLib >= o.perLibraryConcurrency) throw new WorkerJobError('LIBRARY_BUSY', 'another external effect is running for this library', { transient: true, retryAfterMs: 2000 });
    perLibrary.set(userId, inLib + 1); metrics.remoteCalls++;
    try { return await fn(); } finally { const n = (perLibrary.get(userId) || 1) - 1; if (n <= 0) perLibrary.delete(userId); else perLibrary.set(userId, n); }
  }

  const handlers = {
    // Verificación del proveedor independiente del recibo (C7.5): leer remoto fuera de SQL, luego checkpoint con fencing.
    async TRANSFER_VERIFY(job) {
      if (!transport || typeof transport.verifyMessage !== 'function') throw new WorkerJobError('TRANSPORT_UNAVAILABLE', 'no transport gateway configured', { transient: true, retryAfterMs: 30_000 });
      const partKey = job.payload.partKey;
      const part = await partIdentity(job.userId, job.operationId, partKey);
      if (part.dispatch_state === 'VERIFIED') return { skipped: 'ALREADY_VERIFIED' };
      if (part.dispatch_state !== 'RECEIPT') throw new WorkerJobError('NO_RECEIPT', 'part has no receipt yet', { transient: true, retryAfterMs: 5000 });
      const receipt = JSON.parse(part.receipt_json);
      const evidence = await remote(job.userId, () => transport.verifyMessage({ chatId: part.chat_id, messageId: Number(receipt.messageId), randomId: part.random_id, senderId: part.sender_id, declaredSize: Number(part.declared_size), declaredSha256: part.declared_sha256 }));
      if (!evidence || !Number.isSafeInteger(evidence.size)) throw new WorkerJobError('VERIFY_INCONCLUSIVE', 'provider returned no usable evidence', { transient: true });
      const r = await operations.recordVerification({ userId: job.userId, operationId: job.operationId, partKey, evidence: { size: evidence.size, sha256: evidence.sha256 ?? null, provider: evidence.provider ?? 'telegram', messageId: Number(receipt.messageId) }, lease: { jobId: job.jobId, owner, generation: job.lease.generation } });
      if (r.ready) await operations.enqueueJob({ userId: job.userId, kind: 'TRANSFER_COMMIT', operationId: job.operationId, payload: { reason: 'READY' }, jobId: `job-commit-${job.operationId}` }).catch((e) => { if (e?.detail?.sqlstate !== '23505') throw e; });
      return { verified: true, ready: r.ready };
    },
    // Commit idempotente (C7.6): 202 → pendiente (reintento con backoff), 200 → DONE; conflicto → BLOCKED visible.
    async TRANSFER_COMMIT(job) {
      const h = await libraryHeaders(job.userId);
      let r;
      try { r = await operations.commitOperation({ ...h, operationId: job.operationId }); } catch (error) {
        if (error && ['VERSION_CONFLICT', 'RESERVATION_EXPIRED', 'RESERVATION_INVALID', 'QUOTA_EXCEEDED', 'OPERATION_TRANSITION_INVALID', 'CATALOG_EPOCH_STALE'].includes(error.code)) throw new WorkerJobError(error.code, error.message, { transient: false });
        throw error;
      }
      if (r.status === 202) throw new WorkerJobError('NOT_READY', 'verification pending', { transient: true, retryAfterMs: 5000 });
      return { committed: true, beatId: r.operation.beatId };
    },
    // Reconciliación (C7.7–8): buscar evidencia por identidad persistida; 0 → sigue RECONCILE (no se reenvía); 1 → adopta recibo y verifica; >1 → BLOCKED.
    async TRANSFER_RECONCILE(job) {
      if (!transport || typeof transport.searchByRandomId !== 'function') throw new WorkerJobError('TRANSPORT_UNAVAILABLE', 'no transport gateway configured', { transient: true, retryAfterMs: 30_000 });
      const partKey = job.payload.partKey;
      const part = await partIdentity(job.userId, job.operationId, partKey);
      if (part.dispatch_state === 'VERIFIED') return { skipped: 'ALREADY_VERIFIED' };
      const found = await remote(job.userId, () => transport.searchByRandomId({ chatId: part.chat_id, senderId: part.sender_id, randomId: part.random_id, declaredSize: Number(part.declared_size), declaredSha256: part.declared_sha256 }));
      const matches = Array.isArray(found) ? found : [];
      if (matches.length > 1) throw new WorkerJobError('RECONCILE_AMBIGUOUS', 'multiple provider matches for the same random_id', { transient: false });
      if (matches.length === 0) { metrics.reconcileUncertain++; throw new WorkerJobError('RECONCILE_UNCERTAIN', 'no provider evidence yet; dispatch stays uncertain (no resend)', { transient: true, retryAfterMs: 60_000 }); }
      const h = await libraryHeaders(job.userId);
      const m = matches[0];
      if (part.dispatch_state !== 'RECEIPT') await operations.putReceipt({ ...h, operationId: job.operationId, partKey, receipt: { messageId: m.messageId, documentId: m.documentId ?? null, size: m.size, chatId: part.chat_id } });
      const r = await operations.recordVerification({ userId: job.userId, operationId: job.operationId, partKey, evidence: { size: m.size, sha256: m.sha256 ?? null, provider: 'telegram', messageId: m.messageId, reconciled: true }, lease: { jobId: job.jobId, owner, generation: job.lease.generation } });
      if (r.ready) await operations.enqueueJob({ userId: job.userId, kind: 'TRANSFER_COMMIT', operationId: job.operationId, payload: { reason: 'RECONCILED' }, jobId: `job-commit-${job.operationId}` }).catch((e) => { if (e?.detail?.sqlstate !== '23505') throw e; });
      return { reconciled: true, ready: r.ready };
    },
    // Construcción de conjuntos (T06): hasta stepsPerClaim lotes por claim; BUILDING restante → re-encolar; READY/STALE → DONE.
    async QUERY_SET_BUILD(job) {
      if (!queries) throw new WorkerJobError('QUERIES_UNAVAILABLE', 'queries module not configured', { transient: true });
      let last = null;
      for (let i = 0; i < o.stepsPerClaim; i++) {
        last = await queries.stepQuerySet({ userId: job.userId, setId: job.payload.setId, batch: 240 });
        if (last.status !== 'BUILDING') return { status: last.status, memberCount: last.memberCount };
      }
      const n = (job.payload.continuation || 0) + 1; const root = job.payload.root || job.jobId;
      await operations.enqueueJob({ userId: job.userId, kind: 'QUERY_SET_BUILD', payload: { ...job.payload, continuation: n, root }, jobId: `${root}-c${n}`.slice(0, 64) }).catch((e) => { if (e?.detail?.sqlstate !== '23505') throw e; });
      return { status: 'BUILDING', memberCount: last.memberCount, continued: true };
    },
    // Lotes de operaciones bulk/rename (T07): un paso por iteración, CONFLICT/CANCELLED/PARTIAL/COMPLETED terminan el job.
    async OPERATION_STEP(job) {
      if (!commands) throw new WorkerJobError('COMMANDS_UNAVAILABLE', 'commands module not configured', { transient: true });
      const h = await libraryHeaders(job.userId);
      let last = null;
      for (let i = 0; i < o.stepsPerClaim; i++) {
        last = await commands.stepOperation({ ...h, operationId: job.payload.operationId || job.operationId, batch: 50 });
        if (!['QUEUED', 'RUNNING'].includes(last.status)) return { status: last.status, progress: last.progress };
      }
      const n = (job.payload.continuation || 0) + 1; const root = job.payload.root || job.jobId;
      await operations.enqueueJob({ userId: job.userId, kind: 'OPERATION_STEP', operationId: job.operationId, payload: { ...job.payload, continuation: n, root }, jobId: `${root}-c${n}`.slice(0, 64) }).catch((e) => { if (e?.detail?.sqlstate !== '23505') throw e; });
      return { status: last.status, continued: true };
    },
    async PURGE() { throw new WorkerJobError('NOT_IMPLEMENTED', 'purge jobs are delivered by T15', { transient: false }); },
  };

  // Renovación periódica del lease mientras el handler trabaja (transacción propia; nunca la conexión retenida del claim).
  function keepAlive(job) {
    let active = true; let t = null;
    const tick = async () => { if (!active) return; try { await operations.renewJobLease({ jobId: job.jobId, lease: job.lease, leaseMs: o.leaseMs }); metrics.renewals++; } catch (e) { active = false; job.fenced = true; return; } t = setTimeoutImpl(tick, o.renewEveryMs); };
    t = setTimeoutImpl(tick, o.renewEveryMs);
    return () => { active = false; if (t) clearTimeoutImpl(t); };
  }
  async function execute(job) {
    running.set(job.jobId, { userId: job.userId, kind: job.kind, startedAt: now() });
    metrics.maxConcurrent = Math.max(metrics.maxConcurrent, running.size);
    const stop = keepAlive(job);
    try {
      const handler = handlers[job.kind];
      if (!handler) throw new WorkerJobError('UNKNOWN_KIND', `no handler for ${job.kind}`, { transient: false });
      const result = await handler(job);
      if (job.fenced) { metrics.fenced++; return { jobId: job.jobId, outcome: 'fenced' }; }
      await operations.completeJob({ jobId: job.jobId, lease: job.lease });
      metrics.done++;
      return { jobId: job.jobId, outcome: 'done', result };
    } catch (error) {
      if (error && error.code === 'LEASE_FENCED') { metrics.fenced++; return { jobId: job.jobId, outcome: 'fenced' }; }
      const transient = isTransient(error);
      try {
        const f = await operations.failJob({ jobId: job.jobId, lease: job.lease, error: `${error?.code || 'ERROR'}: ${error?.message || error}`, transient, retryAfterMs: retryAfterOf(error) });
        if (f.state === 'BLOCKED') metrics.blocked++; else metrics.failed++;
        log('[catalog-worker] job failed', { jobId: job.jobId, kind: job.kind, code: error?.code, transient, state: f.state });
        return { jobId: job.jobId, outcome: f.state === 'BLOCKED' ? 'blocked' : 'retry', error: error?.code };
      } catch (inner) {
        if (inner && inner.code === 'LEASE_FENCED') { metrics.fenced++; return { jobId: job.jobId, outcome: 'fenced' }; }
        throw inner;
      }
    } finally { stop(); running.delete(job.jobId); }
  }
  // Una pasada: claim (COMMIT y release antes de ejecutar) y ejecución con concurrencia global acotada.
  async function runOnce({ kinds = null } = {}) {
    const room = Math.max(0, o.globalConcurrency - running.size);
    if (room === 0) return [];
    const jobs = await operations.claimJobs({ owner, limit: Math.min(o.claimMax, room), leaseMs: o.leaseMs, kinds });
    metrics.claimed += jobs.length;
    return Promise.all(jobs.map((j) => execute(j)));
  }
  async function loop() {
    while (!stopped) {
      try { await runOnce(); } catch (error) { log('[catalog-worker] loop error', error?.message || error); }
      if (stopped) break;
      await new Promise((r) => { wake = r; timer = setTimeoutImpl(() => { timer = null; wake = null; r(); }, o.pollMs); });
    }
  }
  function start() { if (!stopped) return; stopped = false; loopPromise = loop(); }
  // Parada: deja de reclamar, espera a los handlers en curso (sus leases y checkpoints quedan durables); no borra jobs.
  async function stop() { stopped = true; if (timer) { clearTimeoutImpl(timer); timer = null; } if (wake) { const w = wake; wake = null; w(); } await loopPromise?.catch(() => {}); loopPromise = null; while (running.size) await new Promise((r) => setTimeoutImpl(r, 20)); }
  async function health() {
    const r = await pool.query(`SELECT count(*) FILTER (WHERE state = 'QUEUED')::int AS backlog, count(*) FILTER (WHERE state = 'LEASED')::int AS leased, count(*) FILTER (WHERE state = 'BLOCKED')::int AS blocked,
      coalesce(extract(epoch FROM (now() - min(created_at) FILTER (WHERE state IN ('QUEUED', 'LEASED')))) * 1000, 0)::bigint AS oldest_age_ms,
      count(*) FILTER (WHERE state = 'LEASED' AND lease_until <= now())::int AS expired_leases FROM catalog_jobs`);
    const row = r.rows[0];
    return { owner, running: running.size, backlog: row.backlog, leased: row.leased, blocked: row.blocked, oldestAgeMs: Number(row.oldest_age_ms), expiredLeases: row.expired_leases, metrics: { ...metrics }, stopped };
  }
  return Object.freeze({ owner, options: o, runOnce, start, stop, health, execute, handlers, metrics, WorkerJobError });
}

module.exports = { DEFAULTS, KINDS, WorkerJobError, isTransient, createCatalogWorker };
