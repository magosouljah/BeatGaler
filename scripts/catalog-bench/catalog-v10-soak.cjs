#!/usr/bin/env node
'use strict';
// V10 — Capacidad y leak soak (MATRIZ-V-NIVELES-20261107.md §V10, parte servidor sin navegador).
// Mide, sobre el LAB PostgreSQL 18 efímero en WSL (scripts/catalog-bench/lab-wsl-descriptor.json), lo que
// catalog-benchmark.cjs (T20) NO cubrió: Shuffle (preparación + ronda completa + disco/WAL), Select All /
// facetas server-side a escala, soak >=20 min con picos/tendencia de memoria (--expose-gc), y escritores
// concurrentes mutando mientras se lee/selecciona. Mismo patrón de allowlist de entorno y DB efímera que
// catalog-benchmark.cjs; nunca reduce n, umbrales ni duración del soak.
//
// Uso:
//   node --expose-gc scripts/catalog-bench/catalog-v10-soak.cjs --n 100000 [--seed 777] [--out tmp/catalog-v10/<run>]
//     [--soak-ms 1200000] [--sample-interval-ms 15000] [--gc-interval-ms 120000] [--writers 5]
//     [--keep-db] [--descriptor <path>] [--smoke]

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..');
const CLOUD = path.join(REPO, 'cloud-server');

const ENV_ALLOW = new Set([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'TZ', 'CI', 'GITHUB_ACTIONS',
  'CATALOG_TEST_ADMIN_URL', 'CATALOG_TEST_INSTANCE_ID',
]);
const HARNESS_BENIGN = /^CLAUDE_CODE_|^SESSIONNAME$|^AWS_SDK_LOAD_CONFIG$/i;
const SENSITIVE = /^DATABASE_URL$|^RESTORE_DATABASE_URL$|^PG(?!_)[A-Z]*$|AWS_(ACCESS|SECRET|SESSION)|TELEGRAM|POLAR|SMTP|^SES_|_SECRET\b|_TOKEN\b|BOT_TOKEN|PASSWORD|PASSWD|_API_KEY|APIKEY|BEATGALER_(?!CATALOG_NATIVE_ENABLED)|MASTER_KEY/i;

function assertSafeEnv(env) {
  const extra = Object.keys(env).filter((k) => !ENV_ALLOW.has(k) && !HARNESS_BENIGN.test(k));
  const sensitive = extra.filter((k) => SENSITIVE.test(k));
  if (sensitive.length) {
    throw Object.assign(new Error(`catalog-v10-soak: variables de entorno sensibles presentes (no se imprimen valores): ${sensitive.sort().join(', ')}`), { exit: 5 });
  }
  return { extraCount: extra.length, extraNames: extra.sort() };
}

const db = require(path.join(CLOUD, 'tests', 'helpers', 'catalog-test-db.cjs'));
const mig = require(path.join(CLOUD, 'postgres-migrations.js'));
const authorityMod = require(path.join(CLOUD, 'catalog', 'authority.js'));
const queriesMod = require(path.join(CLOUD, 'catalog', 'queries.js'));
const commandsMod = require(path.join(CLOUD, 'catalog', 'commands.js'));
const playbackMod = require(path.join(CLOUD, 'catalog', 'playback.js'));
const operationsMod = require(path.join(CLOUD, 'catalog', 'operations.js'));
const { generateLibrary, TAG_VOCAB_SIZE } = require(path.join(__dirname, 'generator.cjs'));
const { Pool } = require(path.join(CLOUD, 'node_modules', 'pg'));

