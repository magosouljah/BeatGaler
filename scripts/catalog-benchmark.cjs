#!/usr/bin/env node
'use strict';
// T20 — Benchmark de capacidad/latencia/contención del catálogo PostgreSQL (NATIVO-POSTGRES-20261108 r2.1 §8.6,
// TAREAS.md §T20, C12-DECISION-RECORD §7 perfil C11-LAB-v1).
//
// Uso:
//   node scripts/catalog-benchmark.cjs --n 100000 [--seed 777] [--out tmp/catalog-bench/<run>]
//     [--warmup-ms 120000] [--sample-ms 600000] [--smoke] [--clients 20] [--gen-concurrency 4]
//     [--keep-db] [--descriptor <path-a-json-descriptor>]
//
// Entorno: el proceso NO hereda DATABASE_URL/PG*/AWS/TELEGRAM/secretos del entorno del proyecto (ver ENV_ALLOW/
// SENSITIVE más abajo, mismo criterio que scripts/catalog-check.cjs). Solo usa:
//   CATALOG_TEST_ADMIN_URL, CATALOG_TEST_INSTANCE_ID  (mismas variables que cloud-server/tests/helpers/catalog-test-db.cjs)
// Crea una base PostgreSQL efímera (nunca una persistente ni la de desarrollo), la puebla con el generador sintético
// de scripts/catalog-bench/generator.cjs y la borra al salir salvo --keep-db.
//
// IMPORTANTE (restricción de entorno de esta máquina, ver informe T20 del coordinador): C11-LAB-v1 pide un host
// aislado de 8 vCPU/16 GiB con PostgreSQL limitado a 4 vCPU/8 GiB. Esta máquina solo tiene ~4 vCPU lógicos y
// ~13.4 GiB totales para TODO el proceso (benchmark + generador + PostgreSQL + SO). Este script NUNCA reduce `n`,
// los SLO de referencia ni el número de clientes para “hacer que pase”: si los recursos no alcanzan, lo registra
// en `resource_check` de summary.json (y lo dice en el resumen de texto) y deja que el resultado de los SLO hable
// por sí mismo. La decisión de aceptar esa limitación (STOP-ENV) le corresponde al coordinador, no a este script.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const CLOUD = path.join(REPO, 'cloud-server');

// ---------- entorno: allowlist por sistema + rechazo de variables sensibles (patrón de scripts/catalog-check.cjs) ----------
const ENV_ALLOW = new Set([
  'PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'TZ', 'CI', 'GITHUB_ACTIONS',
  'CATALOG_TEST_ADMIN_URL', 'CATALOG_TEST_INSTANCE_ID',
]);
// Riesgo real: credenciales de proyecto (DB/AWS/Telegram/etc.), nunca la plomería propia del arnés de agente que
// hospeda esta sesión (CLAUDE_CODE_*, SESSIONNAME de Windows, AWS_SDK_LOAD_CONFIG es solo un booleano de comportamiento).
const HARNESS_BENIGN = /^CLAUDE_CODE_|^SESSIONNAME$|^AWS_SDK_LOAD_CONFIG$/i;
const SENSITIVE = /^DATABASE_URL$|^RESTORE_DATABASE_URL$|^PG(?!_)[A-Z]*$|AWS_(ACCESS|SECRET|SESSION)|TELEGRAM|POLAR|SMTP|^SES_|_SECRET\b|_TOKEN\b|BOT_TOKEN|PASSWORD|PASSWD|_API_KEY|APIKEY|BEATGALER_(?!CATALOG_NATIVE_ENABLED)|MASTER_KEY/i;

function assertSafeEnv(env) {
  const extra = Object.keys(env).filter((k) => !ENV_ALLOW.has(k) && !HARNESS_BENIGN.test(k));
  const sensitive = extra.filter((k) => SENSITIVE.test(k));
  if (sensitive.length) {
    throw Object.assign(new Error(`catalog-benchmark: variables de entorno sensibles presentes (no se imprimen valores): ${sensitive.sort().join(', ')}`), { exit: 5 });
  }
  return { extraCount: extra.length, extraNames: extra.sort() };
}

const db = require(path.join(CLOUD, 'tests', 'helpers', 'catalog-test-db.cjs'));
const mig = require(path.join(CLOUD, 'postgres-migrations.js'));
const authorityMod = require(path.join(CLOUD, 'catalog', 'authority.js'));
const queriesMod = require(path.join(CLOUD, 'catalog', 'queries.js'));
const commandsMod = require(path.join(CLOUD, 'catalog', 'commands.js'));
const operationsMod = require(path.join(CLOUD, 'catalog', 'operations.js'));
const { generateLibrary, generateTenants, synthBeatDoc, TAG_VOCAB_SIZE } = require(path.join(__dirname, 'catalog-bench', 'generator.cjs'));
const { Pool } = require(path.join(CLOUD, 'node_modules', 'pg'));
const { runOracle } = require(path.join(__dirname, 'catalog-bench', 'facets-oracle.cjs'));

