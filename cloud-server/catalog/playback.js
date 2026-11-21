'use strict';
// T14 — Rondas Shuffle persistidas y vecinos de orden (C12-r4 §5 e I2; T06-A Q4; TAREAS §T14; MATRIZ-T §T14-B).
//  - Fisher–Yates PEREZOSO sobre los slots densos [0, N) de un conjunto READY: mapping disperso posición→slot (ausencia = identidad),
//    inverso por UNIQUE(slot), `remaining = m`. Cada sorteo: j uniforme en [0, m) por rejection sampling (crypto, RNG inyectable
//    solo en pruebas), slot = mapping(j), tail = mapping(m−1), mapping(j) = tail, retirar m−1, consumir el beat del slot, guardar el
//    resultado idempotente del comando y avanzar `sequence` — todo en UNA transacción corta con lock de ronda; COMMIT antes de medios.
//  - Retry del mismo comando (idempotencyKey) devuelve el mismo beat sin consumir otro; `sequence` distinta → 409 SEQUENCE_MISMATCH.
//  - Nunca se llama al RNG con m = 0 (ronda completa → beatId null). La canción actual se consume al abrir la ronda si es miembro y
//    N > 1; `consume` explícito (play directo/cola) usa el inverso y el mismo swap; un consumido no se descuenta dos veces.
//  - Cambio de filtros → ronda nueva; cambio de revisión → ronda nueva sobre el conjunto READY nuevo reconstruida en lotes ≤240
//    preservando los consumidos por beatId (BUILDING → ACTIVE). Revisión distinta de la esperada → STALE (409), nunca mezcla.
//  - El cliente nunca recibe la permutación ni los IDs del conjunto: solo beatId/versión del sorteo, remaining y sequence.
//  - neighbor: siguiente/anterior en el orden del conjunto (slot ± 1); fuera del query → primero/último (r4 I2).
// Solo SQL + crypto. Sin transporte.

const crypto = require('crypto');
const { requireUserId } = require('./contract');
const { canonicalJson, CatalogAuthorityError } = require('./authority');
const { CatalogQueryError } = require('./cursor');
const { STATEMENT_TIMEOUT_MS, TUPLES, SORTS } = require('./queries');

const REBUILD_BATCH = 240;
const REBUILD_MAX_LOOPS = 64;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const LEASE_MINUTES = 30;

const inputInvalid = (reason, extra = {}) => new CatalogQueryError('INPUT_INVALID', 400, `input is invalid (${reason})`, { ...extra, reason });
const notFound = (what) => new CatalogQueryError('NOT_FOUND', 404, `${what} is not accessible`, {});
const sqlError = (error) => {
  if (error instanceof CatalogAuthorityError || error instanceof CatalogQueryError) return error;
  if (error?.code === '57014') return new CatalogQueryError('CATALOG_QUERY_TIMEOUT', 503, 'catalog statement timed out', { sqlstate: '57014' });
  if (['BGL01', 'BGN04', 'BGA05', 'BGC02'].includes(error?.code)) return new CatalogQueryError('CATALOG_NATIVE_RULE', 409, 'database native rule rejected the mutation', { sqlstate: error.code });
  return new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'catalog is unavailable (SQL_ERROR)', { reason: 'SQL_ERROR', sqlstate: error?.code || null, sql_message: error?.code ? String(error.message).slice(0, 200) : null });
};

// ---------- RNG: entero uniforme en [0, m) por rejection sampling sobre 48 bits (sin módulo sesgado ni floats) ----------
const RNG_BITS = 48n; const RNG_SPACE = 1n << RNG_BITS;
function uniformInt(m, randomBytes = crypto.randomBytes) {
  if (!Number.isSafeInteger(m) || m <= 0) throw inputInvalid('RNG_RANGE', { m });
  if (m === 1) return 0; // determinista: no hace falta sorteo
  const mod = BigInt(m);
  const limit = RNG_SPACE - (RNG_SPACE % mod); // múltiplo de m más grande ≤ 2^48: todo x < limit es uniforme módulo m
  for (let i = 0; i < 1024; i++) {
    const b = randomBytes(6);
    const x = (BigInt(b.readUInt32BE(0)) << 16n) | BigInt(b.readUInt16BE(4));
    if (x < limit) return Number(x % mod);
  }
  throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'random source exhausted', { reason: 'RNG' });
}

