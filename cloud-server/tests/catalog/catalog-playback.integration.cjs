'use strict';
// T14 — Rondas Shuffle persistidas y acceso a medios contra PostgreSQL real aislado (`node scripts/catalog-check.cjs T14`), con el servidor
// Telegram FAKE detrás del adaptador real del gateway (T11), el transporte T12 y el worker T10. Cubre r4 §5 (N=0/1/2/240/grande, cada
// miembro una vez por ronda, replay idempotente, sequence CAS, consume explícito, equivalencia con el modelo puro, STALE por revisión y
// reconstrucción preservando consumidos) y TAREAS §T14.4 (acceso por referencia, Range, multipart completo con hash, denegado en TRASH,
// recuperado al restaurar, otra cuenta, cierre de sesión). Etiqueta FAKE: sin proveedor real. N=100k/1M se miden en T20 (perf), no aquí.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const operations = require('../../catalog/operations.js');
const queries = require('../../catalog/queries.js');
const commands = require('../../catalog/commands.js');
const codec = require('../../catalog/legacy-codec.js');
const { rebuildDerivedProjections } = require('../../catalog/staging.js');
const { createCatalogWorker } = require('../../catalog/worker.js');
const g = require('../../catalog/transport-gateway.js');
const { createCatalogTransport } = require('../../catalog/transport.js');
const pb = require('../../catalog/playback.js');
const mediaMod = require('../../catalog/media.js');
const { createFakeTelegramServer } = require('../helpers/catalog-fake-mtproto.cjs');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
const { Api } = require(path.join(__dirname, '..', '..', 'node_modules', 'telegram'));
const bigInt = require(path.join(__dirname, '..', '..', 'node_modules', 'big-integer'));
db.validateAdminTarget();
const sdk = { Api, bigInt };
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const H = crypto.createHash('sha256').update('x').digest('hex');
const LARGE_N = Number(process.env.CATALOG_T14_LARGE_N || 20_000);
let seq = 0; let keyN = 0;
const key = () => `k-${++keyN}`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-t14-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

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
const peerOf = (chatId) => new Api.InputPeerChannel({ channelId: bigInt(String(chatId).replace(/^-100/, '')), accessHash: bigInt('7') });
function modules(pool, { server = createFakeTelegramServer(), rng = crypto.randomBytes, grantTtlMs = 600_000 } = {}) {
  const a = auth(pool);
  const client = server.session({ selfId: '20' });
  const gateway = { ...g.createTelegramGateway({ client, sdk, senderId: '20', botId: 'Bot20', resolvePeer: async (chatId) => ({ peer: peerOf(chatId), channel: true }) }), client };
  const ops = operations.createCatalogOperations({ pool, authority: a, resolveAccess: async () => ({ maxBeats: null }) });
  const q = queries.createCatalogQueries({ pool, authority: a, cursorKeys: [{ kid: 'k', secret: crypto.randomBytes(32) }] });
  const cmd = commands.createCatalogCommands({ pool, authority: a });
  const transport = createCatalogTransport({ pool, authority: a, operations: ops, gateway, tempDir: TMP });
  const worker = createCatalogWorker({ pool, operations: ops, queries: q, commands: cmd, transport: gateway, owner: 'w', options: { globalConcurrency: 2, renewEveryMs: 100_000 } });
  const playback = pb.createCatalogPlayback({ pool, authority: a, randomBytes: rng });
  const media = mediaMod.createCatalogMedia({ pool, authority: a, gateway, grantTtlMs });
  return { a, ops, q, cmd, gateway, transport, worker, playback, media, server };
}
async function nativeLibrary(pool) {
  const id = `u${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, era: ctx.authority_era, epoch: ctx.authority_epoch, generationId: ctx.generation_id, chatId: `-100${seq}` };
}
// Siembra: n beats ACTIVE (JS por fila hasta 1000; bulk SQL para n grandes) + proyecciones derivadas.
async function seedBeats(pool, lib, n) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (n <= 1000) {
      for (let i = 0; i < n; i++) {
        const beat = { id: `b${String(i).padStart(4, '0')}`, name: `Beat ${i}`, bpm: '120', key: 'Cm', rating: i % 5, tags: ['all'] };
        const p = codec.projectBeat(beat); const json = JSON.stringify(beat);
        await c.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, bpm_sort_class, bpm_sort, manual_rank, has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display)
          VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,false,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [lib.userId, lib.generationId, beat.id, p.name, p.bpmText, p.keyText, p.rating, p.bpmSortClass, p.bpmSort, String(i * 1000), json, sha(json), Buffer.byteLength(json, 'utf8'), p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay]);
        for (const t of p.tags) await c.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [lib.userId, lib.generationId, beat.id, t.position, t.label, t.normKey, t.searchKey]);
      }
    } else {
      const p = codec.projectBeat({ id: 'x', name: 'Beat', bpm: '120', key: 'Cm', rating: 0, tags: [] });
      await c.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, bpm_sort_class, bpm_sort, manual_rank, has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display)
        SELECT $1, $2, 'b' || lpad(i::text, 7, '0'), 'ACTIVE', 'Beat ' || i, '120', 'Cm', 0, $3, $4, (i * 1000)::numeric, false, j, encode(sha256(convert_to(j, 'UTF8')), 'hex'), octet_length(j), $5 || ' ' || i, $6 || ' ' || i, $7, $8, $9, $10
        FROM generate_series(0, $11::int - 1) AS s(i), LATERAL (SELECT ('{"id":"b' || lpad(i::text, 7, '0') || '","name":"Beat ' || i || '","bpm":"120","key":"Cm","tags":[],"rating":0}')::text AS j) AS t`,
      [lib.userId, lib.generationId, p.bpmSortClass, p.bpmSort, p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay, n]);
    }
    await c.query('UPDATE catalog_libraries SET active_count = $2 WHERE user_id = $1', [lib.userId, n]);
    await rebuildDerivedProjections(c, lib); await c.query('COMMIT');
    if (n > 1000) await pool.query('ANALYZE catalog_beats, catalog_query_members, catalog_beat_tags');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