function parseArgs(argv) {
  const out = {
    n: null, seed: 777, outDir: null, soakMs: 1200000, sampleIntervalMs: 15000, gcIntervalMs: 120000,
    writers: 5, keepDb: false, descriptor: path.join(__dirname, 'lab-wsl-descriptor.json'), smoke: false, maxDraws: Infinity, noDrain: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--soak-ms') out.soakMs = Number(argv[++i]);
    else if (a === '--sample-interval-ms') out.sampleIntervalMs = Number(argv[++i]);
    else if (a === '--gc-interval-ms') out.gcIntervalMs = Number(argv[++i]);
    else if (a === '--writers') out.writers = Number(argv[++i]);
    else if (a === '--max-draws') out.maxDraws = Number(argv[++i]);
    else if (a === '--no-drain') out.noDrain = true;
    else if (a === '--keep-db') out.keepDb = true;
    else if (a === '--descriptor') out.descriptor = argv[++i];
    else if (a === '--smoke') { out.smoke = true; out.soakMs = 20000; out.sampleIntervalMs = 2000; out.gcIntervalMs = 8000; }
    else throw Object.assign(new Error(`argumento desconocido: ${a}`), { exit: 2 });
  }
  if (!Number.isInteger(out.n) || out.n < 0) throw Object.assign(new Error('--n es obligatorio (entero >= 0)'), { exit: 2 });
  if (!out.soakMs || out.soakMs < (out.smoke ? 1000 : 1200000)) throw Object.assign(new Error('--soak-ms debe ser >= 1200000 (20 min) salvo --smoke'), { exit: 2 });
  if (!out.outDir) out.outDir = path.join(REPO, 'tmp', 'catalog-v10', `n${out.n}-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`);
  return out;
}

function percentile(sortedMs, p) {
  if (!sortedMs.length) return null;
  const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1));
  return sortedMs[idx];
}
function statsOf(msArr) {
  const ms = msArr.slice().sort((a, b) => a - b);
  return { count: ms.length, p50_ms: percentile(ms, 50), p95_ms: percentile(ms, 95), p99_ms: percentile(ms, 99), min_ms: ms[0] ?? null, max_ms: ms.length ? ms[ms.length - 1] : null, mean_ms: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : null };
}
async function timeMs(fn) {
  const t0 = process.hrtime.bigint();
  const value = await fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, value };
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
// Reintento de arnés (NO del producto): a 1M filas, un paso aislado puede chocar con el STATEMENT_TIMEOUT_MS=1000ms
// del propio catálogo (queries.js) por presión de I/O/checkpoint tras la generación masiva, sin que eso sea un fallo
// de diseño del paso (es idempotente/retomable por su propio cursor). Se reintenta con backoff y se CUENTA cada
// timeout real (nunca se descarta como outlier ni se sube el umbral del producto); si persiste tras el presupuesto
// de reintentos, el error se propaga como hallazgo real (posible STOP-PERF/STOP-SHUFFLE-PERF).
async function withHarnessRetry(fn, { attempts = 6, baseDelayMs = 500, onTimeout = () => {} } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (error) {
      if (error?.code !== 'CATALOG_QUERY_TIMEOUT' && !/CATALOG_QUERY_TIMEOUT/.test(String(error?.message))) throw error;
      lastError = error; onTimeout(i, error);
      await sleep(baseDelayMs * (i + 1));
    }
  }
  throw lastError;
}

