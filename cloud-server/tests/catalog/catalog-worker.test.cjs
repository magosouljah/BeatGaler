'use strict';
// T10 — Unidad del worker con operaciones/transporte falsos: concurrencia acotada, clasificación transitorio/permanente, lease fenced,
// reglas de reconciliación (0 → incierto sin reenvío, 1 → adopta, >1 → BLOCKED), shutdown sin borrar jobs. Sin red ni DB.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCatalogWorker, isTransient, WorkerJobError } = require('../../catalog/worker.js');

function fakeOps({ jobs = [], verify = null, commit = null } = {}) {
  const log = [];
  let gen = 0;
  const parts = new Map();
  const pool = { connect: async () => ({}), query: async (sql, params) => {
    if (/FROM catalog_libraries/.test(sql)) return { rows: [{ era: 'era', epoch: '1' }] };
    if (/FROM catalog_operation_parts/.test(sql)) { const p = parts.get(`${params[1]}:${params[2]}`); return { rows: p ? [p] : [] }; }
    if (/FROM catalog_jobs/.test(sql)) return { rows: [{ backlog: jobs.filter((j) => j.state === 'QUEUED').length, leased: 0, blocked: jobs.filter((j) => j.state === 'BLOCKED').length, oldest_age_ms: '0', expired_leases: 0 }] };
    return { rows: [] };
  } };
  const ops = {
    async claimJobs({ owner, limit }) { const out = []; for (const j of jobs) { if (out.length >= limit) break; if (j.state !== 'QUEUED') continue; j.state = 'LEASED'; gen++; j.lease = { owner, generation: String(gen) }; out.push({ ...j, lease: j.lease }); } log.push(['claim', out.map((j) => j.jobId)]); return out; },
    async renewJobLease({ jobId, lease }) { const j = jobs.find((x) => x.jobId === jobId); if (!j || j.lease.generation !== lease.generation) throw Object.assign(new Error('fenced'), { code: 'LEASE_FENCED' }); log.push(['renew', jobId]); return {}; },
    async completeJob({ jobId, lease }) { const j = jobs.find((x) => x.jobId === jobId); if (!j || j.lease.generation !== lease.generation) throw Object.assign(new Error('fenced'), { code: 'LEASE_FENCED' }); j.state = 'DONE'; log.push(['done', jobId]); return {}; },
    async failJob({ jobId, lease, error, transient, retryAfterMs }) { const j = jobs.find((x) => x.jobId === jobId); if (!j || j.lease.generation !== lease.generation) throw Object.assign(new Error('fenced'), { code: 'LEASE_FENCED' }); j.attempts = (j.attempts || 0) + 1; j.state = !transient || j.attempts >= 8 ? 'BLOCKED' : 'QUEUED'; log.push(['fail', jobId, transient, retryAfterMs, error]); return { state: j.state }; },
    async enqueueJob({ jobId, kind, payload, userId, operationId }) { if (jobs.some((j) => j.jobId === jobId)) throw Object.assign(new Error('dup'), { detail: { sqlstate: '23505' } }); jobs.push({ jobId, kind, payload, userId, operationId, state: 'QUEUED' }); log.push(['enqueue', kind, jobId]); return { jobId }; },
    async recordVerification(a) { log.push(['verify', a.partKey, a.lease.generation]); return verify ? verify(a) : { verified: true, ready: true }; },
    async putReceipt(a) { log.push(['receipt', a.partKey, a.receipt.messageId]); return {}; },
    async commitOperation(a) { log.push(['commit', a.operationId]); return commit ? commit(a) : { status: 200, operation: { beatId: 'b1' } }; },
  };
  return { ops, pool, log, jobs, parts, setPart: (op, key, row) => parts.set(`${op}:${key}`, row) };
}
const job = (jobId, kind, payload = {}, extra = {}) => ({ jobId, kind, payload, userId: 'u1', operationId: 'top-1', state: 'QUEUED', ...extra });