// ---------- CLI ----------
function parseArgs(argv) {
  const out = {
    n: null, seed: 777, outDir: null, warmupMs: 120000, sampleMs: 600000, smoke: false,
    clients: 20, genConcurrency: Math.max(1, Math.min(4, os.cpus().length)), keepDb: false, descriptor: null,
    // Variante multi-tenant (CONTRATO C11 "distribuciones 1.000×100…"): además de la biblioteca grande, `tenants` bibliotecas pequeñas
    // con vocabularios de tags distintos entre sí (>1000 etiquetas distintas en total con los valores por defecto).
    tenants: 0, tenantBeats: 500, tenantVocab: 10, pools: 20000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--warmup-ms') out.warmupMs = Number(argv[++i]);
    else if (a === '--sample-ms') out.sampleMs = Number(argv[++i]);
    else if (a === '--clients') out.clients = Number(argv[++i]);
    else if (a === '--gen-concurrency') out.genConcurrency = Number(argv[++i]);
    else if (a === '--tenants') out.tenants = Number(argv[++i]);
    else if (a === '--tenant-beats') out.tenantBeats = Number(argv[++i]);
    else if (a === '--tenant-vocab') out.tenantVocab = Number(argv[++i]);
    else if (a === '--pools') out.pools = Number(argv[++i]);
    else if (a === '--only') out.only = argv[++i].split(',');
    else if (a === '--keep-db') out.keepDb = true;
    else if (a === '--descriptor') out.descriptor = argv[++i];
    else if (a === '--smoke') { out.smoke = true; out.warmupMs = 2000; out.sampleMs = 5000; }
    else throw Object.assign(new Error(`argumento desconocido: ${a}`), { exit: 2 });
  }
  if (!Number.isInteger(out.n) || out.n < 0) throw Object.assign(new Error('--n es obligatorio (entero >= 0)'), { exit: 2 });
  if (!out.outDir) out.outDir = path.join(REPO, 'tmp', 'catalog-bench', `n${out.n}-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`);
  return out;
}

// ---------- utilidades de medición ----------
function percentile(sortedMs, p) {
  if (!sortedMs.length) return null;
  const idx = Math.min(sortedMs.length - 1, Math.max(0, Math.ceil((p / 100) * sortedMs.length) - 1));
  return sortedMs[idx];
}
function stats(samples) {
  const ms = samples.map((s) => s.ms).slice().sort((a, b) => a - b);
  const rows = samples.map((s) => s.rows).filter((v) => typeof v === 'number');
  const bytes = samples.map((s) => s.bytes).filter((v) => typeof v === 'number');
  const errors = samples.filter((s) => s.error).length;
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  return {
    count: samples.length, errors,
    p50_ms: percentile(ms, 50), p95_ms: percentile(ms, 95), p99_ms: percentile(ms, 99),
    min_ms: ms.length ? ms[0] : null, max_ms: ms.length ? ms[ms.length - 1] : null,
    mean_rows: mean(rows), max_rows: rows.length ? Math.max(...rows) : null,
    mean_bytes: mean(bytes), max_bytes: bytes.length ? Math.max(...bytes) : null,
  };
}
async function timeIt(fn) {
  const t0 = process.hrtime.bigint();
  try {
    const value = await fn();
    // Un perfil con preparación no medida (p.ej. bulk: construir selección/operación) devuelve `__timed_ms` con el tramo medido.
    const ms = typeof value?.__timed_ms === 'number' ? value.__timed_ms : Number(process.hrtime.bigint() - t0) / 1e6;
    const bytes = value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
    const rows = Array.isArray(value?.items) ? value.items.length : undefined;
    return { ms, bytes, rows, error: null };
  } catch (error) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ms, bytes: 0, rows: undefined, error: error.code || error.message };
  }
}
async function runFor(ms, fn) {
  const samples = [];
  const until = Date.now() + ms;
  do { samples.push(await timeIt(fn)); } while (Date.now() < until);
  return samples;
}