// ---------- modelo puro del mapping (misma aritmética que la versión SQL; sirve de oráculo en pruebas) ----------
function createMemoryRound(n) {
  const mapping = new Map(); // position → slot (ausencia = identidad)
  const inverse = new Map(); // slot → position (solo movidos)
  const state = { n, remaining: n, consumed: new Set(), drawn: [] };
  const slotAt = (p) => (mapping.has(p) ? mapping.get(p) : p);
  const positionOf = (slot) => (inverse.has(slot) ? inverse.get(slot) : slot);
  function swapOut(position) {
    const m = state.remaining; if (position < 0 || position >= m) throw new Error(`position ${position} out of [0,${m})`);
    const drawn = slotAt(position); const tail = slotAt(m - 1);
    if (mapping.has(position)) { inverse.delete(mapping.get(position)); mapping.delete(position); }
    if (mapping.has(m - 1)) { inverse.delete(mapping.get(m - 1)); mapping.delete(m - 1); }
    if (position !== m - 1 && tail !== position) { mapping.set(position, tail); inverse.set(tail, position); }
    state.remaining = m - 1; state.consumed.add(drawn); state.drawn.push(drawn);
    return drawn;
  }
  return {
    state, slotAt, positionOf,
    next(j) { if (state.remaining === 0) return null; if (j < 0 || j >= state.remaining) throw new Error('j out of range'); return swapOut(j); },
    consume(slot) { if (state.consumed.has(slot)) return false; const p = positionOf(slot); if (p >= state.remaining) throw new Error('slot already retired'); swapOut(p); return true; },
    mappingSize: () => mapping.size,
  };
}

