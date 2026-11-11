'use strict';
// T20 — Generador sintético de catálogo (semilla fija) para medir capacidad/latencia/contención sobre PostgreSQL.
//  - Determinista: misma semilla + mismo índice de beat => mismos valores, sin estado de RNG compartido (cada fila deriva
//    su entropía de sha256(seed:index), así que es seguro repartir el rango de índices entre varios clientes/shards).
//  - Reutiliza el código real del catálogo donde importa para la corrección (legacy-codec.projectBeat para las proyecciones
//    derivadas, catalog/authority.provisionLibrary para nacer la biblioteca nativa) en vez de inventar su propio esquema.
//  - Nunca usa INSERT fila a fila para los beats/tags/papelera: construye INSERT multi-fila por lotes (BEAT_BATCH_ROWS).
//    No hay COPY disponible (pg-copy-streams no está instalado en cloud-server/node_modules); ver informe T20.
//  - Nunca toca una base persistente: quien llama a generateLibrary() decide el pool, pero el CLI de benchmark solo
//    apunta a una DB efímera creada por cloud-server/tests/helpers/catalog-test-db.cjs.

const crypto = require('crypto');
const path = require('path');

const codec = require(path.join(__dirname, '..', '..', 'cloud-server', 'catalog', 'legacy-codec.js'));
const authorityMod = require(path.join(__dirname, '..', '..', 'cloud-server', 'catalog', 'authority.js'));
const staging = require(path.join(__dirname, '..', '..', 'cloud-server', 'catalog', 'staging.js'));

const TAG_VOCAB_SIZE = 500;
const NAME_WORDS = [
  'Midnight', 'Solar', 'Crystal', 'Echo', 'Neon', 'Velvet', 'Phantom', 'Ocean', 'Static', 'Golden',
  'Shadow', 'Electric', 'Silent', 'Crimson', 'Lunar', 'Astro', 'Analog', 'Digital', 'Frozen', 'Amber',
  'Smoke', 'Glass', 'Iron', 'Paper', 'Neon2', 'Vapor', 'Rust', 'Ash', 'Marble', 'Cobalt',
];
const KEY_ROOTS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffffff', '#888888', '#ff8800', '#8800ff'];

const BEAT_COLUMNS = [
  'user_id', 'generation_id', 'beat_id', 'state', 'name', 'bpm_text', 'key_text', 'rating', 'color', 'color2',
  'bpm_sort_class', 'bpm_sort', 'sort_order', 'manual_rank', 'telegram_topic_id', 'has_artwork', 'legacy_json',
  'legacy_sha256', 'legacy_export_bytes', 'name_display', 'name_search', 'key_display', 'key_search', 'bpm_display', 'rating_display',
];
const TAG_COLUMNS = ['user_id', 'generation_id', 'beat_id', 'position', 'label', 'norm_key', 'search_key'];
const TRASH_COLUMNS = ['user_id', 'generation_id', 'beat_id', 'beat_state', 'wrapper_present', 'trash_id', 'trashed_at', 'purge_after', 'wrapper_json', 'export_position'];