// ---------- clasificación de perfiles (cita normativa) ----------
// OBLIGATORIO = SLO exigido (afecta a summary.slo.pass). INFORMATIVO = se mide y se compara con la referencia de 250 ms, sin afectar al PASS.
//  - CONTRATO C11: "Requisitos duros: metadata GET/PATCH/trash/restore ... cambios de metadatos independientes de N beats"; "SLO ...
//    API metadata p95 <=250 ms/p99 <=1 s ... PATCH p95 <=250 ms"; "1-2 caracteres, terminos frecuentes, paginas profundas, cache frio y
//    biblioteca muy activa son perfiles obligatorios".
//  - C12-DECISION-RECORD §7 "Escenarios obligatorios": primera pagina, keyset profundo, resolver legacy hasta 10.000, filtros
//    raros/frecuentes, q1/2 caracteres, busquedas sin matches, exact COUNT filtrado, 20 escritores/lectores; "SLO se exige en perfiles
//    requeridos". Datasets C11 "distribuciones 1.000x100, 1.000x1.000, 1x100.000" -> la variante multi-tenant de filter_rare_tag.
const PROFILE_CLASS = {
  page1: 'obligatorio', filter_frequent_tag: 'obligatorio', filter_rare_tag: 'obligatorio', filter_short_q: 'obligatorio', count_exact: 'obligatorio',
  legacy_nav_offset0: 'obligatorio', legacy_nav_offset_deep: 'obligatorio', read_one: 'obligatorio', edit_patch: 'obligatorio',
  // nuevos (T20-N): PATCH de tags = PATCH (p95<=250); trash/restore = "metadata GET/PATCH/trash/restore" de C11; sin matches = §7.
  edit_patch_tags: 'obligatorio', trash_one: 'obligatorio', restore_one: 'obligatorio', filter_nomatch_q_short: 'obligatorio', filter_nomatch_q_long: 'obligatorio',
  // informativos: el roundtrip suma dos mutaciones (se evalua cada una por separado); bulk por lote y q>=3 raro no figuran en la lista de §7/C11.
  trash_restore_roundtrip: 'informativo', bulk_tags_batch: 'informativo', filter_rare_q: 'informativo', transfer_queue_fake_gateway: 'informativo',
};

// Estado compartido entre el arranque frio y la muestra caliente: pools de beats con version rastreada (cada mutacion devuelve la nueva
// version; nadie mas escribe durante el benchmark). Se prepara una vez, fuera de toda medicion.
async function prepareShared({ pool, q, cmd, lib, poolSize }) {
  const sel = (mod) => pool.query(`SELECT beat_id, version::text AS version, legacy_json FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE'
    AND abs(hashtext(beat_id)) % 200 = $3 ORDER BY beat_id LIMIT $4`, [lib.userId, lib.generationId, mod, poolSize]);
  const activePool = (await sel(7)).rows.map((r) => ({ id: r.beat_id, version: r.version }));
  const patchPool = (await sel(11)).rows.slice(0, 5000).map((r) => ({ id: r.beat_id, version: r.version, tags: JSON.parse(r.legacy_json).tags || [] }));
  // restore_one necesita beats ya en papelera: se mueven 5000 a TRASH (lotes de 50, fuera de medicion).
  const trashedPool = [];
  const seed = activePool.splice(0, Math.min(5000, Math.floor(activePool.length / 2)));
  // Preparación (fuera de medición): lotes de 10, no de 50. Un trash de 50 beats a 1M tarda ~0,5-0,65 s con la caché caliente (cascada FK de
  // state hacia grupos + triggers) y supera el timeout de 1 s del catálogo en frío justo tras generar; el timeout NO se toca (T20: informativo).
  for (let i = 0; i < seed.length; i += 10) {
    const chunk = seed.slice(i, i + 10);
    const t = await cmd.trashBeats({ userId: lib.userId, era: lib.era, epoch: lib.epoch, idempotencyKey: `bench-seedtrash-${crypto.randomUUID()}`, items: chunk.map((e) => ({ beatId: e.id, expectedVersion: e.version })) });
    t.items.forEach((it) => trashedPool.push({ id: it.beatId, version: it.version }));
  }
  // bulk: una etiqueta mediana (100-2000 beats ACTIVE) para construir conjuntos de consulta pequenos en cada iteracion.
  const f = await pool.query(`SELECT norm_key FROM catalog_facets WHERE user_id = $1 AND generation_id = $2 AND scope = 'ACTIVE' AND beat_count BETWEEN 100 AND 2000 ORDER BY beat_count DESC, norm_key LIMIT 1`, [lib.userId, lib.generationId]);
  return { activePool, trashedPool, patchPool, bulkTag: f.rows[0]?.norm_key || null, bulkToggle: 0 };
}