test('runOnce: claim acotado por concurrencia global, handlers ejecutan, completan con fencing y encolan el commit cuando todo está verificado', async () => {
  const f = fakeOps({ jobs: [job('j1', 'TRANSFER_VERIFY', { partKey: 'm0' }), job('j2', 'TRANSFER_VERIFY', { partKey: 'm1' }, { userId: 'u2' }), job('j3', 'TRANSFER_VERIFY', { partKey: 'm2' }, { userId: 'u3' })] });
  for (const [k, o] of [['m0', 'top-1'], ['m1', 'top-1'], ['m2', 'top-1']]) f.setPart(o, k, { part_key: k, random_id: '1', sender_id: 'Bot20', chat_id: '-1', declared_size: '10', dispatch_state: 'RECEIPT', receipt_json: JSON.stringify({ messageId: 5 }) });
  const transport = { async verifyMessage({ messageId }) { return { size: 10, sha256: null, messageId }; } };
  const w = createCatalogWorker({ pool: f.pool, operations: f.ops, transport, owner: 'w1', options: { globalConcurrency: 2, renewEveryMs: 10_000 } });
  const r = await w.runOnce();
  assert.equal(r.length, 2, 'solo 2 jobs por pasada (concurrencia global 2)');
  assert.deepEqual(r.map((x) => x.outcome), ['done', 'done']);
  assert.deepEqual(f.jobs.filter((j) => j.kind === 'TRANSFER_COMMIT').length, 1, 'un job de commit idempotente (misma operación)');
  const r2 = await w.runOnce();
  assert.deepEqual(r2.map((x) => [x.jobId, x.outcome]), [['j3', 'done'], ['job-commit-top-1', 'done']]);
  assert.equal(w.metrics.maxConcurrent, 2);
  const h = await w.health();
  assert.deepEqual([h.owner, h.running, h.backlog, h.blocked], ['w1', 0, 0, 0]);
});

test('clasificación de fallos: transitorio → QUEUED con backoff (Retry-After respetado), permanente → BLOCKED inmediato, 8 transitorios → BLOCKED; lease fenced no confirma', async () => {
  assert.equal(isTransient(new WorkerJobError('X', 'x', { transient: false })), false);
  assert.equal(isTransient(Object.assign(new Error('timeout'), { code: 'CATALOG_QUERY_TIMEOUT' })), true);
  assert.equal(isTransient(Object.assign(new Error('perm'), { code: 'FAKE_PERMISSION_DENIED', status: 403 })), false);
  assert.equal(isTransient(Object.assign(new Error('schema'), { code: '42P01' })), false);
  assert.equal(isTransient(Object.assign(new Error('fence'), { code: 'BGL01' })), false);
  assert.equal(isTransient(new Error('network')), true);
  const f = fakeOps({ jobs: [job('t', 'TRANSFER_VERIFY', { partKey: 'm0' }), job('p', 'TRANSFER_VERIFY', { partKey: 'm1' }, { userId: 'u2' })] });
  f.setPart('top-1', 'm0', { part_key: 'm0', random_id: '1', sender_id: 'B', chat_id: '-1', declared_size: '10', dispatch_state: 'RECEIPT', receipt_json: '{"messageId":1}' });
  f.setPart('top-1', 'm1', { part_key: 'm1', random_id: '2', sender_id: 'B', chat_id: '-1', declared_size: '10', dispatch_state: 'RECEIPT', receipt_json: '{"messageId":2}' });
  const transport = { async verifyMessage({ messageId }) { if (messageId === 1) throw Object.assign(new Error('FLOOD_WAIT'), { code: 'FLOOD_WAIT', retryAfterMs: 90_000 }); throw Object.assign(new Error('forbidden'), { code: 'FAKE_PERMISSION_DENIED', status: 403 }); } };
  const w = createCatalogWorker({ pool: f.pool, operations: f.ops, transport, owner: 'w1', options: { globalConcurrency: 4 } });
  const r = await w.runOnce();
  assert.deepEqual(r.map((x) => x.outcome).sort(), ['blocked', 'retry']);
  const fails = f.log.filter((l) => l[0] === 'fail');
  assert.deepEqual(fails.find((l) => l[1] === 't').slice(2, 4), [true, 90_000], 'transitorio con Retry-After');
  assert.deepEqual(fails.find((l) => l[1] === 'p').slice(2, 4), [false, 0], 'permiso → permanente');
  // ocho transitorios → BLOCKED
  for (let i = 0; i < 8; i++) { f.jobs[0].state = 'QUEUED'; await w.runOnce(); }
  assert.equal(f.jobs[0].state, 'BLOCKED');
  // lease robado durante la ejecución: el worker viejo no confirma (fenced) y no marca fallo
  const g = fakeOps({ jobs: [job('s', 'TRANSFER_VERIFY', { partKey: 'm0' })] });
  g.setPart('top-1', 'm0', { part_key: 'm0', random_id: '1', sender_id: 'B', chat_id: '-1', declared_size: '10', dispatch_state: 'RECEIPT', receipt_json: '{"messageId":1}' });
  const slow = { async verifyMessage() { g.jobs[0].lease = { owner: 'other', generation: '99' }; return { size: 10 }; } };
  const w2 = createCatalogWorker({ pool: g.pool, operations: { ...g.ops, async recordVerification() { throw Object.assign(new Error('stale'), { code: 'LEASE_FENCED' }); } }, transport: slow, owner: 'w1' });
  const r2 = await w2.runOnce();
  assert.deepEqual([r2[0].outcome, w2.metrics.fenced, g.log.some((l) => l[0] === 'done' || l[0] === 'fail')], ['fenced', 1, false]);
});