async function walLsnDiffBytes(pool, lsnBefore) {
  const r = await pool.query('SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::text AS diff', [lsnBefore]);
  return Number(r.rows[0].diff);
}
async function currentWalLsn(pool) { return (await pool.query('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0].lsn; }
async function relSizesBytes(pool, names) {
  const r = await pool.query(`SELECT relname, pg_total_relation_size(oid)::text AS bytes FROM pg_class WHERE relname = ANY($1::text[])`, [names]);
  const out = {};
  for (const row of r.rows) out[row.relname] = Number(row.bytes);
  for (const n of names) if (!(n in out)) out[n] = 0;
  return out;
}
function diffSizes(before, after) { const out = {}; for (const k of Object.keys(after)) out[k] = after[k] - (before[k] || 0); return out; }

// ---------- V10-B: preparación fría/caliente + ronda completa Shuffle (p95 sorteos, disco/WAL) ----------
async function measureShuffleFullRound({ q, cmd, playback, pool, lib, label, maxDraws = Infinity, drainRemainder = true }) {
  const consumerId = `v10-shuffle-${crypto.randomUUID().slice(0, 8)}`;
  const walBefore = await currentWalLsn(pool);
  const sizesBefore = await relSizesBytes(pool, ['catalog_round_mapping', 'catalog_round_consumed', 'catalog_query_members', 'catalog_query_sets']);

  // preparación fría: createQuerySet + stepQuerySet hasta READY (todo el conjunto READY, sin filtro: biblioteca ACTIVE completa)
  const prepT0 = process.hrtime.bigint();
  let buildTimeouts = 0;
  const created = await withHarnessRetry(() => q.createQuerySet({ userId: lib.userId, query: {}, consumer: { id: consumerId, kind: 'SHUFFLE' } }), { onTimeout: () => { buildTimeouts++; } });
  let setId = created.setId; let s = created; let steps = 0; const stepMs = [];
  while (s.status === 'BUILDING') {
    const { ms, value } = await timeMs(() => withHarnessRetry(() => q.stepQuerySet({ userId: lib.userId, setId }), { onTimeout: () => { buildTimeouts++; } }));
    stepMs.push(ms); steps++; s = value;
  }
  const prepColdMs = Number(process.hrtime.bigint() - prepT0) / 1e6;
  if (s.status !== 'READY') throw new Error(`query set no llegó a READY: status=${s.status}`);

  // preparación caliente: reconstruir desde cero el mismo predicate_hash reusa el set existente (createQuerySet idempotente por predicate_hash+revision)
  const warmT0 = process.hrtime.bigint();
  const reused = await q.createQuerySet({ userId: lib.userId, query: {}, consumer: { id: `${consumerId}-warm`, kind: 'SHUFFLE' } });
  const prepWarmMs = Number(process.hrtime.bigint() - warmT0) / 1e6;

  // startRound: abre la ronda sobre el set READY (member_count miembros)
  const startT0 = process.hrtime.bigint();
  const round = await playback.startRound({ userId: lib.userId, era: lib.era, epoch: lib.epoch, setId, consumerId, currentBeatId: null });
  const startMs = Number(process.hrtime.bigint() - startT0) / 1e6;
  if (round.status !== 'ACTIVE') throw new Error(`ronda no quedó ACTIVE: status=${round.status}`);

  // checkpoint de disco/WAL tras preparación (antes de sortear): aísla el coste de construcción+apertura del coste de sorteo.
  const walAfterPrep = await walLsnDiffBytes(pool, walBefore);
  const sizesAfterPrep = await relSizesBytes(pool, ['catalog_round_mapping', 'catalog_round_consumed', 'catalog_query_members', 'catalog_query_sets']);
  const walBeforeDraws = await currentWalLsn(pool);

  // ronda completa: sortear hasta remaining=0 (o hasta maxDraws si el presupuesto de reloj no permite N sorteos reales 1:1,
  // p.ej. a 1M miembros); el conjunto y la ronda SIGUEN siendo completos (memberCount real), solo el número de sorteos
  // cronometrados individualmente queda acotado y la cola se completa sin medir cada uno por separado (ver drained_without_timing).
  let drawTimeouts = 0;
  const drawMs = []; let sequence = round.sequence; let remaining = round.memberCount; let drew = 0;
  while (remaining > 0 && drew < maxDraws) {
    const { ms, value } = await timeMs(() => withHarnessRetry(() => playback.nextInRound({ userId: lib.userId, era: lib.era, epoch: lib.epoch, roundId: round.roundId, sequence, idempotencyKey: `v10-draw-${crypto.randomUUID()}` }), { onTimeout: () => { drawTimeouts++; } }));
    drawMs.push(ms); sequence = value.sequence; remaining = value.remaining; drew++;
    if (value.roundComplete) break;
  }
  const walAfterTimedDraws = await walLsnDiffBytes(pool, walBeforeDraws);
  const leftUnplayed = remaining;
  if (drainRemainder) {
    while (remaining > 0) {
      const value = await withHarnessRetry(() => playback.nextInRound({ userId: lib.userId, era: lib.era, epoch: lib.epoch, roundId: round.roundId, sequence, idempotencyKey: `v10-drain-${crypto.randomUUID()}` }), { onTimeout: () => { drawTimeouts++; } });
      sequence = value.sequence; remaining = value.remaining;
      if (value.roundComplete) break;
    }
  }
  const roundFullyDrawn = remaining === 0;

  const walAfter = await walLsnDiffBytes(pool, walBefore);
  const sizesAfter = await relSizesBytes(pool, ['catalog_round_mapping', 'catalog_round_consumed', 'catalog_query_members', 'catalog_query_sets']);
  const sizesDelta = diffSizes(sizesBefore, sizesAfter);
  const sizesDeltaPrep = diffSizes(sizesBefore, sizesAfterPrep);

  await playback.releaseRound({ userId: lib.userId, era: lib.era, epoch: lib.epoch, roundId: round.roundId }).catch(() => {});

  return {
    label, setId, memberCount: round.memberCount, steps_qs_build: steps, build_timeouts_retried: buildTimeouts, draw_timeouts_retried: drawTimeouts,
    prep_cold_ms: Math.round(prepColdMs), prep_warm_reuse_ms: Math.round(prepWarmMs * 1000) / 1000, warm_reused: reused.reused === true,
    qs_build_step_stats: statsOf(stepMs), start_round_ms: Math.round(startMs * 1000) / 1000,
    wal_bytes_prep_build_open: walAfterPrep, table_size_delta_prep_build_open_bytes: sizesDeltaPrep,
    draws_timed: drew, draws_total_in_round: round.memberCount,
    round_fully_drawn: roundFullyDrawn, drain_remainder_requested: drainRemainder, left_unplayed_before_drain: leftUnplayed,
    draw_stats: statsOf(drawMs),
    wal_bytes_timed_draws_total: walAfterTimedDraws, wal_bytes_per_timed_draw: drew ? Math.round((walAfterTimedDraws / drew) * 100) / 100 : null,
    wal_bytes_round_grand_total: walAfter,
    table_size_delta_bytes_grand_total: sizesDelta, table_size_delta_bytes_per_member_grand_total: round.memberCount
      ? Object.fromEntries(Object.entries(sizesDelta).map(([k, v]) => [k, Math.round((v / round.memberCount) * 100) / 100])) : null,
    // Cada sorteo es O(1) (Fisher-Yates perezoso por swap, sin recorrer el remanente): el coste de una ronda completa
    // de N miembros es ~N * coste_medio_de_un_sorteo. Extrapolación aritmética explícita, no una medición exhaustiva cuando
    // drainRemainder=false o maxDraws < memberCount (ver round_fully_drawn/left_unplayed_before_drain).
    extrapolated_full_round_draw_wall_ms: drew ? Math.round(statsOf(drawMs).mean_ms * round.memberCount) : null,
    extrapolated_full_round_wal_bytes: drew ? Math.round((walAfterTimedDraws / drew) * round.memberCount) : null,
  };
}

// ---------- V10-B: Select All server-side + facetas, a escala ----------
async function measureSelectAllAndFacets({ q, cmd, lib, setId, memberCount, label }) {
  const consumerId = `v10-select-${crypto.randomUUID().slice(0, 8)}`;
  const { ms: selMs, value: selection } = await timeMs(() => cmd.createSelection({ userId: lib.userId, era: lib.era, epoch: lib.epoch, setId, sort: 'rating', defaultSelected: true, consumerId }));
  const facetsMs = [];
  for (let i = 0; i < 5; i++) { const { ms } = await timeMs(() => q.listFacets({ userId: lib.userId, query: {} })); facetsMs.push(ms); }
  const activeFacetsMs = [];
  for (let i = 0; i < 5; i++) { const t0 = process.hrtime.bigint(); await q.activeFacets ? q.activeFacets({ userId: lib.userId, keys: ['tags'] }).catch(() => null) : null; activeFacetsMs.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  await cmd.releaseSelection({ userId: lib.userId, era: lib.era, epoch: lib.epoch, selectionId: selection.selectionId }).catch(() => {});
  return {
    label, member_count: memberCount, select_all_ms: Math.round(selMs * 1000) / 1000,
    select_all_selected_count: selection.count ?? null,
    facets_stats: statsOf(facetsMs), active_facets_stats: statsOf(activeFacetsMs),
  };
}

// ---------- V10-B: soak >=20 min, backtracking, picos/tendencia de memoria ----------
async function soak({ q, lib, soakMs, sampleIntervalMs, gcIntervalMs, memOut }) {
  const gcAvailable = typeof global.gc === 'function';
  const series = []; const until = Date.now() + soakMs;
  let lastGc = Date.now();
  let dir = 1; let legacyOffset = 0;
  while (Date.now() < until) {
    // backtracking: recorrido adelante/atrás con listBeats cursor-less (legacy offset) + filtros alternados, carga repetida real.
    const batch = [];
    batch.push(q.listBeats({ userId: lib.userId, query: {} }));
    batch.push(q.listBeats({ userId: lib.userId, query: { includeTag: `tag${(legacyOffset % TAG_VOCAB_SIZE)}` } }));
    batch.push(q.resolveLegacyNavigation({ userId: lib.userId, query: { offset: String(Math.max(0, legacyOffset)) } }));
    await Promise.all(batch).catch(() => {});
    legacyOffset += dir * 37;
    if (legacyOffset > 9999 || legacyOffset < 0) { dir *= -1; legacyOffset = Math.max(0, Math.min(9999, legacyOffset)); }

    const now = Date.now();
    if (now - lastGc >= gcIntervalMs) {
      const beforeGc = process.memoryUsage();
      if (gcAvailable) global.gc();
      const afterGc = process.memoryUsage();
      series.push({ t_ms: now, rss_before_gc_mb: Math.round(beforeGc.rss / 1048576), rss_after_gc_mb: Math.round(afterGc.rss / 1048576), heap_used_before_gc_mb: Math.round(beforeGc.heapUsed / 1048576), heap_used_after_gc_mb: Math.round(afterGc.heapUsed / 1048576), gc_ran: gcAvailable });
      lastGc = now;
    } else {
      const mu = process.memoryUsage();
      series.push({ t_ms: now, rss_mb: Math.round(mu.rss / 1048576), heap_used_mb: Math.round(mu.heapUsed / 1048576), gc_ran: false });
    }
    await sleep(sampleIntervalMs);
  }
  memOut.gc_available = gcAvailable;
  memOut.series = series;
  const postGcPoints = series.filter((p) => 'rss_after_gc_mb' in p);
  memOut.post_gc_points = postGcPoints.length;
  if (postGcPoints.length >= 2) {
    const first = postGcPoints[0]; const last = postGcPoints[postGcPoints.length - 1];
    memOut.rss_after_gc_first_mb = first.rss_after_gc_mb; memOut.rss_after_gc_last_mb = last.rss_after_gc_mb;
    memOut.rss_after_gc_trend_mb = last.rss_after_gc_mb - first.rss_after_gc_mb;
    memOut.heap_after_gc_first_mb = first.heap_used_after_gc_mb; memOut.heap_after_gc_last_mb = last.heap_used_after_gc_mb;
    memOut.heap_after_gc_trend_mb = last.heap_used_after_gc_mb - first.heap_used_after_gc_mb;
  }
  memOut.rss_peak_mb = Math.max(...series.map((p) => p.rss_mb ?? p.rss_before_gc_mb ?? 0));
}

// ---------- V10-B: escritores concurrentes mutando mientras se lee/selecciona ----------
async function concurrentWriters({ q, cmd, lib, writers }) {
  const page = await q.listBeats({ userId: lib.userId, query: { limit: '240' } });
  const ids = page.items.map((i) => i.id);
  if (!ids.length) return { ok: false, reason: 'NO_ACTIVE_IDS' };
  const readerMs = []; let readerErrors = 0;
  const writerMs = []; let writerErrors = 0;
  const stop = { v: false };
  const reader = (async () => {
    while (!stop.v) {
      const { ms } = await timeMs(() => q.listBeats({ userId: lib.userId, query: {} }).catch((e) => { readerErrors++; throw e; })).catch(() => ({ ms: null }));
      if (ms !== null) readerMs.push(ms);
      await sleep(20);
    }
  })();
  const writerTasks = Array.from({ length: writers }, (_, wi) => (async () => {
    for (let round = 0; round < 20; round++) {
      const id = ids[(wi * 7 + round) % ids.length];
      try {
        const current = await q.getBeat({ userId: lib.userId, beatId: id });
        const { ms } = await timeMs(() => cmd.patchBeat({ userId: lib.userId, beatId: id, era: lib.era, epoch: lib.epoch, idempotencyKey: `v10-writer-${wi}-${round}-${crypto.randomUUID()}`, expectedVersion: current.version, patch: { rating: round % 6 } }));
        writerMs.push(ms);
      } catch (e) { writerErrors++; }
      await sleep(10);
    }
  })());
  await Promise.all(writerTasks);
  stop.v = true; await reader;
  return { ok: true, writers, reader_stats: statsOf(readerMs), reader_errors: readerErrors, writer_stats: statsOf(writerMs), writer_errors: writerErrors, writer_ops: writerMs.length };
}

async function main(argv) {
  const envInfo = assertSafeEnv(process.env);
  const args = parseArgs(argv);
  fs.mkdirSync(args.outDir, { recursive: true });

  const resourceCheck = {
    cpus_logical: os.cpus().length, total_mem_gib: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
    c11_lab_v1_target: { cpus_logical: 8, total_mem_gib: 16 },
    meets_c11_lab_v1: os.cpus().length >= 8 && os.totalmem() >= 16 * (1024 ** 3),
  };
  const descriptor = args.descriptor ? JSON.parse(fs.readFileSync(args.descriptor, 'utf8')) : undefined;
  const h = await db.createCatalogTestDb({ descriptor });
  const pool = new Pool({ ...h.config, max: Math.max(10, args.writers + 6) });
  let exitCode = 0;
  const summary = {
    schema: 'beatgaler.catalog-v10-soak-summary', version: 1, started_at: new Date().toISOString(),
    args: { n: args.n, seed: args.seed, soakMs: args.soakMs, sampleIntervalMs: args.sampleIntervalMs, gcIntervalMs: args.gcIntervalMs, writers: args.writers, smoke: args.smoke },
    env: { extra_vars_count: envInfo.extraCount, extra_vars: envInfo.extraNames },
    resource_check: resourceCheck,
    gc_flag_present: typeof global.gc === 'function',
    generation: null, shuffle: null, select_all_facets: null, soak: {}, concurrent_writers: null,
  };

  try {
    const genT0 = process.hrtime.bigint();
    await mig.applyMigrations(pool);
    const lib = await generateLibrary({ pool, userId: 'v10-u1', n: args.n, seed: args.seed, concurrency: Math.max(1, Math.min(4, os.cpus().length)), trashFraction: 0.10 });
    const genMs = Number(process.hrtime.bigint() - genT0) / 1e6;
    summary.generation = { ...lib, duration_ms: genMs, rows_per_sec: args.n ? Math.round((args.n / genMs) * 1000) : null };

    const auth = authorityMod.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' });
    const q = queriesMod.createCatalogQueries({ pool, authority: auth, cursorKeys: [{ kid: 'v10', secret: crypto.randomBytes(32) }] });
    const cmd = commandsMod.createCatalogCommands({ pool, authority: auth });
    const ops = operationsMod.createCatalogOperations({ pool, authority: auth, resolveAccess: async () => ({ maxBeats: null }) });
    const playback = playbackMod.createCatalogPlayback({ pool, authority: auth });

    // ---------- Shuffle: ronda completa (preparación fría/caliente, p95 sorteos, disco/WAL) ----------
    const shuffle = await measureShuffleFullRound({ q, cmd, playback, pool, lib, label: `n${args.n}`, maxDraws: args.maxDraws, drainRemainder: !args.noDrain });
    summary.shuffle = shuffle;

    // ---------- Select All server-side + facetas ----------
    summary.select_all_facets = await measureSelectAllAndFacets({ q, cmd, lib, setId: shuffle.setId, memberCount: shuffle.memberCount, label: `n${args.n}` });

    // ---------- Escritores concurrentes ----------
    summary.concurrent_writers = await concurrentWriters({ q, cmd, lib, writers: args.writers });

    // ---------- Soak >= 20 min, backtracking, picos/tendencia de memoria ----------
    const memBeforeSoak = process.memoryUsage();
    summary.soak.rss_before_mb = Math.round(memBeforeSoak.rss / 1048576);
    await soak({ q, lib, soakMs: args.soakMs, sampleIntervalMs: args.sampleIntervalMs, gcIntervalMs: args.gcIntervalMs, memOut: summary.soak });

    // ---------- SQL retenido al final ----------
    const activity = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'");
    const poolOpen = pool.totalCount - pool.idleCount;
    summary.sql_retained = { pool_total_count: pool.totalCount, pool_idle_count: pool.idleCount, pool_checked_out: poolOpen, pg_stat_activity_idle_in_transaction: activity.rows[0].n, acceptable: poolOpen === 0 && activity.rows[0].n === 0 };
  } catch (error) {
    exitCode = 1;
    summary.error = error.stack || error.message;
  } finally {
    await pool.end().catch(() => {});
    if (!args.keepDb) await h.cleanup().catch((e) => { summary.cleanup_error = e.message; });
    else summary.kept_db = h.config;
  }

  summary.finished_at = new Date().toISOString();
  fs.writeFileSync(path.join(args.outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const lines = [
    `catalog-v10-soak n=${args.n} seed=${args.seed} result=${exitCode === 0 ? 'DONE' : 'ERROR'} gc_flag=${summary.gc_flag_present}`,
    `recursos: ${resourceCheck.cpus_logical} vCPU / ${resourceCheck.total_mem_gib} GiB (objetivo 8/16) cumple=${resourceCheck.meets_c11_lab_v1}`,
  ];
  if (summary.shuffle) {
    const sh = summary.shuffle;
    lines.push(`shuffle: members=${sh.memberCount} qs_build_steps=${sh.steps_qs_build} build_timeouts_retried=${sh.build_timeouts_retried} draw_timeouts_retried=${sh.draw_timeouts_retried} prep_cold_ms=${sh.prep_cold_ms} prep_warm_reuse_ms=${sh.prep_warm_reuse_ms} start_round_ms=${sh.start_round_ms}`);
    lines.push(`  draws_timed=${sh.draws_timed}/${sh.draws_total_in_round} round_fully_drawn=${sh.round_fully_drawn} left_unplayed_before_drain=${sh.left_unplayed_before_drain} draw p50=${sh.draw_stats.p50_ms?.toFixed(2)} p95=${sh.draw_stats.p95_ms?.toFixed(2)} p99=${sh.draw_stats.p99_ms?.toFixed(2)} ms extrapolated_full_round_ms=${sh.extrapolated_full_round_draw_wall_ms}`);
    lines.push(`  wal_bytes_prep=${sh.wal_bytes_prep_build_open} wal_bytes_timed_draws=${sh.wal_bytes_timed_draws_total} wal_per_timed_draw=${sh.wal_bytes_per_timed_draw} wal_grand_total=${sh.wal_bytes_round_grand_total} table_delta_per_member=${JSON.stringify(sh.table_size_delta_bytes_per_member_grand_total)}`);
  }
  if (summary.select_all_facets) {
    const sa = summary.select_all_facets;
    lines.push(`select_all: members=${sa.member_count} ms=${sa.select_all_ms} selected_count=${sa.select_all_selected_count} | facets p50=${sa.facets_stats.p50_ms?.toFixed(2)} p95=${sa.facets_stats.p95_ms?.toFixed(2)}`);
  }
  if (summary.concurrent_writers) {
    const cw = summary.concurrent_writers;
    lines.push(`concurrent_writers: writers=${cw.writers} writer_ops=${cw.writer_ops} writer_errors=${cw.writer_errors} reader_errors=${cw.reader_errors} writer p95=${cw.writer_stats.p95_ms?.toFixed(1)} reader p95=${cw.reader_stats.p95_ms?.toFixed(1)}`);
  }
  if (summary.soak) {
    lines.push(`soak: rss_before=${summary.soak.rss_before_mb}MB rss_peak=${summary.soak.rss_peak_mb}MB post_gc_points=${summary.soak.post_gc_points} rss_after_gc_trend_mb=${summary.soak.rss_after_gc_trend_mb} heap_after_gc_trend_mb=${summary.soak.heap_after_gc_trend_mb}`);
  }
  if (summary.sql_retained) lines.push(`SQL retenido: checked_out=${summary.sql_retained.pool_checked_out} idle_in_tx=${summary.sql_retained.pg_stat_activity_idle_in_transaction} aceptable=${summary.sql_retained.acceptable}`);
  if (summary.error) lines.push(`ERROR: ${summary.error}`);
  fs.writeFileSync(path.join(args.outDir, 'summary.txt'), lines.join('\n') + '\n');
  process.stdout.write(lines.join('\n') + `\nsalida: ${args.outDir}\n`);
  return exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => { process.stderr.write(`catalog-v10-soak: ${e.message}\n`); process.exitCode = e.exit || 1; });
}
module.exports = { main, parseArgs, assertSafeEnv, percentile, statsOf };