function sha256Hex(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

// Entropía determinista por fila: 32 bytes de sha256(namespace:seed:index). Sin estado compartido entre filas.
function rowEntropy(seed, index) {
  return crypto.createHash('sha256').update(`beatgaler-catalog-bench-v1:${seed}:${index}`).digest();
}
function u32(entropy, slot) { return entropy.readUInt32BE((slot * 4) % (entropy.length - 4)); }
function frac(entropy, slot) { return u32(entropy, slot) / 0x100000000; }
function choice(entropy, slot, arr) { return arr[u32(entropy, slot) % arr.length]; }

// Vocabulario de tags con ley de potencia: tag0 es el más frecuente, tagN el más raro (sirve a los perfiles
// "filtro frecuente" / "filtro raro" del benchmark sin tener que escanear la tabla para encontrarlos).
function zipfTagIndex(entropy, slot, vocabSize) {
  const u = frac(entropy, slot);
  const skewed = 1 - Math.sqrt(1 - u); // concentra la masa cerca de 0
  return Math.min(vocabSize - 1, Math.floor(skewed * vocabSize));
}

function synthBeatDoc(seed, index, { tagVocabSize = TAG_VOCAB_SIZE, tagPrefix = 'tag' } = {}) {
  const ent = rowEntropy(seed, index);
  const name = `${choice(ent, 0, NAME_WORDS)} ${choice(ent, 1, NAME_WORDS)} ${index}`;
  const bpm = String(60 + (u32(ent, 2) % 241)); // 60..300 (metadata-rules.validateBpm)
  const key = choice(ent, 3, KEY_ROOTS) + (u32(ent, 4) % 2 === 0 ? '' : 'm');
  const rating = u32(ent, 5) % 6; // 0..5, dentro de 0..255
  const color = choice(ent, 6, COLORS);
  const color2 = choice(ent, 7, COLORS);
  const tagCount = 2 + (u32(ent, 8) % 4); // 2..5, media ~3.5
  const tags = new Set();
  for (let t = 0; t < tagCount; t++) tags.add(`${tagPrefix}${zipfTagIndex(ent, 9 + t, tagVocabSize)}`);
  // q corto (1-2 caracteres) debe tener coincidencias: aseguramos que el nombre contenga siempre "ab" en minúsculas
  // en una fracción determinista de beats, y que todo nombre tenga alguna subcadena de 1-2 chars trivialmente frecuente.
  return { id: `beat-${String(index).padStart(7, '0')}`, name, bpm, key, rating, color, color2, tags: [...tags] };
}

// true para una fracción determinista `frac01` de los índices (usado para trash y para reservar un slot "raro").
function selected(seed, index, salt, frac01) { return frac(rowEntropy(seed, `${salt}:${index}`), 0) < frac01; }

function buildInsert(table, columns, rows) {
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const base = i * columns.length;
    values.push(`(${columns.map((_, j) => `$${base + j + 1}`).join(',')})`);
    for (const c of columns) params.push(r[c]);
  });
  return { sql: `INSERT INTO ${table}(${columns.join(',')}) VALUES ${values.join(',')}`, params };
}

async function insertBeatsBatch(client, rows) {
  if (!rows.length) return;
  const { sql, params } = buildInsert('catalog_beats', BEAT_COLUMNS, rows);
  await client.query(sql, params);
}
async function insertTagsBatch(client, rows) {
  if (!rows.length) return;
  const { sql, params } = buildInsert('catalog_beat_tags', TAG_COLUMNS, rows);
  await client.query(sql, params);
}
async function insertTrashBatch(client, rows) {
  if (!rows.length) return;
  const { sql, params } = buildInsert('catalog_trash_entries', TRASH_COLUMNS, rows);
  await client.query(sql, params);
}

// Fila lista para INSERT a partir del índice determinista. `rankBase` desplaza manual_rank para que cada shard
// mantenga un rango disjunto (no es necesario para corrección, solo evita manual_rank idénticos entre shards).
function buildRow({ userId, generationId, index, seed, tagVocabSize, trashFraction, tagPrefix = 'tag' }) {
  const doc = synthBeatDoc(seed, index, { tagVocabSize, tagPrefix });
  const p = codec.projectBeat(doc);
  const legacyJson = JSON.stringify(doc);
  const isTrash = selected(seed, index, 'trash', trashFraction);
  const beatRow = {
    user_id: userId, generation_id: generationId, beat_id: doc.id, state: isTrash ? 'TRASH' : 'ACTIVE',
    name: p.name, bpm_text: p.bpmText, key_text: p.keyText, rating: p.rating, color: p.color, color2: p.color2,
    bpm_sort_class: p.bpmSortClass, bpm_sort: p.bpmSort, sort_order: p.sortOrder, manual_rank: String(index * 1000 + 1),
    telegram_topic_id: p.telegramTopicId, has_artwork: p.hasArtwork, legacy_json: legacyJson, legacy_sha256: sha256Hex(legacyJson),
    legacy_export_bytes: Buffer.byteLength(legacyJson, 'utf8'), name_display: p.nameDisplay, name_search: p.nameSearch,
    key_display: p.keyDisplay, key_search: p.keySearch, bpm_display: p.bpmDisplay, rating_display: p.ratingDisplay,
  };
  const tagRows = p.tags.map((t) => ({ user_id: userId, generation_id: generationId, beat_id: doc.id, position: t.position, label: t.label, norm_key: t.normKey, search_key: t.searchKey }));
  let trashRow = null;
  if (isTrash) {
    const trashId = `trash-${doc.id}`;
    trashRow = {
      user_id: userId, generation_id: generationId, beat_id: doc.id, beat_state: 'TRASH', wrapper_present: true, trash_id: trashId,
      trashed_at: new Date(Date.now() - (index % 1000) * 60000).toISOString(), purge_after: new Date(Date.now() + 14 * 86400000).toISOString(),
      wrapper_json: JSON.stringify({ trash_id: trashId }), export_position: index,
    };
  }
  return { beatRow, tagRows, trashRow, isTrash };
}