async function readySet(q, lib, query = { state: 'ACTIVE', sort: 'manual' }) {
  const s = await q.createQuerySet({ userId: lib.userId, query, consumer: { id: 'shuffle-test', kind: 'SHUFFLE' } });
  let st = s;
  for (let i = 0; i < 10_000 && st.status === 'BUILDING'; i++) st = await q.stepQuerySet({ userId: lib.userId, setId: s.setId, batch: 240 });
  assert.equal(st.status, 'READY', `set ${s.setId} status ${st.status}`);
  return { setId: s.setId, memberCount: st.memberCount };
}
const hdrOf = (lib) => ({ userId: lib.userId, era: lib.era, epoch: lib.epoch });
// RNG determinista de 48 bits para comparar SQL con el modelo puro.
const bytesOf = (values) => { let i = 0; return () => { const v = BigInt(values[i++ % values.length]); const b = Buffer.alloc(6); b.writeUInt32BE(Number(v >> 16n), 0); b.writeUInt16BE(Number(v & 0xffffn), 4); return b; }; };
async function drawAll(playback, hdr, roundId, startSeq = 0) {
  const out = []; let sequence = String(startSeq);
  for (;;) { const r = await playback.nextInRound({ ...hdr, roundId, sequence, idempotencyKey: key() }); sequence = r.sequence; if (r.beatId === null) return { out, sequence, final: r }; out.push(r.beatId); }
}
const mappingRows = async (pool, uid, roundId) => (await pool.query('SELECT count(*)::int AS n FROM catalog_round_mapping WHERE user_id = $1 AND round_id = $2', [uid, roundId])).rows[0].n;
const rejects = (p, code, extra = () => true) => assert.rejects(p, (e) => { assert.equal(e.code, code, `código esperado ${code}, recibido ${e.code}: ${e.message}`); return extra(e); });
// Respuesta HTTP mínima para `media.stream`.
function fakeRes() {
  const r = { headers: {}, statusCode: 200, chunks: [], ended: false, destroyed: null, headersSent: false, setHeader(k, v) { r.headers[k.toLowerCase()] = v; }, status(c) { r.statusCode = c; r.headersSent = true; return r; }, write(c) { r.chunks.push(Buffer.from(c)); return true; }, end() { r.ended = true; }, once() {}, destroy(e) { r.destroyed = e || true; }, bytes: () => Buffer.concat(r.chunks) };
  return r;
}