// ---------- perfiles de carga (C12-DECISION-RECORD §7 / TAREAS §T20) ----------
function buildProfiles({ q, cmd, ops, lib, clients, shared }) {
  const mid = Math.floor(TAG_VOCAB_SIZE / 2);
  const POPULAR_TAG = 'tag0';
  const takeRandom = (arr) => { if (!arr.length) throw Object.assign(new Error('POOL_EMPTY'), { code: 'POOL_EMPTY' }); return arr.splice(Math.floor(Math.random() * arr.length), 1)[0]; };
  const hdr = () => ({ userId: lib.userId, era: lib.era, epoch: lib.epoch });
  const rareQ = synthBeatDoc(777, 77777).name.toLowerCase(); // "<w1> <w2> 77777": pocas coincidencias (sufijos de indice), >= 3 caracteres
  let patchToggle = 0;
  const activeIdsCache = { ids: null };
  async function sampleActiveId() {
    if (!activeIdsCache.ids) {
      const p = await q.listBeats({ userId: lib.userId, query: { limit: '240' } });
      activeIdsCache.ids = p.items.map((i) => i.id);
    }
    return activeIdsCache.ids[Math.floor(Math.random() * activeIdsCache.ids.length)];
  }
  return {
    page1: () => q.listBeats({ userId: lib.userId, query: {} }),
    filter_frequent_tag: () => q.listBeats({ userId: lib.userId, query: { includeTag: 'tag0' } }),
    filter_rare_tag: () => q.listBeats({ userId: lib.userId, query: { includeTag: `tag${TAG_VOCAB_SIZE - 1}` } }),
    filter_short_q: () => q.listBeats({ userId: lib.userId, query: { q: 'mi' } }),
    filter_rare_q: () => q.listBeats({ userId: lib.userId, query: { q: rareQ } }),
    filter_nomatch_q_short: () => q.listBeats({ userId: lib.userId, query: { q: 'zq' } }),
    filter_nomatch_q_long: () => q.listBeats({ userId: lib.userId, query: { q: 'zqxjk' } }),
    count_exact: () => q.listBeats({ userId: lib.userId, query: { includeTag: `tag${mid}`, includeTotal: 'true' } }),
    legacy_nav_offset0: () => q.resolveLegacyNavigation({ userId: lib.userId, query: { offset: '0' } }),
    legacy_nav_offset_deep: () => q.resolveLegacyNavigation({ userId: lib.userId, query: { offset: String(Math.min(9999, Math.max(0, lib.activeCount - 1))) } }),
    read_one: async () => { const id = await sampleActiveId(); return q.getBeat({ userId: lib.userId, beatId: id }); },
    edit_patch: async () => {
      const id = await sampleActiveId();
      const current = await q.getBeat({ userId: lib.userId, beatId: id });
      patchToggle = (patchToggle + 1) % 6;
      return cmd.patchBeat({ userId: lib.userId, beatId: id, era: lib.era, epoch: lib.epoch, idempotencyKey: `bench-patch-${crypto.randomUUID()}`, expectedVersion: current.version, patch: { rating: patchToggle } });
    },
    // PATCH de tags: anade o quita un tag popular (tag0, en ~20 % de los beats) alternando por beat; la faceta afectada es la mas grande.
    edit_patch_tags: async () => {
      const e = shared.patchPool[Math.floor(Math.random() * shared.patchPool.length)];
      const has = e.tags.includes(POPULAR_TAG);
      const tags = has ? e.tags.filter((t) => t !== POPULAR_TAG) : [...e.tags, POPULAR_TAG];
      const r = await cmd.patchBeat({ ...hdr(), beatId: e.id, idempotencyKey: `bench-ptags-${crypto.randomUUID()}`, expectedVersion: e.version, patch: { tags } });
      e.tags = tags; e.version = r.beat.version;
      return r;
    },
    // trash y restore evaluados cada uno por separado (los pools rastrean version; restore_one parte de beats ya en papelera).
    trash_one: async () => {
      const e = takeRandom(shared.activePool);
      const t = await cmd.trashBeats({ ...hdr(), idempotencyKey: `bench-trash1-${crypto.randomUUID()}`, items: [{ beatId: e.id, expectedVersion: e.version }] });
      shared.trashedPool.push({ id: e.id, version: t.items[0].version });
      return t;
    },
    restore_one: async () => {
      const e = takeRandom(shared.trashedPool);
      const r = await cmd.restoreBeats({ ...hdr(), idempotencyKey: `bench-restore1-${crypto.randomUUID()}`, items: [{ beatId: e.id, expectedVersion: e.version }] });
      shared.activePool.push({ id: e.id, version: r.items[0].version });
      return r;
    },
    // Lote de 50 de bulk add/remove de un tag popular. La preparacion (conjunto de consulta, seleccion, operacion) NO se mide;
    // se mide un unico stepOperation (= un lote <=50 en una transaccion, lo que ejecuta el worker).
    bulk_tags_batch: async () => {
      if (!shared.bulkTag) throw Object.assign(new Error('NO_BULK_TAG'), { code: 'NO_BULK_TAG' });
      const set = await q.createQuerySet({ userId: lib.userId, query: { includeTag: shared.bulkTag }, consumer: { id: 'bench-bulk', kind: 'SELECTION' } });
      while ((await q.stepQuerySet({ userId: lib.userId, setId: set.setId, batch: 240 })).status === 'BUILDING');
      const page = await q.listBeats({ userId: lib.userId, query: { includeTag: shared.bulkTag, limit: '50' } });
      const ids = page.items.slice(0, 50).map((i) => i.id);
      const sel = await cmd.createSelection({ ...hdr(), setId: set.setId, sort: 'manual', defaultSelected: false, consumerId: 'bench-bulk' });
      await cmd.applySelectionOp({ ...hdr(), selectionId: sel.selectionId, selectionVersion: '0', idempotencyKey: `bench-bsel-${crypto.randomUUID()}`, op: { kind: 'INCLUDE_IDS', beatIds: ids } });
      shared.bulkToggle = (shared.bulkToggle + 1) % 2;
      const op = await cmd.createOperation({ ...hdr(), idempotencyKey: `bench-bop-${crypto.randomUUID()}`, kind: 'BULK_PATCH', selectionId: sel.selectionId, selectionVersion: '1', patch: {}, tagsOp: { op: shared.bulkToggle ? 'add' : 'remove', tags: [POPULAR_TAG] } });
      const t0 = process.hrtime.bigint();
      const step = await cmd.stepOperation({ ...hdr(), operationId: op.operationId });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      return { __timed_ms: ms, advanced: step.advanced, status: step.status };
    },
    trash_restore_roundtrip: async () => {
      const id = await sampleActiveId();
      const current = await q.getBeat({ userId: lib.userId, beatId: id });
      const t = await cmd.trashBeats({ userId: lib.userId, era: lib.era, epoch: lib.epoch, idempotencyKey: `bench-trash-${crypto.randomUUID()}`, items: [{ beatId: id, expectedVersion: current.version }] });
      return cmd.restoreBeats({ userId: lib.userId, era: lib.era, epoch: lib.epoch, idempotencyKey: `bench-restore-${crypto.randomUUID()}`, items: [{ beatId: id, expectedVersion: t.items[0].version }] });
    },
    // "Cola de transferencias" (T09/T10 reales en claim/lease; salto de gateway de medios FAKE, documentado abajo).
    transfer_queue_fake_gateway: async () => {
      const pool = ops.__pool;
      const jobIds = [];
      for (let c = 0; c < clients; c++) for (let t = 0; t < 2; t++) jobIds.push(`bench-job-${crypto.randomUUID()}`);
      const values = jobIds.map((_, i) => `($${i * 2 + 1}, '${lib.userId}', 'TRANSFER_VERIFY', $${i * 2 + 2})`).join(',');
      const params = jobIds.flatMap((id) => [id, JSON.stringify({ fake: true })]);
      await pool.query(`INSERT INTO catalog_jobs(job_id, user_id, kind, payload_json) VALUES ${values}`, params);
      const owners = Array.from({ length: clients }, (_, i) => `bench-client-${i}`);
      const claims = await Promise.all(owners.map((owner) => ops.claimJobs({ owner, limit: 2, kinds: ['TRANSFER_VERIFY'] })));
      // Salto de gateway de medios: NO hay gateway real (§8.6 pendiente de T11/T12 reales). Se documenta como FAKE_GATEWAY_HOP_MS.
      const FAKE_GATEWAY_HOP_MS = 5;
      await new Promise((r) => setTimeout(r, FAKE_GATEWAY_HOP_MS));
      const claimed = claims.flat();
      // completeJob() es el código real de T09/T10 (operations.js): limpia lease_owner/lease_until a la vez que marca
      // DONE con fencing por owner+lease_generation; un UPDATE a mano sin esos campos viola catalog_jobs_check.
      await Promise.all(claimed.map((j) => ops.completeJob({ jobId: j.jobId, lease: j.lease }).catch(() => null)));
      return { items: claimed.map((j) => j.jobId), fake_gateway_hop_ms: FAKE_GATEWAY_HOP_MS };
    },
  };
}

