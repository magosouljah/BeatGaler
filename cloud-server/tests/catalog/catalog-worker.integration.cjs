'use strict';
// T10 — Worker con leases contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T10`): dos workers nunca confirman el mismo job
// con token viejo; fake lento (30 s de reloj) no retiene cliente SQL y la metadata de otra biblioteca sigue; caída antes/después de
// claim/dispatch/recibo/commit → recuperación determinista (RECONCILE para envío incierto, nunca reenvío); conjuntos y bulk reanudan tras
// "reinicio" sin recalcular miembros; health/backlog. No es G2 real.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const operations = require('../../catalog/operations.js');
const queries = require('../../catalog/queries.js');
const commands = require('../../catalog/commands.js');
const codec = require('../../catalog/legacy-codec.js');
const { rebuildDerivedProjections } = require('../../catalog/staging.js');
const { createCatalogWorker } = require('../../catalog/worker.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const H = crypto.createHash('sha256').update('x').digest('hex');
let seq = 0; let keyN = 0;
const key = () => `k-${++keyN}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function withDb(fn, { max = 10 } = {}) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max });
  try {
    await mig.applyMigrations(pool);
    await pool.query("INSERT INTO transport_bots(id) VALUES ('Bot20') ON CONFLICT DO NOTHING");
    await pool.query(`INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory) VALUES ('lab', 'run-1', '["Bot20"]', 'FRESH_BOTS', $1, '[]')`, [H]);
    return await fn(pool, h);
  } finally { await pool.end(); await h.cleanup(); }
}
const auth = (pool) => authority.createCatalogAuthority({ pool, env: ENV_ON, controlPlaneAuthority: 'postgres' });
function modules(pool, maxBeats = null) {
  const a = auth(pool);
  return {
    ops: operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats }) }),
    q: queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] }),
    cmd: commands.createCatalogCommands({ pool, authority: a }),
  };
}
async function nativeLibrary(pool) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, era: ctx.authority_era, epoch: ctx.authority_epoch, generationId: ctx.generation_id };
}
async function seedBeats(pool, lib, n) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (let i = 0; i < n; i++) {
      const beat = { id: `b${String(i).padStart(4, '0')}`, name: `Beat ${i}`, bpm: '120', key: 'Cm', rating: i % 5, tags: ['all'] };
      const p = codec.projectBeat(beat); const json = JSON.stringify(beat);
      await c.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, bpm_sort_class, bpm_sort, manual_rank, has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display)
        VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [lib.userId, lib.generationId, beat.id, p.name, p.bpmText, p.keyText, p.rating, p.bpmSortClass, p.bpmSort, String(i * 1000), json, sha(json), Buffer.byteLength(json, 'utf8'), p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay]);
      for (const t of p.tags) await c.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [lib.userId, lib.generationId, beat.id, t.position, t.label, t.normKey, t.searchKey]);
    }
    await c.query('UPDATE catalog_libraries SET active_count = $2 WHERE user_id = $1', [lib.userId, n]);
    await rebuildDerivedProjections(c, lib); await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
const master = () => ({ partKey: 'm0', slotKey: 'MASTER', role: 'MASTER', partIndex: 0, size: 1000, sha256: sha('bytes'), filename: 'beat.mp3', mime: 'audio/mpeg' });
// Muestrea el pool: un cliente retenido durante el efecto remoto se vería en todas las muestras; la renovación breve del lease, no.
const settlesIdle = async (pool, samples = 10) => { for (let i = 0; i < samples; i++) { if (pool.totalCount - pool.idleCount === 0) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };
const jobsOf = async (pool, uid) => (await pool.query('SELECT job_id, kind, state, lease_generation::text AS g, attempts, lease_owner FROM catalog_jobs WHERE user_id = $1 ORDER BY created_at, job_id', [uid])).rows;
// Transporte fake: verificación/búsqueda por identidad persistida con pausas y recuentos (gateway T11 simulado).
function fakeGateway({ verifyDelayMs = 0, messages = new Map() } = {}) {
  const calls = { verify: 0, search: 0, inflight: 0, maxInflight: 0 };
  let gate = null; let open = null;
  return {
    calls, messages,
    hold() { gate = new Promise((r) => { open = r; }); }, release() { open?.(); gate = null; },
    async verifyMessage({ messageId, declaredSize }) { calls.verify++; calls.inflight++; calls.maxInflight = Math.max(calls.maxInflight, calls.inflight); try { if (gate) await gate; if (verifyDelayMs) await new Promise((r) => setTimeout(r, verifyDelayMs)); const m = messages.get(messageId); if (!m) throw Object.assign(new Error('not found'), { code: 'FAKE_NOT_FOUND', status: 404 }); return { size: m.size ?? declaredSize, sha256: m.sha256 ?? null }; } finally { calls.inflight--; } },
    async proveUniqueMatch() { return true; }, // modela un transporte con prueba de archivo correcto y único (E5 opción A; el gateway de búsqueda real no la tiene)
    async searchByRandomId({ randomId }) { calls.search++; return [...messages.values()].filter((m) => m.randomId === randomId).map((m) => ({ messageId: m.messageId, size: m.size, sha256: m.sha256 ?? null })); },
  };
}

test('dos workers: cada job lo adquiere exactamente uno; lease vencido → generación +1 y el worker retrasado no confirma; recibo → verificación por worker → commit automático; health', () => withDb(async (pool, h) => {
  const lib = await nativeLibrary(pool); const { ops } = modules(pool, 10);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const gw = fakeGateway({ messages: new Map([[101, { messageId: 101, size: 1000, sha256: sha('bytes'), randomId: null }]]) });
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [master()], metadata: { name: 'W' } } });
  await ops.markDispatched({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  await ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: 'm0', receipt: { messageId: 101, size: 1000 } });
  let jobs = await jobsOf(pool, lib.userId);
  assert.deepEqual(jobs.map((j) => [j.kind, j.state]), [['TRANSFER_VERIFY', 'QUEUED']], 'el recibo encola la verificación en la misma transacción');
  // commit del cliente antes de verificar → 202 + job de commit
  assert.equal((await ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 202);
  jobs = await jobsOf(pool, lib.userId);
  assert.deepEqual(jobs.map((j) => j.kind).sort(), ['TRANSFER_COMMIT', 'TRANSFER_VERIFY']);
  // dos workers en pools distintos reclaman a la vez: cada job va a uno solo
  const pools = [new Pool({ ...h.config, max: 4 }), new Pool({ ...h.config, max: 4 })];
  try {
    gw.hold();
    const workers = pools.map((p, i) => createCatalogWorker({ pool: p, operations: operations.createCatalogOperations({ pool: p, authority: auth(p), resolveAccess: async () => ({ maxBeats: 10 }) }), transport: gw, owner: `w${i}`, options: { globalConcurrency: 2, renewEveryMs: 50 } }));
    const runs = workers.map((w) => w.runOnce());
    await new Promise((r) => setTimeout(r, 100));
    const leased = await jobsOf(pool, lib.userId);
    const verifyJob = leased.find((j) => j.kind === 'TRANSFER_VERIFY');
    assert.deepEqual([verifyJob.state, Boolean(verifyJob.lease_owner)], ['LEASED', true], 'la verificación está arrendada por exactamente un worker mientras el proveedor no responde');
    assert.ok(leased.every((j) => j.state !== 'LEASED' || /^w[01]$/.test(j.lease_owner)));
    // mientras el verificador espera al proveedor, ningún cliente SQL del worker está retenido (C1.5)
    assert.ok(pools.every((p) => p.totalCount - p.idleCount <= 0), 'sin conexiones retenidas durante el efecto remoto');
    gw.release();
    const results = (await Promise.all(runs)).flat();
    const outcomes = Object.fromEntries(results.map((r) => [r.jobId, r.outcome]));
    assert.equal(outcomes[`job-verify-${op.operationId}-m0`], 'done');
    // el commit pudo correr antes de la verificación (202 → retry) o después (done); en todo caso la operación termina COMMITTED tras otra pasada
    for (const w of workers) await w.runOnce();
    await pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1", [lib.userId]);
    for (const w of workers) await w.runOnce();
    const final = await ops.getOperation({ userId: lib.userId, operationId: op.operationId });
    assert.equal(final.status, 'COMMITTED');
    jobs = await jobsOf(pool, lib.userId);
    assert.ok(jobs.every((j) => j.state === 'DONE'), JSON.stringify(jobs));
    assert.equal(gw.calls.verify, 1, 'una sola verificación remota');
    // lease vencido: un worker lento retiene el lease (generación 1); vence; otro worker lo reclama con generación 2 y completa; el lento queda fenced
    await ops.enqueueJob({ userId: lib.userId, kind: 'TRANSFER_COMMIT', operationId: op.operationId, payload: { late: true }, jobId: 'job-late' });
    const slowOps = operations.createCatalogOperations({ pool: pools[0], authority: auth(pools[0]), resolveAccess: async () => ({ maxBeats: 10 }) });
    const [late] = await slowOps.claimJobs({ owner: 'slow', limit: 10, kinds: ['TRANSFER_COMMIT'] });
    assert.deepEqual([late.jobId, late.lease.generation], ['job-late', '1']);
    await pool.query("UPDATE catalog_jobs SET lease_until = now() - interval '1 second' WHERE job_id = 'job-late'");
    const r = await workers[1].runOnce();
    assert.equal(r.find((x) => x.jobId === 'job-late')?.outcome, 'done', 'el commit repetido es replay idempotente');
    await assert.rejects(slowOps.completeJob({ jobId: 'job-late', lease: late.lease }), (e) => e.code === 'LEASE_FENCED', 'el worker retrasado no confirma con token viejo');
    assert.equal((await jobsOf(pool, lib.userId)).find((j) => j.job_id === 'job-late').g, '2');
    const health = await workers[0].health();
    assert.deepEqual([health.running, health.backlog, health.blocked, health.leased], [0, 0, 0, 0]);
  } finally { await Promise.all(pools.map((p) => p.end())); }
}));

test('fake lento: con el proveedor pausado, una mutación de metadata de otra biblioteca completa en paralelo y el pool del worker no retiene clientes; FLOOD_WAIT respeta Retry-After', () => withDb(async (pool, h) => {
  const a = await nativeLibrary(pool); const b = await nativeLibrary(pool);
  const { ops, cmd } = modules(pool, 10);
  await seedBeats(pool, b, 3);
  const hdrA = { userId: a.userId, era: a.era, epoch: a.epoch }; const hdrB = { userId: b.userId, era: b.era, epoch: b.epoch };
  const gw = fakeGateway({ messages: new Map([[7, { messageId: 7, size: 1000 }]]) });
  const op = await ops.createOperation({ ...hdrA, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [master()], metadata: { name: 'Slow' } } });
  await ops.markDispatched({ ...hdrA, operationId: op.operationId, partKey: 'm0' });
  await ops.putReceipt({ ...hdrA, operationId: op.operationId, partKey: 'm0', receipt: { messageId: 7, size: 1000 } });
  const wpool = new Pool({ ...h.config, max: 2 });
  try {
    const w = createCatalogWorker({ pool: wpool, operations: operations.createCatalogOperations({ pool: wpool, authority: auth(wpool), resolveAccess: async () => ({ maxBeats: 10 }) }), transport: gw, owner: 'slow', options: { renewEveryMs: 30 } });
    gw.hold();
    const run = w.runOnce();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(gw.calls.inflight, 1, 'el efecto remoto está en curso');
    assert.ok(await settlesIdle(wpool), 'ningún cliente SQL retenido por el efecto remoto (la renovación de lease usa un cliente propio y breve)');
    const patched = await cmd.patchBeat({ ...hdrB, beatId: 'b0000', idempotencyKey: key(), expectedVersion: '1', patch: { rating: 3 } });
    assert.equal(patched.beat.version, '2', 'la metadata de otra biblioteca sigue completando');
    await new Promise((r) => setTimeout(r, 70));
    const lease = (await pool.query("SELECT lease_until > now() + interval '55 seconds' AS fresh FROM catalog_jobs WHERE job_id = $1", [`job-verify-${op.operationId}-m0`])).rows[0];
    assert.equal(lease.fresh, true, 'el lease se renueva en transacción propia durante el efecto');
    gw.release();
    const r = await run;
    assert.equal(r[0].outcome, 'done');
    // FLOOD_WAIT: Retry-After mayor que el backoff manda
    const op2 = await ops.createOperation({ ...hdrA, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [master()], metadata: { name: 'Flood' } } });
    await ops.markDispatched({ ...hdrA, operationId: op2.operationId, partKey: 'm0' });
    await ops.putReceipt({ ...hdrA, operationId: op2.operationId, partKey: 'm0', receipt: { messageId: 8, size: 1000 } });
    const flood = { async verifyMessage() { throw Object.assign(new Error('FLOOD_WAIT_120'), { code: 'FLOOD_WAIT', retryAfterMs: 120_000 }); } };
    const wf = createCatalogWorker({ pool: wpool, operations: operations.createCatalogOperations({ pool: wpool, authority: auth(wpool), resolveAccess: async () => ({ maxBeats: 10 }) }), transport: flood, owner: 'flood' });
    const rf = await wf.runOnce();
    assert.equal(rf.find((x) => x.jobId === `job-verify-${op2.operationId}-m0`).outcome, 'retry');
    const next = (await pool.query("SELECT next_attempt_at > now() + interval '110 seconds' AS later, state FROM catalog_jobs WHERE job_id = $1", [`job-verify-${op2.operationId}-m0`])).rows[0];
    assert.deepEqual([next.later, next.state], [true, 'QUEUED']);
  } finally { await wpool.end(); }
}));

test('caídas en cada frontera: antes/después de claim, tras despacho sin recibo (cancel → RECONCILE → 0 coincidencias = incierto, 1 = adopta), tras recibo, tras commit (replay) — recuperación determinista sin reenvío', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { ops } = modules(pool, 10);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const gw = fakeGateway();
  const mk = (owner) => createCatalogWorker({ pool, operations: ops, transport: gw, owner, options: { renewEveryMs: 10_000 } });
  // (1) muerte antes de claim: el job sigue QUEUED y lo toma el siguiente worker
  const op1 = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [master()], metadata: { name: 'c1' } } });
  await ops.markDispatched({ ...hdr, operationId: op1.operationId, partKey: 'm0' });
  await ops.putReceipt({ ...hdr, operationId: op1.operationId, partKey: 'm0', receipt: { messageId: 11, size: 1000 } });
  gw.messages.set(11, { messageId: 11, size: 1000 });
  assert.deepEqual((await jobsOf(pool, lib.userId)).map((j) => j.state), ['QUEUED']);
  // (2) muerte después de claim: lease abandonado → tras vencer, otro worker lo reclama (generación 2) y completa
  const abandoned = await ops.claimJobs({ owner: 'dead', limit: 1 });
  assert.equal(abandoned.length, 1);
  await pool.query("UPDATE catalog_jobs SET lease_until = now() - interval '1 second' WHERE job_id = $1", [abandoned[0].jobId]);
  const r2 = await mk('alive').runOnce();
  assert.deepEqual([r2[0].outcome, (await jobsOf(pool, lib.userId))[0].g], ['done', '2']);
  // (3) muerte tras despacho, antes del recibo: cancel → RECONCILE; sin evidencia → incierto (retry, nunca reenvío); con evidencia única → adopta y commit
  const op3 = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [master()], metadata: { name: 'c3' } } });
  const d = await ops.markDispatched({ ...hdr, operationId: op3.operationId, partKey: 'm0' });
  const rc = await ops.cancelOperation({ ...hdr, operationId: op3.operationId });
  assert.equal(rc.status, 'RECONCILE');
  const rj = (await jobsOf(pool, lib.userId)).find((j) => j.kind === 'TRANSFER_RECONCILE');
  assert.ok(rj, 'job de reconciliación encolado con el cancel');
  const w3 = mk('w3');
  const first = await w3.runOnce();
  assert.equal(first.find((x) => x.jobId === rj.job_id).outcome, 'retry', '0 coincidencias: incierto, sin reenvío');
  assert.equal((await ops.getOperation({ userId: lib.userId, operationId: op3.operationId })).status, 'RECONCILE');
  gw.messages.set(33, { messageId: 33, size: 1000, randomId: d.randomId });
  await pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE job_id = $1", [rj.job_id]);
  const second = await w3.runOnce();
  assert.equal(second.find((x) => x.jobId === rj.job_id).outcome, 'done');
  const after3 = await ops.getOperation({ userId: lib.userId, operationId: op3.operationId });
  assert.deepEqual([after3.status, after3.parts[0].dispatchState], ['READY', 'VERIFIED'], 'recibo adoptado por identidad y verificado');
  await w3.runOnce(); // commit encolado por la reconciliación
  assert.equal((await ops.getOperation({ userId: lib.userId, operationId: op3.operationId })).status, 'COMMITTED');
  // (4) muerte tras commit, antes de la respuesta: el job de commit repetido es replay idempotente
  const again = await ops.commitOperation({ ...hdr, operationId: op3.operationId });
  assert.deepEqual([again.status, again.operation.replay], [200, true]);
  const counts = (await pool.query('SELECT active_count::int AS a, pending_count::int AS p FROM catalog_libraries WHERE user_id = $1', [lib.userId])).rows[0];
  assert.deepEqual(counts, { a: 2, p: 0 }, 'contadores exactos tras ambas recuperaciones');
  assert.equal(gw.calls.search, 2);
}));

test('conjuntos y bulk reanudan tras "reinicio" del worker sin recalcular miembros: jobs encadenados, checkpoint por frontera, health con backlog y BLOCKED', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { ops, q, cmd } = modules(pool, null);
  await seedBeats(pool, lib, 700);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const set = await q.createQuerySet({ userId: lib.userId, query: {}, consumer: { id: 'tab', kind: 'SELECTION' } });
  assert.deepEqual((await jobsOf(pool, lib.userId)).map((j) => [j.kind, j.state]), [['QUERY_SET_BUILD', 'QUEUED']]);
  const w1 = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, owner: 'w1', options: { stepsPerClaim: 1 } });
  const r1 = await w1.runOnce();
  assert.equal(r1[0].outcome, 'done');
  let s = await q.getQuerySet({ userId: lib.userId, setId: set.setId });
  assert.deepEqual([s.status, s.memberCount], ['BUILDING', 240]);
  const members1 = (await pool.query('SELECT slot::int AS slot, beat_id FROM catalog_query_members WHERE user_id = $1 AND set_id = $2 ORDER BY slot', [lib.userId, set.setId])).rows;
  // "reinicio": otro worker continúa desde el checkpoint (frontier), sin recalcular los primeros 240
  const w2 = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, owner: 'w2', options: { stepsPerClaim: 2 } });
  await w2.runOnce();
  s = await q.getQuerySet({ userId: lib.userId, setId: set.setId });
  assert.deepEqual([s.status, s.memberCount], ['READY', 700]);
  const members2 = (await pool.query('SELECT slot::int AS slot, beat_id FROM catalog_query_members WHERE user_id = $1 AND set_id = $2 ORDER BY slot LIMIT 240', [lib.userId, set.setId])).rows;
  assert.deepEqual(members2, members1, 'los miembros ya construidos no se recalculan');
  // bulk: operación congelada → OPERATION_STEP encadenado; conflicto externo tras el primer lote → CONFLICT (job DONE, operación visible)
  const sel = await cmd.createSelection({ ...hdr, setId: set.setId, sort: 'manual', defaultSelected: true, consumerId: 'tab' });
  const bulk = await cmd.createOperation({ ...hdr, idempotencyKey: key(), kind: 'BULK_PATCH', selectionId: sel.selectionId, selectionVersion: '0', patch: { color: '#abcdef' } });
  assert.ok((await jobsOf(pool, lib.userId)).some((j) => j.kind === 'OPERATION_STEP' && j.state === 'QUEUED'));
  const w3 = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, owner: 'w3', options: { stepsPerClaim: 1 } });
  await w3.runOnce();
  let b = await cmd.getOperation({ userId: lib.userId, operationId: bulk.operationId });
  assert.deepEqual([b.status, b.progress.confirmed], ['RUNNING', 50]);
  await cmd.patchBeat({ ...hdr, beatId: 'b0699', idempotencyKey: key(), expectedVersion: '1', patch: { rating: 1 } }); // escritura externa
  await w3.runOnce(); // continuación encadenada
  b = await cmd.getOperation({ userId: lib.userId, operationId: bulk.operationId });
  assert.deepEqual([b.status, b.progress.confirmed, b.progress.conflictBatchSeq], ['CONFLICT', 50, 2], 'conflicto externo detiene el siguiente lote conservando lo confirmado');
  const colored = (await pool.query("SELECT count(*)::int AS n FROM catalog_beats WHERE user_id = $1 AND color = '#abcdef'", [lib.userId])).rows[0].n;
  assert.equal(colored, 50);
  // resume explícito encola otro paso; health refleja backlog/BLOCKED
  const rev = (await pool.query('SELECT revision::text AS r FROM catalog_libraries WHERE user_id = $1', [lib.userId])).rows[0].r;
  await cmd.resumeOperation({ ...hdr, operationId: bulk.operationId, revision: rev });
  let health = await w3.health();
  assert.ok(health.backlog >= 1);
  await ops.enqueueJob({ userId: lib.userId, kind: 'PURGE', payload: {}, jobId: 'job-purge' });
  for (let i = 0; i < 20; i++) { const r = await w3.runOnce(); if (!r.length) break; }
  b = await cmd.getOperation({ userId: lib.userId, operationId: bulk.operationId });
  // T07: el miembro editado externamente (b0699, lote 14) sigue con versión distinta → la operación vuelve a CONFLICT en ese lote con 650 confirmados; no hay retry ciego
  assert.deepEqual([b.status, b.progress.confirmed, b.progress.conflictBatchSeq], ['CONFLICT', 650, 15], 'lotes 3..15 tras reanudar; el 15 (b0699) entra en conflicto');
  assert.equal((await jobsOf(pool, lib.userId)).filter((j) => j.kind === 'OPERATION_STEP' && j.state !== 'DONE').length, 0, 'los pasos encadenados terminan DONE al entrar en CONFLICT');
  // cancelar y drenar: el worker completa la cancelación y el reporte cuadra
  await cmd.cancelOperation({ ...hdr, operationId: bulk.operationId });
  await ops.enqueueJob({ userId: lib.userId, kind: 'OPERATION_STEP', operationId: bulk.operationId, payload: { operationId: bulk.operationId }, jobId: 'job-op-cancel-drain' });
  for (let i = 0; i < 20; i++) { const r = await w3.runOnce(); if (!r.length) break; }
  b = await cmd.getOperation({ userId: lib.userId, operationId: bulk.operationId });
  assert.deepEqual([b.status, b.progress.confirmed + b.progress.notExecuted + b.progress.cancelled], ['CANCELLED', 700]);
  health = await w3.health();
  assert.deepEqual([health.blocked, health.backlog, health.running], [0, 1, 0], 'PURGE sin módulo de purge montado (T15 lo inyecta): reintento transitorio visible en el backlog, nunca BLOCKED silencioso ni éxito ficticio');
  assert.equal((await jobsOf(pool, lib.userId)).find((j) => j.job_id === 'job-purge').state, 'QUEUED', 'sin purge inyectado el job espera (transitorio); con el módulo T15 lo procesa catalog-purge.integration');
}));

// Fencing atómico de leases (T10, hallazgos GPT-6): un worker con lease viejo/reasignado no puede fallar, completar ni persistir recibos.
async function reconcileFixture(pool) {
  const lib = await nativeLibrary(pool); const { ops, q, cmd } = modules(pool, null);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [master()], metadata: { name: 'fence' } } });
  const d = await ops.markDispatched({ ...hdr, operationId: op.operationId, partKey: 'm0' });
  await ops.cancelOperation({ ...hdr, operationId: op.operationId }); // → RECONCILE + job TRANSFER_RECONCILE
  const job = (await jobsOf(pool, lib.userId)).find((j) => j.kind === 'TRANSFER_RECONCILE');
  return { lib, ops, q, cmd, hdr, op, d, job };
}
const partState = async (pool, uid, opId) => (await pool.query("SELECT dispatch_state, receipt_hash FROM catalog_operation_parts WHERE user_id = $1 AND operation_id = $2 AND part_key = 'm0'", [uid, opId])).rows[0];
const jobRow = async (pool, jobId) => (await pool.query('SELECT state, lease_owner, lease_generation::text AS g FROM catalog_jobs WHERE job_id = $1', [jobId])).rows[0];
const reassign = async (ops, pool, jobId, owner) => { await pool.query("UPDATE catalog_jobs SET lease_until = now() - interval '1 second' WHERE job_id = $1", [jobId]); const c = await ops.claimJobs({ owner, limit: 10, kinds: ['TRANSFER_RECONCILE'] }); return c.find((x) => x.jobId === jobId); };
const RECEIPT = { messageId: 33, documentId: '5', size: 1000 };

test('fencing: failJob/completeJob/putReceipt con lease viejo tras reasignación → LEASE_FENCED sin efecto; el lease vigente funciona', () => withDb(async (pool) => {
  const { lib, ops, hdr, op, job } = await reconcileFixture(pool);
  const a = (await ops.claimJobs({ owner: 'wA', limit: 10, kinds: ['TRANSFER_RECONCILE'] })).find((x) => x.jobId === job.job_id);
  const b = await reassign(ops, pool, job.job_id, 'wB');
  assert.ok(a && b && BigInt(b.lease.generation) > BigInt(a.lease.generation), 'lease reasignado con generación mayor');
  const fenced = (e) => e.code === 'LEASE_FENCED';
  await assert.rejects(ops.failJob({ jobId: job.job_id, lease: a.lease, error: 'stale', transient: false }), fenced);
  await assert.rejects(ops.completeJob({ jobId: job.job_id, lease: a.lease }), fenced);
  await assert.rejects(ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: 'm0', receipt: { ...RECEIPT, chatId: undefined }, lease: { jobId: job.job_id, owner: a.lease.owner, generation: a.lease.generation } }), fenced);
  assert.deepEqual(await jobRow(pool, job.job_id), { state: 'LEASED', lease_owner: 'wB', g: b.lease.generation }, 'el job reasignado no se tocó');
  assert.deepEqual(await partState(pool, lib.userId, op.operationId), { dispatch_state: 'DISPATCHED', receipt_hash: null }, 'sin recibo del worker viejo');
  await ops.putReceipt({ ...hdr, operationId: op.operationId, partKey: 'm0', receipt: { ...RECEIPT }, lease: { jobId: job.job_id, owner: 'wB', generation: b.lease.generation } });
  assert.equal((await partState(pool, lib.userId, op.operationId)).dispatch_state, 'RECEIPT', 'el lease vigente sí persiste el recibo');
}));

test('fencing concurrente: failJob(viejo) vs completeJob(vigente) y failJob(vigente) vs completeJob(vigente) → exactamente un ganador, estado coherente', () => withDb(async (pool) => {
  const f1 = await reconcileFixture(pool);
  const a = (await f1.ops.claimJobs({ owner: 'wA', limit: 10, kinds: ['TRANSFER_RECONCILE'] })).find((x) => x.jobId === f1.job.job_id);
  const b = await reassign(f1.ops, pool, f1.job.job_id, 'wB');
  const r1 = await Promise.allSettled([f1.ops.failJob({ jobId: f1.job.job_id, lease: a.lease, error: 'stale', transient: true }), f1.ops.completeJob({ jobId: f1.job.job_id, lease: b.lease })]);
  assert.deepEqual(r1.map((x) => x.status), ['rejected', 'fulfilled']);
  assert.equal(r1[0].reason.code, 'LEASE_FENCED');
  assert.equal((await jobRow(pool, f1.job.job_id)).state, 'DONE', 'el worker viejo no pudo revivir ni bloquear el job reasignado');
  const f2 = await reconcileFixture(pool);
  const c = (await f2.ops.claimJobs({ owner: 'wC', limit: 10, kinds: ['TRANSFER_RECONCILE'] })).find((x) => x.jobId === f2.job.job_id);
  const [x, y] = await Promise.allSettled([f2.ops.failJob({ jobId: f2.job.job_id, lease: c.lease, error: 'e', transient: true }), f2.ops.completeJob({ jobId: f2.job.job_id, lease: c.lease })]);
  assert.equal([x, y].filter((r) => r.status === 'fulfilled').length, 1, 'un solo resultado terminal por lease');

  const st = (await jobRow(pool, f2.job.job_id)).state;
  assert.ok(['DONE', 'QUEUED'].includes(st) && (await jobRow(pool, f2.job.job_id)).lease_owner === null, `estado coherente sin lease residual: ${st}`);
}));

test('TRANSFER_RECONCILE: si el lease se pierde durante el efecto remoto, putReceipt no persiste (fenced) y no hay recibo ni commit; opción A intacta', () => withDb(async (pool) => {
  const { lib, ops, q, cmd, op, d, job } = await reconcileFixture(pool);
  let stolen = false;
  const transport = {
    async searchByRandomId() { if (!stolen) { stolen = true; await pool.query("UPDATE catalog_jobs SET lease_owner = 'thief', lease_generation = lease_generation + 1, lease_until = now() + interval '60 seconds' WHERE job_id = $1", [job.job_id]); } return [{ messageId: 44, size: 1000, documentId: '9' }]; },
    async proveUniqueMatch() { return true; },
  };
  const w = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport, owner: 'w1' });
  const r = await w.runOnce();
  assert.equal(r.find((x) => x.jobId === job.job_id).outcome, 'fenced');
  assert.deepEqual(await partState(pool, lib.userId, op.operationId), { dispatch_state: 'DISPATCHED', receipt_hash: null }, 'recibo no persistido por el worker desplazado');
  assert.equal((await jobsOf(pool, lib.userId)).filter((j) => j.kind === 'TRANSFER_COMMIT').length, 0);
  assert.equal((await jobRow(pool, job.job_id)).lease_owner, 'thief');
  // opción A: con el lease propio pero sin prueba de unicidad → bloqueo sin recibo
  const g = await reconcileFixture(pool);
  const w2 = createCatalogWorker({ pool, operations: g.ops, queries: g.q, commands: g.cmd, transport: { async searchByRandomId() { return [{ messageId: 45, size: 1000 }]; } }, owner: 'w2' });
  const r2 = await w2.runOnce();
  assert.equal(r2.find((x) => x.jobId === g.job.job_id).outcome, 'blocked');
  assert.equal((await partState(pool, g.lib.userId, g.op.operationId)).dispatch_state, 'DISPATCHED');
}));