test('rondas N=0/1/2/240: cada miembro exactamente una vez, remaining exacto, ronda completa sin sorteo (m=0), mapping vacío al terminar; la canción actual se consume al abrir si N>1', () => withDb(async (pool) => {
  for (const n of [0, 1, 2, 240]) {
    const lib = await nativeLibrary(pool); await seedBeats(pool, lib, n);
    let rngCalls = 0; const { q, playback } = modules(pool, { rng: (k) => { rngCalls++; return crypto.randomBytes(k); } });
    const hdr = hdrOf(lib); const set = await readySet(q, lib);
    assert.equal(set.memberCount, n);
    const current = n > 1 ? 'b0001' : null;
    const r0 = await playback.startRound({ ...hdr, setId: set.setId, currentBeatId: current, consumerId: 'c1' });
    assert.deepEqual([r0.status, r0.memberCount, r0.remaining, r0.currentConsumed, r0.sequence], ['ACTIVE', n, n > 1 ? n - 1 : n, n > 1, '0']);
    const { out, final } = await drawAll(playback, hdr, r0.roundId);
    const expected = Array.from({ length: n }, (_, i) => `b${String(i).padStart(4, '0')}`).filter((b) => b !== current);
    assert.deepEqual([...out].sort(), expected, `N=${n}: cada miembro una vez`);
    assert.deepEqual([final.roundComplete, final.remaining, final.beatId], [true, 0, null]);
    assert.equal(await mappingRows(pool, lib.userId, r0.roundId), 0);
    assert.equal((await playback.getRound({ userId: lib.userId, roundId: r0.roundId })).status, 'COMPLETE');
    const again = await playback.nextInRound({ ...hdr, roundId: r0.roundId, sequence: final.sequence, idempotencyKey: key() });
    assert.deepEqual([again.beatId, again.roundComplete], [null, true]);
    if (n <= 1) assert.equal(rngCalls, 0, 'N≤1: nunca se llama al RNG'); else assert.ok(rngCalls >= out.length - 1, 'un sorteo por avance (salvo m=1)');
  }
}));

test('idempotencia y CAS: replay devuelve el mismo beat sin consumir otro; sequence vieja → 409; 5 avances concurrentes con la misma sequence → exactamente uno; consume explícito (inverso) y doble consume sin descuento; no miembro', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); await seedBeats(pool, lib, 40);
  const { q, playback } = modules(pool); const hdr = hdrOf(lib); const set = await readySet(q, lib);
  const r0 = await playback.startRound({ ...hdr, setId: set.setId, consumerId: 'c1' });
  const k1 = key();
  const a = await playback.nextInRound({ ...hdr, roundId: r0.roundId, sequence: '0', idempotencyKey: k1 });
  const b = await playback.nextInRound({ ...hdr, roundId: r0.roundId, sequence: '0', idempotencyKey: k1 });
  assert.deepEqual([b.beatId, b.remaining, b.sequence, b.replay], [a.beatId, 39, '1', true], 'retry del mismo comando: mismo beat, nada más consumido');
  await rejects(playback.nextInRound({ ...hdr, roundId: r0.roundId, sequence: '0', idempotencyKey: key() }), 'SEQUENCE_MISMATCH', (e) => e.detail.current_sequence === '1');
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => playback.nextInRound({ ...hdr, roundId: r0.roundId, sequence: '1', idempotencyKey: key() })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'el lock de ronda serializa: una sola respuesta aplica');
  assert.ok(results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === 'SEQUENCE_MISMATCH'));
  const round = await playback.getRound({ userId: lib.userId, roundId: r0.roundId });
  assert.deepEqual([round.remaining, round.sequence, round.consumedCount], [38, '2', 2]);
  // consume explícito de un miembro no sorteado
  const drawn = new Set([a.beatId, results.find((r) => r.status === 'fulfilled').value.beatId]);
  const target = ['b0005', 'b0006', 'b0007'].find((x) => !drawn.has(x));
  const c1 = await playback.consumeInRound({ ...hdr, roundId: r0.roundId, beatId: target, sequence: '2', idempotencyKey: key() });
  assert.deepEqual([c1.consumed, c1.member, c1.remaining, c1.sequence], [true, true, 37, '3']);
  const c2 = await playback.consumeInRound({ ...hdr, roundId: r0.roundId, beatId: target, sequence: '3', idempotencyKey: key() });
  assert.deepEqual([c2.consumed, c2.remaining], [false, 37], 'segundo consume: sin descuento');
  const c3 = await playback.consumeInRound({ ...hdr, roundId: r0.roundId, beatId: 'nope', sequence: '4', idempotencyKey: key() });
  assert.deepEqual([c3.consumed, c3.member, c3.remaining], [false, false, 37]);
  const rest = await drawAll(playback, hdr, r0.roundId, 5);
  assert.equal(rest.out.length, 37); assert.ok(!rest.out.includes(target) && !rest.out.some((x) => drawn.has(x)));
  assert.equal(new Set([...rest.out, ...drawn, target]).size, 40);
}));