function createCatalogPlayback({ pool = null, authority = null, randomBytes = crypto.randomBytes, randomUUID = () => crypto.randomUUID() } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('createCatalogPlayback requires a pool');
  if (!authority || typeof authority.requireLibraryForMutation !== 'function') throw new Error('createCatalogPlayback requires the catalog authority');

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

  const ROUND_SQL = `SELECT round_id, set_id, generation_id, authority_epoch::text AS authority_epoch, base_revision::text AS base_revision, status, member_count::text AS member_count, remaining::text AS remaining,
    sequence::text AS sequence, consumer_id, rebuild_from, rebuild_cursor::text AS rebuild_cursor, created_at, updated_at FROM catalog_playback_rounds WHERE user_id = $1 AND round_id = $2`;
  const roundDto = (r, extra = {}) => ({ roundId: r.round_id, setId: r.set_id, status: r.status, memberCount: Number(r.member_count), remaining: Number(r.remaining), sequence: r.sequence, baseRevision: r.base_revision, epoch: r.authority_epoch, rebuildFrom: r.rebuild_from, ...extra });
  async function readySet(client, uid, ctx, setId) {
    const s = (await client.query('SELECT set_id, status, generation_id, authority_epoch::text AS epoch, base_revision::text AS base_revision, member_count::text AS member_count FROM catalog_query_sets WHERE user_id = $1 AND set_id = $2', [uid, setId])).rows[0];
    if (!s) throw notFound('query set');
    if (s.status !== 'READY') throw new CatalogQueryError('CURSOR_STALE', 409, `query set is ${s.status}`, { status: s.status, set_id: setId });
    if (s.generation_id !== ctx.generation_id || s.epoch !== ctx.authority_epoch || s.base_revision !== ctx.revision) throw new CatalogQueryError('CURSOR_STALE', 409, 'query set belongs to another revision/epoch', { set_revision: s.base_revision, current_revision: ctx.revision });
    return { setId: s.set_id, memberCount: Number(s.member_count) };
  }
  // mapping SQL: misma aritmética que createMemoryRound.
  async function slotAt(client, uid, roundId, position) { const r = (await client.query('SELECT slot::text AS slot FROM catalog_round_mapping WHERE user_id = $1 AND round_id = $2 AND position = $3::bigint', [uid, roundId, position])).rows[0]; return r ? Number(r.slot) : position; }
  async function positionOf(client, uid, roundId, slot, m) {
    const inv = (await client.query('SELECT position::text AS position FROM catalog_round_mapping WHERE user_id = $1 AND round_id = $2 AND slot = $3::bigint', [uid, roundId, slot])).rows[0];
    if (inv) return Number(inv.position) < m ? Number(inv.position) : null;
    if (slot >= m) return null;
    const occupied = (await client.query('SELECT 1 FROM catalog_round_mapping WHERE user_id = $1 AND round_id = $2 AND position = $3::bigint', [uid, roundId, slot])).rows.length > 0;
    return occupied ? null : slot; // otra ficha ocupa su posición de identidad → el slot ya fue retirado
  }
  async function swapOut(client, uid, roundId, position, m) {
    const drawn = await slotAt(client, uid, roundId, position);
    const tail = await slotAt(client, uid, roundId, m - 1);
    await client.query('DELETE FROM catalog_round_mapping WHERE user_id = $1 AND round_id = $2 AND position IN ($3::bigint, $4::bigint)', [uid, roundId, position, m - 1]);
    if (position !== m - 1 && tail !== position) await client.query('INSERT INTO catalog_round_mapping(user_id, round_id, position, slot) VALUES ($1, $2, $3::bigint, $4::bigint)', [uid, roundId, position, tail]);
    return drawn;
  }
  async function memberAtSlot(client, uid, setId, slot) {
    const r = (await client.query('SELECT beat_id, expected_version::text AS version, slot::text AS slot FROM catalog_query_members WHERE user_id = $1 AND set_id = $2 AND slot = $3::bigint', [uid, setId, slot])).rows[0];
    if (!r) throw new CatalogQueryError('CATALOG_UNAVAILABLE', 503, 'query set member is missing for a mapped slot', { reason: 'MEMBER_MISSING', slot });
    return { beatId: r.beat_id, version: r.version, slot: Number(r.slot) };
  }
  async function slotOfBeat(client, uid, setId, beatId) { const r = (await client.query('SELECT slot::text AS slot, expected_version::text AS version FROM catalog_query_members WHERE user_id = $1 AND set_id = $2 AND beat_id = $3', [uid, setId, beatId])).rows[0]; return r ? { slot: Number(r.slot), version: r.version } : null; }
  async function consumeSlot(client, uid, round, slot, beatId, sequence, reason) {
    const m = Number(round.remaining);
    const already = (await client.query('SELECT 1 FROM catalog_round_consumed WHERE user_id = $1 AND round_id = $2 AND beat_id = $3', [uid, round.round_id, beatId])).rows.length > 0;
    if (already) return false; // consumido: nunca se descuenta dos veces
    const p = await positionOf(client, uid, round.round_id, slot, m);
    if (p === null) return false; // retirado del espacio [0, m)
    await swapOut(client, uid, round.round_id, p, m);
    await client.query('INSERT INTO catalog_round_consumed(user_id, round_id, beat_id, slot, sequence, reason) VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6) ON CONFLICT DO NOTHING', [uid, round.round_id, beatId, slot, sequence, reason]);
    round.remaining = String(m - 1);
    return true;
  }
  async function lockRound(client, uid, roundId) { const r = (await client.query(`${ROUND_SQL} FOR UPDATE`, [uid, roundId])).rows[0]; if (!r) throw notFound('round'); return r; }
  async function assertRoundFresh(client, uid, ctx, r) {
    if (r.status === 'STALE') throw new CatalogQueryError('ROUND_STALE', 409, 'round is stale: rebuild it on the current revision', { round_id: r.round_id, base_revision: r.base_revision, current_revision: ctx.revision });
    if (r.base_revision !== ctx.revision || r.authority_epoch !== ctx.authority_epoch) {
      await client.query("UPDATE catalog_playback_rounds SET status = 'STALE', updated_at = now() WHERE user_id = $1 AND round_id = $2", [uid, r.round_id]);
      throw Object.assign(new CatalogQueryError('ROUND_STALE', 409, 'library revision changed: rebuild the round on the current revision', { round_id: r.round_id, base_revision: r.base_revision, current_revision: ctx.revision }), { commit: true });
    }
  }
  async function finish(client, uid, round, result, kind, idempotencyKey, nextSequence) {
    await client.query('UPDATE catalog_playback_rounds SET remaining = $3::bigint, sequence = $4::bigint, status = CASE WHEN $3::bigint = 0 AND status = $5 THEN $6 ELSE status END, updated_at = now() WHERE user_id = $1 AND round_id = $2', [uid, round.round_id, round.remaining, nextSequence, 'ACTIVE', 'COMPLETE']);
    if (idempotencyKey) await client.query('INSERT INTO catalog_round_commands(user_id, round_id, idempotency_key, kind, sequence, result_json) VALUES ($1, $2, $3, $4, $5::bigint, $6)', [uid, round.round_id, idempotencyKey, kind, nextSequence, canonicalJson(result)]);
    return result;
  }

  // ---------- POST /playback/rounds ----------
  async function startRound({ userId, era, epoch, setId, currentBeatId = null, consumerId, fromRoundId = null } = {}) {
    if (typeof setId !== 'string' || !ID_RE.test(setId)) throw inputInvalid('SET_ID');
    if (typeof consumerId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(consumerId)) throw inputInvalid('CONSUMER_ID');
    if (fromRoundId !== null && (typeof fromRoundId !== 'string' || !ID_RE.test(fromRoundId))) throw inputInvalid('FROM_ROUND_ID');
    const roundId = `rnd-${randomUUID()}`;
    const created = await mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const set = await readySet(client, uid, ctx, setId);
      let from = null;
      if (fromRoundId) { from = (await client.query(ROUND_SQL, [uid, fromRoundId])).rows[0]; if (!from) throw notFound('round'); }
      await client.query(`INSERT INTO catalog_query_set_leases(user_id, set_id, consumer_id, consumer_kind, lease_until) VALUES ($1, $2, $3, 'SHUFFLE', now() + make_interval(mins => $4::int))
        ON CONFLICT (user_id, set_id, consumer_id) DO UPDATE SET lease_until = EXCLUDED.lease_until, consumer_kind = EXCLUDED.consumer_kind`, [uid, setId, consumerId, LEASE_MINUTES]);
      await client.query(`INSERT INTO catalog_playback_rounds(user_id, round_id, set_id, generation_id, authority_epoch, base_revision, status, member_count, remaining, sequence, consumer_id, rebuild_from)
        VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7, $8::bigint, $8::bigint, 0, $9, $10)`, [uid, roundId, setId, ctx.generation_id, ctx.authority_epoch, ctx.revision, from ? 'BUILDING' : 'ACTIVE', set.memberCount, consumerId, fromRoundId]);
      const round = await lockRound(client, uid, roundId);
      let currentConsumed = false;
      // la canción actual ya iniciada se consume si pertenece al query y hay más de un miembro (evita la repetición inmediata)
      if (currentBeatId && set.memberCount > 1) { const s = await slotOfBeat(client, uid, setId, currentBeatId); if (s) currentConsumed = await consumeSlot(client, uid, round, s.slot, currentBeatId, 0, 'CURRENT'); }
      await client.query('UPDATE catalog_playback_rounds SET remaining = $3::bigint, updated_at = now() WHERE user_id = $1 AND round_id = $2', [uid, roundId, round.remaining]);
      return roundDto({ ...round, remaining: round.remaining }, { currentConsumed, created: true });
    });
    if (created.status !== 'BUILDING') return created;
    // reconstrucción en lotes (transacciones cortas) hasta ACTIVE o hasta el límite de bucles (el cliente puede seguir con /rebuild)
    let r = created;
    for (let i = 0; i < REBUILD_MAX_LOOPS && r.status === 'BUILDING'; i++) r = await rebuildRound({ userId, era, epoch, roundId });
    return { ...r, created: true, currentConsumed: created.currentConsumed };
  }
  // ---------- POST /playback/rounds/:id/rebuild (lote ≤240 de consumidos de la ronda anterior) ----------
  async function rebuildRound({ userId, era, epoch, roundId, batch = REBUILD_BATCH } = {}) {
    if (typeof roundId !== 'string' || !ID_RE.test(roundId)) throw inputInvalid('ROUND_ID');
    const n = Math.min(REBUILD_BATCH, Math.max(1, batch));
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const round = await lockRound(client, uid, roundId);
      if (round.status !== 'BUILDING') return roundDto(round, { processed: 0 });
      await assertRoundFresh(client, uid, ctx, round);
      const cursor = Number(round.rebuild_cursor);
      const prev = (await client.query('SELECT c.beat_id FROM catalog_round_consumed c WHERE c.user_id = $1 AND c.round_id = $2 ORDER BY c.consumed_at, c.beat_id COLLATE "C" OFFSET $3 LIMIT $4', [uid, round.rebuild_from, cursor, n])).rows;
      let processed = 0;
      for (const p of prev) {
        const s = await slotOfBeat(client, uid, round.set_id, p.beat_id);
        if (s && await consumeSlot(client, uid, round, s.slot, p.beat_id, 0, 'REBUILD')) processed++;
      }
      const done = prev.length < n;
      await client.query('UPDATE catalog_playback_rounds SET remaining = $3::bigint, rebuild_cursor = $4::bigint, status = $5, updated_at = now() WHERE user_id = $1 AND round_id = $2', [uid, roundId, round.remaining, cursor + prev.length, done ? 'ACTIVE' : 'BUILDING']);
      return roundDto({ ...round, status: done ? 'ACTIVE' : 'BUILDING', rebuild_cursor: String(cursor + prev.length) }, { processed, scanned: prev.length });
    });
  }

  // ---------- POST /playback/rounds/:id/next ----------
  async function nextInRound({ userId, era, epoch, roundId, sequence, idempotencyKey, rng = randomBytes } = {}) {
    if (typeof roundId !== 'string' || !ID_RE.test(roundId)) throw inputInvalid('ROUND_ID');
    if (!/^[0-9]{1,18}$/.test(String(sequence ?? ''))) throw inputInvalid('SEQUENCE');
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) throw inputInvalid('IDEMPOTENCY_KEY');
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const round = await lockRound(client, uid, roundId);
      const replay = (await client.query('SELECT result_json FROM catalog_round_commands WHERE user_id = $1 AND round_id = $2 AND idempotency_key = $3', [uid, roundId, idempotencyKey])).rows[0];
      if (replay) return { ...JSON.parse(replay.result_json), replay: true };
      if (round.status === 'BUILDING') throw new CatalogQueryError('ROUND_BUILDING', 409, 'round is still being rebuilt', { round_id: roundId });
      if (round.status === 'RELEASED') throw new CatalogQueryError('ROUND_RELEASED', 409, 'round was released', { round_id: roundId });
      await assertRoundFresh(client, uid, ctx, round);
      if (round.sequence !== String(sequence)) throw new CatalogQueryError('SEQUENCE_MISMATCH', 409, 'a newer musical command was already applied', { current_sequence: round.sequence });
      const m = Number(round.remaining); const nextSequence = String(Number(round.sequence) + 1);
      if (m === 0) return finish(client, uid, round, { roundId, beatId: null, version: null, slot: null, remaining: 0, sequence: nextSequence, roundComplete: true }, 'NEXT', idempotencyKey, nextSequence);
      const j = uniformInt(m, rng); // nunca con m = 0
      const drawn = await swapOut(client, uid, roundId, j, m);
      const member = await memberAtSlot(client, uid, round.set_id, drawn);
      await client.query('INSERT INTO catalog_round_consumed(user_id, round_id, beat_id, slot, sequence, reason) VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6)', [uid, roundId, member.beatId, drawn, nextSequence, 'DRAW']);
      round.remaining = String(m - 1);
      return finish(client, uid, round, { roundId, beatId: member.beatId, version: member.version, slot: drawn, remaining: m - 1, sequence: nextSequence, roundComplete: m - 1 === 0 }, 'NEXT', idempotencyKey, nextSequence);
    });
  }
  // ---------- POST /playback/rounds/:id/consume (play directo / cola: quita ese miembro de los candidatos) ----------
  async function consumeInRound({ userId, era, epoch, roundId, beatId, sequence, idempotencyKey } = {}) {
    if (typeof roundId !== 'string' || !ID_RE.test(roundId)) throw inputInvalid('ROUND_ID');
    if (typeof beatId !== 'string' || !beatId) throw inputInvalid('BEAT_ID');
    if (!/^[0-9]{1,18}$/.test(String(sequence ?? ''))) throw inputInvalid('SEQUENCE');
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) throw inputInvalid('IDEMPOTENCY_KEY');
    return mutationTx(userId, { era, epoch }, async (client, ctx, uid) => {
      const round = await lockRound(client, uid, roundId);
      const replay = (await client.query('SELECT result_json FROM catalog_round_commands WHERE user_id = $1 AND round_id = $2 AND idempotency_key = $3', [uid, roundId, idempotencyKey])).rows[0];
      if (replay) return { ...JSON.parse(replay.result_json), replay: true };
      if (round.status === 'BUILDING') throw new CatalogQueryError('ROUND_BUILDING', 409, 'round is still being rebuilt', { round_id: roundId });
      if (round.status === 'RELEASED') throw new CatalogQueryError('ROUND_RELEASED', 409, 'round was released', { round_id: roundId });
      await assertRoundFresh(client, uid, ctx, round);
      if (round.sequence !== String(sequence)) throw new CatalogQueryError('SEQUENCE_MISMATCH', 409, 'a newer musical command was already applied', { current_sequence: round.sequence });
      const nextSequence = String(Number(round.sequence) + 1);
      const s = await slotOfBeat(client, uid, round.set_id, beatId);
      if (!s) return finish(client, uid, round, { roundId, beatId, consumed: false, member: false, remaining: Number(round.remaining), sequence: nextSequence, roundComplete: Number(round.remaining) === 0 }, 'CONSUME', idempotencyKey, nextSequence);
      const consumed = await consumeSlot(client, uid, round, s.slot, beatId, nextSequence, 'EXPLICIT');
      return finish(client, uid, round, { roundId, beatId, consumed, member: true, remaining: Number(round.remaining), sequence: nextSequence, roundComplete: Number(round.remaining) === 0 }, 'CONSUME', idempotencyKey, nextSequence);
    });
  }
  async function getRound({ userId, roundId } = {}) {
    if (typeof roundId !== 'string' || !ID_RE.test(roundId)) throw inputInvalid('ROUND_ID');
    return readTx(userId, async (client, uid) => {
      const r = (await client.query(ROUND_SQL, [uid, roundId])).rows[0]; if (!r) throw notFound('round');
      const c = (await client.query('SELECT count(*)::int AS n FROM catalog_round_consumed WHERE user_id = $1 AND round_id = $2', [uid, roundId])).rows[0].n;
      return roundDto(r, { consumedCount: c });
    });
  }
  async function releaseRound({ userId, era, epoch, roundId } = {}) {
    if (typeof roundId !== 'string' || !ID_RE.test(roundId)) throw inputInvalid('ROUND_ID');
    return mutationTx(userId, { era, epoch }, async (client, _ctx, uid) => {
      const r = await lockRound(client, uid, roundId);
      if (r.status !== 'RELEASED') await client.query("UPDATE catalog_playback_rounds SET status = 'RELEASED', updated_at = now() WHERE user_id = $1 AND round_id = $2", [uid, roundId]);
      await client.query('DELETE FROM catalog_query_set_leases WHERE user_id = $1 AND set_id = $2 AND consumer_id = $3', [uid, r.set_id, r.consumer_id]);
      return roundDto({ ...r, status: 'RELEASED' });
    });
  }
  // ---------- GET /query-sets/:id/neighbor?beatId&direction (I2: Next/Previous globales sobre el orden del conjunto) ----------
  async function neighbor({ userId, setId, beatId, direction, sort = 'manual' } = {}) {
    if (typeof setId !== 'string' || !ID_RE.test(setId)) throw inputInvalid('SET_ID');
    if (!['next', 'previous'].includes(direction)) throw inputInvalid('DIRECTION');
    if (!SORTS.includes(sort)) throw inputInvalid('SORT');
    return readTx(userId, async (client, uid) => {
      const s = (await client.query('SELECT status, generation_id, member_count::text AS n, base_revision::text AS base_revision FROM catalog_query_sets WHERE user_id = $1 AND set_id = $2', [uid, setId])).rows[0];
      if (!s) throw notFound('query set');
      if (s.status !== 'READY') throw new CatalogQueryError('CURSOR_STALE', 409, `query set is ${s.status}`, { status: s.status });
      const n = Number(s.n);
      if (n === 0) return { setId, beatId: null, version: null, slot: null, member: false, total: 0, revision: s.base_revision, sort };
      const cur = typeof beatId === 'string' && beatId ? await slotOfBeat(client, uid, setId, beatId) : null;
      const fwd = direction === 'next';
      let row;
      if (sort === 'manual') {
        // el conjunto se construye en orden manual: slot ± 1; fuera del query → primero/último (r4 I2)
        const target = cur ? cur.slot + (fwd ? 1 : -1) : fwd ? 0 : n - 1;
        if (target < 0 || target >= n) return { setId, beatId: null, version: null, slot: null, member: Boolean(cur), total: n, revision: s.base_revision, sort, edge: fwd ? 'end' : 'start' };
        const m = await memberAtSlot(client, uid, setId, target); row = m;
      } else {
        // otros sorts: keyset sobre miembros ∪ beats con la misma tupla de orden que la Gallery (T06), sin cargar el conjunto
        const tuple = `ROW(${TUPLES[sort].join(', ')})`;
        const base = `FROM catalog_query_members m JOIN catalog_beats b ON b.user_id = m.user_id AND b.generation_id = m.generation_id AND b.beat_id = m.beat_id WHERE m.user_id = $1 AND m.set_id = $2`;
        const order = TUPLES[sort].map((c) => `${c}${fwd ? '' : ' DESC'}`).join(', ');
        const where = cur ? ` AND ${tuple} ${fwd ? '>' : '<'} (SELECT ${TUPLES[sort].join(', ')} FROM catalog_beats b WHERE b.user_id = $1 AND b.generation_id = $3 AND b.beat_id = $4)` : '';
        const r = (await client.query(`SELECT m.beat_id, m.expected_version::text AS version, m.slot::text AS slot ${base}${where} ORDER BY ${order} LIMIT 1`, cur ? [uid, setId, s.generation_id, beatId] : [uid, setId])).rows[0];
        if (!r) return { setId, beatId: null, version: null, slot: null, member: Boolean(cur), total: n, revision: s.base_revision, sort, edge: fwd ? 'end' : 'start' };
        row = { beatId: r.beat_id, version: r.version, slot: Number(r.slot) };
      }
      return { setId, beatId: row.beatId, version: row.version, slot: row.slot, member: Boolean(cur), total: n, revision: s.base_revision, sort };
    });
  }

  return Object.freeze({ startRound, rebuildRound, nextInRound, consumeInRound, getRound, releaseRound, neighbor, limits: Object.freeze({ REBUILD_BATCH, REBUILD_MAX_LOOPS, LEASE_MINUTES }) });
}

let configured = null;
function configureCatalogPlayback(options = null) { configured = options && options.pool && options.authority ? createCatalogPlayback(options) : null; return configured; }
function currentCatalogPlayback() { return configured; }

module.exports = { REBUILD_BATCH, RNG_BITS, uniformInt, createMemoryRound, createCatalogPlayback, configureCatalogPlayback, currentCatalogPlayback };