// Crea (si falta) la activación nativa + usuario + vault elegible y provisiona la biblioteca con el código real
// de T05-N (authority.provisionLibrary). No inventa su propia variante del predicado nativo.
async function ensureNativeLibrary(pool, { userId, seed }) {
  const env = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
  await pool.query("INSERT INTO transport_bots(id) VALUES ('BenchBot') ON CONFLICT DO NOTHING");
  const already = await pool.query('SELECT 1 FROM catalog_native_activation');
  if (!already.rows.length) {
    const manifestSha = sha256Hex(`catalog-bench:${seed}`);
    await pool.query(
      `INSERT INTO catalog_native_activation(environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory)
       VALUES ('catalog-bench', $1, '["BenchBot"]', 'FRESH_BOTS', $2, '[]')`,
      [`run-${seed}`, manifestSha],
    );
  }
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [userId, `${userId}@catalog-bench.invalid`]);
  const vaultId = `v-${userId}`;
  const chatId = `-${1000000000 + (Number(String(seed).replace(/\D/g, '') || 0) % 1000000)}`;
  const existingVault = await pool.query('SELECT id FROM vaults WHERE user_id = $1', [userId]);
  if (!existingVault.rows.length) {
    await pool.query(
      `INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id, index_bootstrap_pending) VALUES ($1, $2, $3, 'BenchBot', true)`,
      [vaultId, userId, chatId],
    );
  } else {
    await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE user_id = $1 AND NOT EXISTS (SELECT 1 FROM catalog_libraries WHERE user_id = $1)', [userId]);
  }
  const auth = authorityMod.createCatalogAuthority({ pool, env, controlPlaneAuthority: 'postgres' });
  const { context } = await auth.provisionLibrary({ userId });
  return context;
}