test('equivalencia SQL ↔ modelo puro con RNG inyectado (N=12): misma secuencia de slots y mismo mapping disperso; N grande: 300 avances distintos con ≤300 filas de mapping', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); await seedBeats(pool, lib, 12);
  const values = [7n, 100n, 3n, 999999n, 42n, 1n << 47n, 5n, 11n, 0n, 123456789n, 2n, 88n];
  const { q, playback } = modules(pool, { rng: bytesOf(values) }); const hdr = hdrOf(lib); const set = await readySet(q, lib);
  const r0 = await playback.startRound({ ...hdr, setId: set.setId, consumerId: 'c1' });
  const model = pb.createMemoryRound(12); const modelRng = bytesOf(values); const modelSlots = [];
  while (model.state.remaining > 0) modelSlots.push(model.next(pb.uniformInt(model.state.remaining, modelRng)));
  const sqlSlots = []; let sequence = '0';
  for (;;) { const r = await playback.nextInRound({ ...hdr, roundId: r0.roundId, sequence, idempotencyKey: key() }); sequence = r.sequence; if (r.beatId === null) break; sqlSlots.push(r.slot); }
  assert.deepEqual(sqlSlots, modelSlots, 'la versión SQL implementa exactamente la misma aritmética que el oráculo');
  // grande
  const big = await nativeLibrary(pool); await seedBeats(pool, big, LARGE_N);
  const m2 = modules(pool); const h2 = hdrOf(big); const set2 = await readySet(m2.q, big);
  assert.equal(set2.memberCount, LARGE_N);
  const r2 = await m2.playback.startRound({ ...h2, setId: set2.setId, consumerId: 'c1' });
  const seen = new Set(); let s2 = '0'; const t0 = Date.now();
  for (let i = 0; i < 300; i++) { const r = await m2.playback.nextInRound({ ...h2, roundId: r2.roundId, sequence: s2, idempotencyKey: key() }); s2 = r.sequence; assert.ok(!seen.has(r.beatId)); seen.add(r.beatId); }
  const ms = Date.now() - t0;
  assert.equal(seen.size, 300); assert.ok((await mappingRows(pool, big.userId, r2.roundId)) <= 300);
  assert.equal((await m2.playback.getRound({ userId: big.userId, roundId: r2.roundId })).remaining, LARGE_N - 300);
  console.log(`# LAB/CI métrica inicial (no SLO): ${LARGE_N} miembros, 300 avances en ${ms} ms (${(ms / 300).toFixed(1)} ms/avance)`);
}));