test('reconciliación: 0 coincidencias → incierto (retry 60 s, sin reenvío), 1 → adopta recibo + verifica + encola commit, >1 → BLOCKED; concurrencia por biblioteca 1', async () => {
  const f = fakeOps({ jobs: [job('r0', 'TRANSFER_RECONCILE', { partKey: 'a' }), job('r1', 'TRANSFER_RECONCILE', { partKey: 'b' }, { userId: 'u2', operationId: 'top-2' }), job('r2', 'TRANSFER_RECONCILE', { partKey: 'c' }, { userId: 'u3', operationId: 'top-3' })] });
  f.setPart('top-1', 'a', { part_key: 'a', random_id: '10', sender_id: 'B', chat_id: '-1', declared_size: '10', dispatch_state: 'DISPATCHED', receipt_json: null });
  f.setPart('top-2', 'b', { part_key: 'b', random_id: '11', sender_id: 'B', chat_id: '-1', declared_size: '10', dispatch_state: 'DISPATCHED', receipt_json: null });
  f.setPart('top-3', 'c', { part_key: 'c', random_id: '12', sender_id: 'B', chat_id: '-1', declared_size: '10', dispatch_state: 'DISPATCHED', receipt_json: null });
  const transport = { async searchByRandomId({ randomId }) { return randomId === '10' ? [] : randomId === '11' ? [{ messageId: 77, size: 10, sha256: null }] : [{ messageId: 1, size: 10 }, { messageId: 2, size: 10 }]; }, async verifyMessage() { throw new Error('never'); } };
  const w = createCatalogWorker({ pool: f.pool, operations: f.ops, transport, owner: 'w1', options: { globalConcurrency: 3 } });
  const r = await w.runOnce();
  const by = Object.fromEntries(r.map((x) => [x.jobId, x]));
  assert.deepEqual([by.r0.outcome, by.r1.outcome, by.r2.outcome], ['retry', 'done', 'blocked']);
  assert.deepEqual(f.log.find((l) => l[0] === 'fail' && l[1] === 'r0').slice(2, 4), [true, 60_000], 'incierto: retry acotado, nunca reenvío');
  assert.deepEqual(f.log.filter((l) => l[0] === 'receipt').map((l) => l.slice(1)), [['b', 77]], 'adopción del recibo solo con una coincidencia inequívoca');
  assert.ok(f.jobs.some((j) => j.kind === 'TRANSFER_COMMIT' && j.operationId === 'top-2'));
  assert.equal(w.metrics.reconcileUncertain, 1);
  assert.equal(f.log.filter((l) => l[0] === 'receipt' && l[1] === 'c').length, 0, 'ambiguo: no se elige ni se borra');
  // concurrencia por biblioteca: dos efectos remotos del mismo usuario a la vez → el segundo se reprograma
  const g = fakeOps({ jobs: [job('x', 'TRANSFER_RECONCILE', { partKey: 'a' }), job('y', 'TRANSFER_RECONCILE', { partKey: 'b' })] });
  g.setPart('top-1', 'a', { part_key: 'a', random_id: '1', sender_id: 'B', chat_id: '-1', declared_size: '10', dispatch_state: 'DISPATCHED' });
  g.setPart('top-1', 'b', { part_key: 'b', random_id: '2', sender_id: 'B', chat_id: '-1', declared_size: '10', dispatch_state: 'DISPATCHED' });
  let inflight = 0; let maxInflight = 0;
  const t2 = { async searchByRandomId() { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise((res) => setTimeout(res, 20)); inflight--; return []; } };
  const w2 = createCatalogWorker({ pool: g.pool, operations: g.ops, transport: t2, owner: 'w1', options: { globalConcurrency: 2, perLibraryConcurrency: 1 } });
  const r2 = await w2.runOnce();
  assert.equal(maxInflight, 1, 'un efecto externo por biblioteca');
  assert.ok(r2.some((x) => x.error === 'LIBRARY_BUSY' || x.outcome === 'retry'));
});