// Genera `n` beats deterministas (semilla `seed`) en la biblioteca nativa de `userId`, repartidos en `concurrency`
// clientes concurrentes por rango de índice disjunto. Confirma por lotes de `commitEvery` filas (cada lote es varios
// INSERT multi-fila de `batchRows` filas, nunca fila a fila). Al final reconstruye proyecciones derivadas (grupos/
// facetas) con el código real de staging.js y actualiza los contadores de catalog_libraries.
async function generateLibrary({
  pool, userId, n, seed = 777, tagVocabSize = TAG_VOCAB_SIZE, trashFraction = 0.10, tagPrefix = 'tag',
  batchRows = 500, commitEvery = 2000, concurrency = 1, onProgress = null, analyzeEachCommit = null,
} = {}) {
  if (!Number.isInteger(n) || n < 0) throw new Error('n debe ser un entero >= 0');
  const context = await ensureNativeLibrary(pool, { userId, seed });
  const generationId = context.generation_id;

  const analyze = analyzeEachCommit ?? n > commitEvery;
  const shards = Math.max(1, Math.min(concurrency, n || 1));
  const perShard = Math.ceil(n / shards);
  let trashCount = 0; let written = 0;

  async function runShard(shardIndex) {
    const start = shardIndex * perShard;
    const end = Math.min(n, start + perShard);
    if (start >= end) return { trash: 0 };
    const client = await pool.connect();
    let shardTrash = 0;
    try {
      let cursor = start;
      while (cursor < end) {
        const chunkEnd = Math.min(end, cursor + commitEvery);
        await client.query('BEGIN');
        try {
          let beatBuf = []; let tagBuf = []; let trashBuf = [];
          const flush = async () => {
            await insertBeatsBatch(client, beatBuf); await insertTagsBatch(client, tagBuf); await insertTrashBatch(client, trashBuf);
            beatBuf = []; tagBuf = []; trashBuf = [];
          };
          for (let i = cursor; i < chunkEnd; i++) {
            const { beatRow, tagRows, trashRow, isTrash } = buildRow({ userId, generationId, index: i, seed, tagVocabSize, trashFraction, tagPrefix });
            beatBuf.push(beatRow); tagBuf.push(...tagRows); if (trashRow) { trashBuf.push(trashRow); shardTrash++; }
            if (beatBuf.length >= batchRows) await flush();
          }
          await flush();
          await client.query('COMMIT');
          // Pitfall documentado (memoria "Catalog T06 state"): sin ANALYZE periódico, el backend sigue usando el
          // plan genérico estimado sobre una tabla vacía para los triggers/FK de catalog_beats y catalog_beat_tags
          // (catalog_beats_native_guard, FK de catalog_beat_tags) y degrada a un escaneo que crece con la tabla:
          // el lote pasa de ~0.3 s a varios segundos conforme crece n (medido: 10k filas sin ANALYZE = ~95 s;
          // con ANALYZE cada commitEvery = ~2 s). Sin esto la generación es cuadrática en n, no lineal.
          // Solo cuando el lote puede degradar la estadística del plan (bibliotecas grandes); las bibliotecas pequeñas de la variante
          // multi-tenant (<= commitEvery filas) no lo necesitan y ANALYZE de tablas de 1M filas por cada una cuesta segundos.
          if (analyze) await client.query('ANALYZE catalog_beats, catalog_beat_tags');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
        written += (chunkEnd - cursor);
        if (onProgress) onProgress({ written, total: n });
        cursor = chunkEnd;
      }
      return { trash: shardTrash };
    } finally { client.release(); }
  }

  const results = await Promise.all(Array.from({ length: shards }, (_, s) => runShard(s)));
  trashCount = results.reduce((a, r) => a + r.trash, 0);

  const projClient = await pool.connect();
  try {
    await projClient.query('BEGIN');
    await staging.rebuildDerivedProjections(projClient, { userId, generationId });
    await projClient.query(
      `UPDATE catalog_libraries SET
         active_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE'),
         trash_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'TRASH'),
         revision = revision + 1
       WHERE user_id = $1`,
      [userId, generationId],
    );
    await projClient.query('COMMIT');
  } catch (e) { await projClient.query('ROLLBACK').catch(() => {}); throw e; } finally { projClient.release(); }

  return {
    userId, generationId, era: context.authority_era, epoch: context.authority_epoch,
    n, activeCount: n - trashCount, trashCount, shards, tagVocabSize, seed,
  };
}

// Variante multi-tenant: `count` bibliotecas pequenas ademas de la grande, cada una con un vocabulario de tags propio (prefijo distinto:
// `t<k>x<i>`), de modo que catalog_beat_tags.label tenga muchas etiquetas distintas en total (count x vocabSize) y las estadisticas
// globales de label dejen de describir el vocabulario de la biblioteca grande. Determinista por (seed, k). Cada biblioteca usa el
// mismo camino real de provision (authority.provisionLibrary) y proyecciones (staging.rebuildDerivedProjections) que generateLibrary.
async function generateTenants({ pool, count, beatsPerLibrary = 500, vocabSize = 10, seed = 777, concurrency = 1, trashFraction = 0.10 } = {}) {
  let beats = 0;
  for (let k = 0; k < count; k++) {
    const r = await generateLibrary({ pool, userId: `bench-t${String(k).padStart(4, '0')}`, n: beatsPerLibrary, seed: seed * 1000 + k + 1, tagVocabSize: vocabSize, trashFraction, tagPrefix: `t${k}x`, concurrency });
    beats += r.n;
  }
  return { tenants: count, beatsPerLibrary, vocabSize, beats, expectedDistinctLabelsMax: count * vocabSize };
}

module.exports = {
  generateTenants, TAG_VOCAB_SIZE, synthBeatDoc, rowEntropy, selected, buildRow, ensureNativeLibrary, generateLibrary,
  insertBeatsBatch, insertTagsBatch, insertTrashBatch, BEAT_COLUMNS, TAG_COLUMNS, TRASH_COLUMNS,
};