// ---------- main ----------
async function main(argv) {
  const envInfo = assertSafeEnv(process.env);
  const args = parseArgs(argv);
  fs.mkdirSync(args.outDir, { recursive: true });

  const resourceCheck = {
    cpus_logical: os.cpus().length, total_mem_gib: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
    c11_lab_v1_target: { cpus_logical: 8, total_mem_gib: 16 },
    meets_c11_lab_v1: os.cpus().length >= 8 && os.totalmem() >= 16 * (1024 ** 3),
    note: 'C12-DECISION-RECORD §7 pide 8 vCPU/16 GiB aislados para PostgreSQL+app+generador. Si esta máquina no los tiene, '
      + 'STOP-ENV para los perfiles de máxima escala (decisión del coordinador); este runner no reduce n, SLO ni clientes por eso.',
  };

  const descriptor = args.descriptor ? JSON.parse(fs.readFileSync(args.descriptor, 'utf8')) : undefined;
  const h = await db.createCatalogTestDb({ descriptor });
  // Nota: NO se usa db.instrumentPool aquí. Ese helper envuelve pool.connect() para los contadores de T02, pero
  // pg-pool#query() llama a connect() con un callback interno (ver pg-pool/index.js:447) incompatible con el wrapper
  // async/await de instrumentPool, y este script sí usa pool.query() directo (migraciones, generador, EXPLAIN).
  // El retenido se verifica de forma independiente y más fuerte: pg_stat_activity real + pool.totalCount/idleCount.
  const pool = new Pool({ ...h.config, max: Math.max(10, args.clients + 4) });
  let exitCode = 0;
  const summary = {
    schema: 'beatgaler.catalog-benchmark-summary', version: 1, started_at: new Date().toISOString(),
    args: { n: args.n, seed: args.seed, warmupMs: args.warmupMs, sampleMs: args.sampleMs, clients: args.clients, genConcurrency: args.genConcurrency, smoke: args.smoke },
    env: { extra_vars_count: envInfo.extraCount, extra_vars: envInfo.extraNames },
    resource_check: resourceCheck,
    rows_measurement_method: null, pg_stat_statements_available: false,
    generation: null, profiles: {}, cold: {}, warm: {},
    sql_retained: null, limitations: [
      'transfer_queue_fake_gateway ejercita INSERT/claim/UPDATE reales sobre catalog_jobs (T09/T10), pero NO hay gateway de medios real (§8.6): '
        + 'el salto de red se simula con un retardo fijo FAKE_GATEWAY_HOP_MS, documentado en cada muestra de ese perfil.',
      'import real (migración legacy) no aplica a bibliotecas nativas (NATIVO r2.1): el perfil de "import y cola" se aproxima con '
        + 'construcción+avance de query-sets (createQuerySet/stepQuerySet, código real T06) más la cola de jobs anterior; no hay import INDEX.',
      'El delta de memoria "primera página 1M frente a 100k <= 20 MiB" requiere comparar dos corridas de este script (una con --n 100000 '
        + 'y otra con --n 1000000) y diferenciar process_memory.rss_after_warmup_mb; este script no corre ambos tamaños en un solo proceso.',
    ],
  };

  try {
    const genT0 = process.hrtime.bigint();
    await mig.applyMigrations(pool);
    const lib = await generateLibrary({ pool, userId: 'bench-u1', n: args.n, seed: args.seed, concurrency: args.genConcurrency, trashFraction: 0.10 });
    const genMs = Number(process.hrtime.bigint() - genT0) / 1e6;
    summary.generation = { ...lib, duration_ms: genMs, rows_per_sec: args.n ? Math.round((args.n / genMs) * 1000) : null };
    if (args.tenants > 0) {
      // Variante multi-tenant: bibliotecas pequenas con vocabularios disjuntos; cambia la estadistica global de catalog_beat_tags.label.
      const tT0 = process.hrtime.bigint();
      summary.tenants = await generateTenants({ pool, count: args.tenants, beatsPerLibrary: args.tenantBeats, vocabSize: args.tenantVocab, seed: args.seed, concurrency: 1 });
      summary.tenants.duration_ms = Number(process.hrtime.bigint() - tT0) / 1e6;
      const dist = await pool.query('SELECT count(DISTINCT label)::int AS distinct_labels, count(DISTINCT user_id)::int AS users FROM catalog_beat_tags');
      summary.tenants.distinct_labels_total = dist.rows[0].distinct_labels; summary.tenants.users_with_tags = dist.rows[0].users;
      await pool.query('ANALYZE catalog_beat_tags');
    }

    let pgStatStatements = false;
    try { await pool.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements'); const r = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'"); pgStatStatements = r.rows.length > 0; } catch { pgStatStatements = false; }
    summary.pg_stat_statements_available = pgStatStatements;
    summary.rows_measurement_method = pgStatStatements ? 'pg_stat_statements' : 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) sobre una muestra por perfil';

    const auth = authorityMod.createCatalogAuthority({ pool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' });
    const q = queriesMod.createCatalogQueries({ pool, authority: auth, cursorKeys: [{ kid: 'bench', secret: crypto.randomBytes(32) }] });
    const cmd = commandsMod.createCatalogCommands({ pool, authority: auth });
    const ops = { ...operationsMod.createCatalogOperations({ pool, authority: auth, resolveAccess: async () => ({ maxBeats: null }) }), __pool: pool };
    const shared = await prepareShared({ pool, q, cmd, lib, poolSize: args.pools });
    const profiles = buildProfiles({ q, cmd, ops, lib, clients: args.clients, shared });
    const names = Object.keys(profiles).filter((n) => !args.only || args.only.includes(n));
    summary.profile_class = Object.fromEntries(names.map((n) => [n, PROFILE_CLASS[n] || 'informativo']));

    // ---------- arranque frío: pool nuevo de 1 conexión, primeras N llamadas de cada perfil sin caché/calentamiento ----------
    for (const name of names) {
      const coldPool = new Pool({ ...h.config, max: 1 });
      const coldAuth = () => authorityMod.createCatalogAuthority({ pool: coldPool, env: { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' }, controlPlaneAuthority: 'postgres' });
      const coldProfiles = buildProfiles({
        q: queriesMod.createCatalogQueries({ pool: coldPool, authority: coldAuth(), cursorKeys: [{ kid: 'bench-cold', secret: crypto.randomBytes(32) }] }),
        cmd: commandsMod.createCatalogCommands({ pool: coldPool, authority: coldAuth() }),
        ops: { ...operationsMod.createCatalogOperations({ pool: coldPool, authority: coldAuth(), resolveAccess: async () => ({ maxBeats: null }) }), __pool: coldPool },
        lib, clients: Math.min(5, args.clients), shared,
      });
      const samples = [];
      const coldN = args.smoke ? 2 : 5;
      for (let i = 0; i < coldN; i++) samples.push(await timeIt(coldProfiles[name]));
      summary.cold[name] = stats(samples);
      await coldPool.end();
    }

    // ---------- calentamiento (descartado) ----------
    const memBefore = process.memoryUsage().rss;
    await runFor(args.warmupMs, () => profiles.page1());
    for (const name of names) await timeIt(profiles[name]); // toca cada perfil al menos una vez antes de medir
    const memAfterWarmup = process.memoryUsage().rss;

    // ---------- muestra caliente por perfil ----------
    const perProfileMs = Math.max(1000, Math.floor(args.sampleMs / names.length));
    for (const name of names) {
      const samples = await runFor(perProfileMs, profiles[name]);
      summary.warm[name] = stats(samples);
      summary.profiles[name] = { raw: samples.map((s) => ({ ms: Math.round(s.ms * 1000) / 1000, rows: s.rows ?? null, bytes: s.bytes, error: s.error })) };
    }
    const memAfterSample = process.memoryUsage().rss;
    summary.process_memory = { rss_before_warmup_mb: Math.round(memBefore / 1048576), rss_after_warmup_mb: Math.round(memAfterWarmup / 1048576), rss_after_sample_mb: Math.round(memAfterSample / 1048576) };

    // ---------- integridad tras la campaña: facetas == recómputo completo y grupos == tags+beats (T20-N, 0 diferencias exigidas) ----------
    summary.facets_oracle = await runOracle(pool, { userId: lib.userId, generationId: lib.generationId });

    // ---------- SQL retenido: pg_stat_activity real + contadores del pool (nunca solo uno de los dos) ----------
    const activity = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'");
    const poolOpen = pool.totalCount - pool.idleCount;
    summary.sql_retained = { pool_total_count: pool.totalCount, pool_idle_count: pool.idleCount, pool_checked_out: poolOpen, pg_stat_activity_idle_in_transaction: activity.rows[0].n, acceptable: poolOpen === 0 && activity.rows[0].n === 0 };

    // ---------- SLO de referencia (C12-DECISION-RECORD §7 / NATIVO r2.1 §8.6) ----------
    const slo = { metadata_p95_ms: 250, metadata_p99_ms: 1000, patch_p95_ms: 250, response_max_bytes: 2 * 1024 * 1024, sql_retained: 0 };
    // Perfiles de lectura/escritura obligatorios: p95/p99/bytes; los errores cuentan (un perfil con errores no pasa).
    const metadataProfiles = ['page1', 'filter_frequent_tag', 'filter_rare_tag', 'filter_short_q', 'count_exact', 'legacy_nav_offset0', 'legacy_nav_offset_deep', 'read_one',
      'filter_nomatch_q_short', 'filter_nomatch_q_long', 'trash_one', 'restore_one'];
    const slo_eval = {};
    for (const name of metadataProfiles) {
      const w = summary.warm[name];
      if (!w) continue;
      slo_eval[name] = { p95_ok: w.p95_ms !== null && w.p95_ms <= slo.metadata_p95_ms, p99_ok: w.p99_ms !== null && w.p99_ms <= slo.metadata_p99_ms, bytes_ok: (w.max_bytes ?? 0) <= slo.response_max_bytes, errors_ok: w.errors === 0, p95_ms: w.p95_ms, p99_ms: w.p99_ms, max_bytes: w.max_bytes };
    }
    for (const name of ['edit_patch', 'edit_patch_tags']) {
      if (summary.warm[name]) slo_eval[name] = { p95_ok: summary.warm[name].p95_ms !== null && summary.warm[name].p95_ms <= slo.patch_p95_ms, errors_ok: summary.warm[name].errors === 0, p95_ms: summary.warm[name].p95_ms };
    }
    // Informativos (ver PROFILE_CLASS): se reportan contra la referencia de 250 ms, sin afectar a summary.slo.pass.
    summary.informational = {};
    for (const name of Object.keys(summary.warm)) {
      if ((PROFILE_CLASS[name] || 'informativo') !== 'informativo') continue;
      const w = summary.warm[name];
      summary.informational[name] = { p95_ms: w.p95_ms, p99_ms: w.p99_ms, errors: w.errors, within_250ms_p95: w.p95_ms !== null && w.p95_ms <= 250 };
    }
    slo_eval.sql_retained_ok = summary.sql_retained.acceptable;
    slo_eval.facets_oracle_ok = summary.facets_oracle.facetDifferences === 0 && summary.facets_oracle.groupDifferences === 0;
    summary.slo = { reference: slo, evaluation: slo_eval, pass: Object.values(slo_eval).every((v) => v === true || (typeof v === 'object' && Object.entries(v).filter(([k]) => k.endsWith('_ok')).every(([, ok]) => ok))) };
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
    `catalog-benchmark n=${args.n} seed=${args.seed} result=${exitCode === 0 ? (summary.slo?.pass ? 'PASS' : 'SLO_FAIL') : 'ERROR'}`,
    `recursos: ${resourceCheck.cpus_logical} vCPU lógicos / ${resourceCheck.total_mem_gib} GiB (objetivo C11-LAB-v1: 8 vCPU/16 GiB) -> cumple=${resourceCheck.meets_c11_lab_v1}`,
    summary.generation ? `generación: ${summary.generation.n} beats en ${Math.round(summary.generation.duration_ms)} ms (${summary.generation.rows_per_sec} filas/s), trash=${summary.generation.trashCount}` : 'generación: no completada',
    `medición de filas SQL: ${summary.rows_measurement_method || 'N/D'} (pg_stat_statements disponible=${summary.pg_stat_statements_available})`,
  ];
  if (summary.sql_retained) lines.push(`SQL retenido: pool_checked_out=${summary.sql_retained.pool_checked_out} idle_in_tx=${summary.sql_retained.pg_stat_activity_idle_in_transaction} aceptable=${summary.sql_retained.acceptable}`);
  for (const name of Object.keys(summary.warm)) {
    const w = summary.warm[name]; const c = summary.cold[name];
    lines.push(`  ${name} [${PROFILE_CLASS[name] || 'informativo'}]: warm p50=${w.p50_ms?.toFixed(1)} p95=${w.p95_ms?.toFixed(1)} p99=${w.p99_ms?.toFixed(1)} ms, n=${w.count}, err=${w.errors} | cold p50=${c?.p50_ms?.toFixed(1)}ms`);
  }
  if (summary.error) lines.push(`ERROR: ${summary.error}`);
  fs.writeFileSync(path.join(args.outDir, 'summary.txt'), lines.join('\n') + '\n');
  process.stdout.write(lines.join('\n') + `\nsalida: ${args.outDir}\n`);
  return exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => { process.stderr.write(`catalog-benchmark: ${e.message}\n`); process.exitCode = e.exit || 1; });
}
module.exports = { main, parseArgs, assertSafeEnv, percentile, stats };