test('TRANSFER_COMMIT: 202 → retry (NOT_READY), 200 → done, conflicto → BLOCKED; QUERY_SET_BUILD/OPERATION_STEP continúan con jobs encadenados; stop deja jobs sin borrar', async () => {
  let n = 0;
  const f = fakeOps({ jobs: [job('c', 'TRANSFER_COMMIT'), job('q', 'QUERY_SET_BUILD', { setId: 'qs-1' }, { operationId: null }), job('o', 'OPERATION_STEP', { operationId: 'op-1' }, { operationId: 'op-1' })], commit: () => (++n === 1 ? { status: 202, operation: {} } : { status: 200, operation: { beatId: 'b' } }) });
  const queries = { stepQuerySet: async () => ({ status: 'BUILDING', memberCount: 240 }) };
  const commands = { stepOperation: async () => ({ status: 'RUNNING', progress: {} }) };
  const w = createCatalogWorker({ pool: f.pool, operations: f.ops, queries, commands, transport: null, owner: 'w1', options: { globalConcurrency: 5, stepsPerClaim: 2 } });
  const r = await w.runOnce();
  const by = Object.fromEntries(r.map((x) => [x.jobId, x]));
  assert.deepEqual([by.c.outcome, by.c.error, by.q.outcome, by.o.outcome], ['retry', 'NOT_READY', 'done', 'done']);
  assert.ok(f.jobs.some((j) => j.jobId === 'q-c1' && j.kind === 'QUERY_SET_BUILD'), 'continuación encadenada del conjunto');
  assert.ok(f.jobs.some((j) => j.jobId === 'o-c1' && j.kind === 'OPERATION_STEP'));
  f.jobs.find((j) => j.jobId === 'c').state = 'QUEUED';
  const r2 = await w.runOnce();
  assert.equal(r2.find((x) => x.jobId === 'c').outcome, 'done');
  const g = fakeOps({ jobs: [job('k', 'TRANSFER_COMMIT')], commit: () => { throw Object.assign(new Error('v'), { code: 'VERSION_CONFLICT' }); } });
  const wg = createCatalogWorker({ pool: g.pool, operations: g.ops, owner: 'w1' });
  assert.equal((await wg.runOnce())[0].outcome, 'blocked');
  // start/stop: el bucle se detiene y los jobs no desaparecen
  const h = fakeOps({ jobs: [] });
  const wh = createCatalogWorker({ pool: h.pool, operations: h.ops, owner: 'w1', options: { pollMs: 5 } });
  wh.start(); await new Promise((res) => setTimeout(res, 30)); await wh.stop();
  assert.ok(h.log.filter((l) => l[0] === 'claim').length >= 1);
  assert.equal((await wh.health()).stopped, true);
  assert.throws(() => createCatalogWorker({ pool: h.pool }), /operations/);
});