test('revisión externa → ROUND_STALE (sin mezclar revisiones); ronda nueva sobre el conjunto READY nuevo reconstruida en lotes preservando consumidos: la unión de ambas rondas es exactamente la biblioteca', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); await seedBeats(pool, lib, 500);
  const { q, cmd, playback } = modules(pool); const hdr = hdrOf(lib); const set = await readySet(q, lib);
  const r0 = await playback.startRound({ ...hdr, setId: set.setId, consumerId: 'c1' });
  const first = []; let sequence = '0';
  for (let i = 0; i < 300; i++) { const r = await playback.nextInRound({ ...hdr, roundId: r0.roundId, sequence, idempotencyKey: key() }); sequence = r.sequence; first.push(r.beatId); }
  await cmd.patchBeat({ ...hdr, idempotencyKey: key(), beatId: 'b0499', expectedVersion: '1', patch: { name: 'Edited elsewhere' } });
  await rejects(playback.nextInRound({ ...hdr, roundId: r0.roundId, sequence, idempotencyKey: key() }), 'ROUND_STALE');
  assert.equal((await playback.getRound({ userId: lib.userId, roundId: r0.roundId })).status, 'STALE');
  const set2 = await readySet(q, lib);
  assert.notEqual(set2.setId, set.setId);
  const r1 = await playback.startRound({ ...hdr, setId: set2.setId, consumerId: 'c1', fromRoundId: r0.roundId });
  assert.deepEqual([r1.status, r1.remaining, r1.rebuildFrom], ['ACTIVE', 200, r0.roundId], 'reconstrucción por lotes ≤240 (300 consumidos → 2 lotes) preserva los consumidos por beatId');
  const { out } = await drawAll(playback, hdr, r1.roundId);
  assert.equal(out.length, 200); assert.ok(out.every((b) => !first.includes(b)));
  assert.equal(new Set([...first, ...out]).size, 500, 'ningún beat se repite entre la ronda vieja y la reconstruida; ninguno falta');
  // filtros nuevos → ronda nueva sin herencia (otro conjunto, remaining completo)
  const set3 = await readySet(q, lib, { state: 'ACTIVE', sort: 'name', q: 'Beat 1' });
  const r3 = await playback.startRound({ ...hdr, setId: set3.setId, consumerId: 'c1' });
  assert.equal(r3.remaining, set3.memberCount);
  await playback.releaseRound({ ...hdr, roundId: r3.roundId });
  await rejects(playback.nextInRound({ ...hdr, roundId: r3.roundId, sequence: '0', idempotencyKey: key() }), 'ROUND_RELEASED');
}));

test('vecino de orden (I2): siguiente/anterior por slot del conjunto; fuera del query → primero/último; bordes; conjunto vacío', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); await seedBeats(pool, lib, 5);
  const { q, playback } = modules(pool); const set = await readySet(q, lib);
  const n = (beatId, direction) => playback.neighbor({ userId: lib.userId, setId: set.setId, beatId, direction });
  assert.deepEqual([(await n('b0001', 'next')).beatId, (await n('b0001', 'previous')).beatId], ['b0002', 'b0000']);
  assert.deepEqual([(await n('b0004', 'next')).beatId, (await n('b0004', 'next')).edge, (await n('b0000', 'previous')).edge], [null, 'end', 'start']);
  assert.deepEqual([(await n('zzz', 'next')).beatId, (await n('zzz', 'previous')).beatId, (await n('zzz', 'next')).member], ['b0000', 'b0004', false]);
  const empty = await readySet(q, lib, { state: 'TRASH', sort: 'manual' });
  assert.deepEqual((await playback.neighbor({ userId: lib.userId, setId: empty.setId, beatId: null, direction: 'next' })).total, 0);
  await rejects(playback.neighbor({ userId: lib.userId, setId: set.setId, beatId: 'b0001', direction: 'sideways' }), 'INPUT_INVALID');
  // sort no manual: rating descendente (b0004 rating 4 primero … b0000 rating 0 último) con desempate por manual_rank
  const byRating = (beatId, direction) => playback.neighbor({ userId: lib.userId, setId: set.setId, beatId, direction, sort: 'rating' });
  assert.deepEqual([(await byRating(null, 'next')).beatId, (await byRating('b0004', 'next')).beatId, (await byRating('b0000', 'next')).edge, (await byRating(null, 'previous')).beatId, (await byRating('b0002', 'previous')).beatId], ['b0004', 'b0003', 'end', 'b0000', 'b0003']);
}));

test('medios: acceso por referencia (concesión por parte, caché por época/revisión), stream completo y por Range desde el gateway, multipart completo con hash, denegado en TRASH y recuperado al restaurar, otra cuenta, caducidad, cierre de sesión, fallo del proveedor antes del primer byte', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const other = await nativeLibrary(pool);
  const { ops, cmd, transport, worker, media, server, gateway } = modules(pool, { grantTtlMs: 600_000 });
  const hdr = hdrOf(lib);
  const b0 = crypto.randomBytes(300_000); const b1 = crypto.randomBytes(120_000);
  const part = (k, bytes, idx) => ({ partKey: k, slotKey: 'MASTER', role: 'MASTER', partIndex: idx, size: bytes.length, sha256: sha(bytes), filename: 'beat.mp3', mime: 'audio/mpeg' });
  const op = await ops.createOperation({ ...hdr, idempotencyKey: key(), intent: { kind: 'IMPORT', parts: [part('m0', b0, 0), part('m1', b1, 1)], metadata: { name: 'Media' } } });
  for (const [k, bytes] of [['m0', b0], ['m1', b1]]) { const cap = await transport.issueUploadCapability({ ...hdr, operationId: op.operationId, partKey: k }); assert.equal((await transport.uploadPart({ ...hdr, token: cap.token, stream: Readable.from([bytes]), contentLength: bytes.length })).status, 200); }
  for (let i = 0; i < 6; i++) { await pool.query("UPDATE catalog_jobs SET next_attempt_at = now() WHERE user_id = $1 AND state = 'QUEUED'", [lib.userId]); await worker.runOnce({ kinds: ['TRANSFER_VERIFY'] }); }
  assert.equal((await ops.commitOperation({ ...hdr, operationId: op.operationId })).status, 200);
  const fileId = (await pool.query("SELECT file_id FROM catalog_current_files WHERE user_id = $1 AND beat_id = $2 AND slot_key = 'MASTER'", [lib.userId, op.beatId])).rows[0].file_id;
  const access = await media.issueAccess({ userId: lib.userId, fileId, epoch: lib.epoch });
  assert.deepEqual([access.beatId, access.role, access.parts.length, access.partsTotalBytes, access.parts.map((p) => p.size), access.parts.map((p) => p.hashVerified)], [op.beatId, 'MASTER', 2, 420_000, [300_000, 120_000], [false, false]]);
  assert.match(access.cacheKey, new RegExp(`^${lib.userId}:${lib.epoch}:${op.beatId}:${fileId}:1$`));
  assert.ok(access.parts.every((p) => /^[A-Za-z0-9_-]{43}$/.test(p.token) && !JSON.stringify(p).match(/chat|message|-100/)), 'sin chat ni message_id hacia el cliente');
  // stream completo de la parte 0 y por rangos; multipart en orden = bytes originales (hash verificado por el cliente)
  const r0 = fakeRes(); const s0 = await media.stream({ userId: lib.userId, token: access.parts[0].token, res: r0 });
  assert.deepEqual([r0.statusCode, s0.bytes, r0.headers['content-length'], r0.headers['accept-ranges']], [200, 300_000, '300000', 'bytes']); assert.ok(r0.bytes().equals(b0));
  const r1 = fakeRes(); await media.stream({ userId: lib.userId, token: access.parts[0].token, rangeHeader: 'bytes=1000-1999', res: r1 });
  assert.deepEqual([r1.statusCode, r1.headers['content-range'], r1.bytes().length], [206, 'bytes 1000-1999/300000', 1000]); assert.ok(r1.bytes().equals(b0.subarray(1000, 2000)));
  const r2 = fakeRes(); await media.stream({ userId: lib.userId, token: access.parts[1].token, rangeHeader: 'bytes=-5', res: r2 });
  assert.ok(r2.bytes().equals(b1.subarray(b1.length - 5)));
  const rAll = fakeRes(); await media.stream({ userId: lib.userId, token: access.parts[1].token, res: rAll });
  assert.equal(sha(Buffer.concat([r0.bytes(), rAll.bytes()])), sha(Buffer.concat([b0, b1])), 'todas las partes en orden: hash del archivo completo');
  assert.ok(server.counters().downloads >= 4, 'la concesión es reutilizable dentro de su vigencia (Range)');
  const h = fakeRes(); await media.stream({ userId: lib.userId, token: access.parts[0].token, rangeHeader: 'bytes=0-9', res: h, method: 'HEAD' });
  assert.deepEqual([h.statusCode, h.bytes().length, h.headers['content-range']], [206, 0, 'bytes 0-9/300000']);
  await rejects(media.stream({ userId: lib.userId, token: access.parts[0].token, rangeHeader: 'bytes=999999-', res: fakeRes() }), 'RANGE_NOT_SATISFIABLE');
  // otra cuenta: ni acceso ni stream
  await rejects(media.issueAccess({ userId: other.userId, fileId }), 'NOT_FOUND');
  await rejects(media.stream({ userId: other.userId, token: access.parts[0].token, res: fakeRes() }), 'MEDIA_GRANT_INVALID');
  await rejects(media.issueAccess({ userId: lib.userId, fileId, epoch: '999' }), 'CATALOG_EPOCH_STALE');
  // papelera: denegado; restaurar: recuperado (nueva concesión; la versión del archivo no cambia)
  const beat = (await pool.query('SELECT version::text AS version FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, op.beatId])).rows[0];
  await cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: op.beatId, expectedVersion: beat.version }] });
  await rejects(media.issueAccess({ userId: lib.userId, fileId }), 'ACCESS_DENIED', (e) => e.detail.reason === 'BEAT_NOT_ACTIVE' && e.detail.state === 'TRASH');
  const v2 = (await pool.query('SELECT version::text AS version FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, op.beatId])).rows[0].version;
  await cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: op.beatId, expectedVersion: v2 }] });
  const access2 = await media.issueAccess({ userId: lib.userId, fileId });
  assert.equal(access2.revision, access.revision);
  // caducidad y cierre de sesión
  await pool.query("UPDATE catalog_media_grants SET expires_at = now() - interval '1 second' WHERE grant_hash = $1", [mediaMod.tokenHash(access2.parts[0].token)]);
  await rejects(media.stream({ userId: lib.userId, token: access2.parts[0].token, res: fakeRes() }), 'MEDIA_GRANT_EXPIRED');
  const rv = await media.revokeGrants({ userId: lib.userId });
  assert.ok(rv.revoked >= 1);
  await rejects(media.stream({ userId: lib.userId, token: access2.parts[1].token, res: fakeRes() }), 'MEDIA_GRANT_INVALID', (e) => e.detail.reason === 'REVOKED');
  // objeto no PRESENT → denegado; fallo del proveedor antes del primer byte → 502 estable (no se interpreta como borrado)
  const access3 = await media.issueAccess({ userId: lib.userId, fileId });
  gateway.client.script({ type: 'noop' }).script({ type: 'downloadFail' }); // GetMessages consume el primer fault (neutro); iterDownload, el segundo
  await rejects(media.stream({ userId: lib.userId, token: access3.parts[0].token, res: fakeRes() }), 'MEDIA_UNAVAILABLE', (e) => e.status === 502);
  await pool.query("UPDATE catalog_media_objects SET status = 'DELETING' WHERE user_id = $1", [lib.userId]);
  await rejects(media.issueAccess({ userId: lib.userId, fileId }), 'ACCESS_DENIED', (e) => e.detail.reason === 'OBJECT_NOT_PRESENT');
  assert.ok(media.metrics.denied >= 2);
}));
