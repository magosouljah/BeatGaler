'use strict';
// T20-N — Facetas por delta (cloud-server/catalog/facets.js) contra PostgreSQL real aislado.
//  1. Secuencia aleatoria con semilla fija (patch de tags, trash, restore, bulk add/remove de tags, bulk trash, rename con fusión,
//     import/replace de operations si aplica) sobre una biblioteca pequeña con colisiones de norm_key y empates de representante:
//     igualdad EXACTA de catalog_facets frente al recómputo completo (oráculo) y de los grupos frente a tags+beats tras CADA paso.
//  2. trash/restore NO reescriben catalog_beat_tag_groups (ni DELETE ni INSERT): la FK ON UPDATE CASCADE de 0026 propaga
//     state y manual_rank, y las facetas siguen exactas.
//  3. Contador cero: la fila de faceta desaparece (misma convención que el recómputo completo).
//  4. Fail-closed: un delta que dejaría el contador negativo aborta la transacción.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');
const authority = require('../../catalog/authority.js');
const queries = require('../../catalog/queries.js');
const commands = require('../../catalog/commands.js');
const facets = require('../../catalog/facets.js');
const codec = require('../../catalog/legacy-codec.js');
const { rebuildDerivedProjections } = require('../../catalog/staging.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget();
const ENV_ON = { BEATGALER_CATALOG_NATIVE_ENABLED: 'true' };
const KEYS = [{ kid: 'k1', secret: crypto.randomBytes(32) }];
const H = crypto.createHash('sha256').update('x').digest('hex');
let seq = 0; let keyN = 0;
const key = () => `fk-${++keyN}`;

async function withDb(fn, { max = 8 } = {}) {
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
const mk = (pool, cpool = pool) => ({ cmd: commands.createCatalogCommands({ pool: cpool, authority: auth(pool) }), q: queries.createCatalogQueries({ pool, authority: auth(pool), cursorKeys: KEYS }) });
async function nativeLibrary(pool) {
  const id = `fu${++seq}`;
  await pool.query('INSERT INTO users(id, email) VALUES ($1, $2)', [id, `${id}@fake.invalid`]);
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id, transport_bot_id) VALUES ($1, $2, $3, 'Bot20')", [`v-${id}`, id, `-100${seq}`]);
  await pool.query('UPDATE vaults SET index_bootstrap_pending = true WHERE id = $1', [`v-${id}`]);
  const ctx = (await auth(pool).provisionLibrary({ userId: id })).context;
  return { userId: id, generationId: ctx.generation_id, era: ctx.authority_era, epoch: ctx.authority_epoch };
}
async function seedBeats(pool, lib, beats) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    let rank = 0;
    for (const beat of beats) {
      const p = codec.projectBeat(beat); const json = JSON.stringify(beat);
      await c.query(`INSERT INTO catalog_beats(user_id, generation_id, beat_id, state, name, bpm_text, key_text, rating, color, color2, bpm_sort_class, bpm_sort, sort_order, manual_rank,
          has_artwork, legacy_json, legacy_sha256, legacy_export_bytes, name_display, name_search, key_display, key_search, bpm_display, rating_display)
        VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [lib.userId, lib.generationId, beat.id, p.name, p.bpmText, p.keyText, p.rating, p.color, p.color2, p.bpmSortClass, p.bpmSort, p.sortOrder, String(rank++ * 1000),
        p.hasArtwork, json, crypto.createHash('sha256').update(json, 'utf8').digest('hex'), Buffer.byteLength(json, 'utf8'), p.nameDisplay, p.nameSearch, p.keyDisplay, p.keySearch, p.bpmDisplay, p.ratingDisplay]);
      for (const t of p.tags) await c.query('INSERT INTO catalog_beat_tags(user_id, generation_id, beat_id, position, label, norm_key, search_key) VALUES ($1,$2,$3,$4,$5,$6,$7)', [lib.userId, lib.generationId, beat.id, t.position, t.label, t.normKey, t.searchKey]);
    }
    await c.query(`UPDATE catalog_libraries SET active_count = (SELECT count(*) FROM catalog_beats WHERE user_id = $1 AND generation_id = $2 AND state = 'ACTIVE') WHERE user_id = $1`, [lib.userId, lib.generationId]);
    await rebuildDerivedProjections(c, lib);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
}
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Vocabulario con colisiones de norm_key (mayúsculas/minúsculas) y acentos.
const SEED_VOCAB = ['Trap', 'trap', 'TRAP', 'Lo-Fi', 'lo-fi', 'dark', 'Dark', 'DARK', 'Café', 'café', 'house', 'drill', 'ambient', 'Ambient'];
// PATCH/bulk/rename exigen tags normalizados (metadata-rules): minúsculas y solo [a-z0-9 _-].
const VOCAB = ['trap', 'lo-fi', 'dark', 'house', 'drill', 'ambient', 'jazz'];
const assertExact = async (pool, lib, where) => {
  const f = await facets.facetsOracleDiff(pool, lib.userId, lib.generationId);
  assert.equal(f.differences, 0, `${where}: facetas != recómputo completo ${JSON.stringify(f.sample.slice(0, 3))}`);
  const g = await facets.groupsOracleDiff(pool, lib.userId, lib.generationId);
  assert.equal(g.differences, 0, `${where}: grupos != tags+beats`);
};
const versionOf = async (pool, lib, id) => (await pool.query('SELECT version::text AS v FROM catalog_beats WHERE user_id = $1 AND beat_id = $2', [lib.userId, id])).rows[0].v;
const idsIn = async (pool, lib, state) => (await pool.query('SELECT beat_id FROM catalog_beats WHERE user_id = $1 AND state = $2 ORDER BY beat_id', [lib.userId, state])).rows.map((r) => r.beat_id);

test('secuencia aleatoria (semilla fija): facetas == recómputo completo tras cada paso (patch tags, trash, restore, bulk add/remove, bulk trash, rename con fusión)', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { cmd, q } = mk(pool);
  const rnd = mulberry32(20261110);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const some = (arr, n) => { const a = [...arr]; const out = []; while (out.length < n && a.length) out.push(a.splice(Math.floor(rnd() * a.length), 1)[0]); return out; };
  const randTags = (vocab = VOCAB) => { const n = Math.floor(rnd() * 5); return Array.from({ length: n }, () => pick(vocab)).filter((v, i, a) => a.indexOf(v) === i); };
  await seedBeats(pool, lib, Array.from({ length: 40 }, (_, i) => ({ id: `r${String(i).padStart(3, '0')}`, name: `Beat ${i}`, bpm: '120', key: 'Cm', rating: i % 5, tags: randTags(SEED_VOCAB) })));
  // empates de representante: varios beats comparten manual_rank (los grupos siguen por FK ON UPDATE CASCADE)
  await pool.query("UPDATE catalog_beats SET manual_rank = 0 WHERE user_id = $1 AND beat_id IN ('r000','r001','r002','r010','r011')", [lib.userId]);
  await pool.query("UPDATE catalog_beats SET manual_rank = 7000 WHERE user_id = $1 AND beat_id IN ('r020','r021','r022','r030')", [lib.userId]);
  await facets.rebuildFacets(pool, lib.userId, lib.generationId, null, '1'); // reconstrucción completa tras alterar rangos por SQL directo
  await assertExact(pool, lib, 'semilla');
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const stats = { patch: 0, trash: 0, restore: 0, bulkAdd: 0, bulkRemove: 0, bulkTrash: 0, rename: 0 };
  const bulk = async (kind, ids, extra) => {
    const set = await q.createQuerySet({ userId: lib.userId, query: {}, consumer: { id: 'tab', kind: 'SELECTION' } });
    while ((await q.stepQuerySet({ userId: lib.userId, setId: set.setId, batch: 240 })).status === 'BUILDING');
    const sel = await cmd.createSelection({ ...hdr, setId: set.setId, sort: 'manual', defaultSelected: false, consumerId: 'tab' });
    await cmd.applySelectionOp({ ...hdr, selectionId: sel.selectionId, selectionVersion: '0', idempotencyKey: key(), op: { kind: 'INCLUDE_IDS', beatIds: ids } });
    const op = await cmd.createOperation({ ...hdr, idempotencyKey: key(), kind, selectionId: sel.selectionId, selectionVersion: '1', ...extra });
    for (let i = 0; i < 6; i++) { const s = await cmd.stepOperation({ ...hdr, operationId: op.operationId }); if (!['QUEUED', 'RUNNING'].includes(s.status)) break; }
  };
  for (let step = 0; step < 70; step++) {
    const active = await idsIn(pool, lib, 'ACTIVE'); const trash = await idsIn(pool, lib, 'TRASH');
    const r = rnd(); let label;
    if (r < 0.30 && active.length) { const id = pick(active); await cmd.patchBeat({ ...hdr, beatId: id, idempotencyKey: key(), expectedVersion: await versionOf(pool, lib, id), patch: { tags: randTags(), rating: Math.floor(rnd() * 5) } }); stats.patch++; label = 'patch'; }
    else if (r < 0.45 && active.length > 5) { const items = []; for (const id of some(active, 1 + Math.floor(rnd() * 3))) items.push({ beatId: id, expectedVersion: await versionOf(pool, lib, id) }); await cmd.trashBeats({ ...hdr, idempotencyKey: key(), items }); stats.trash++; label = 'trash'; }
    else if (r < 0.60 && trash.length) { const items = []; for (const id of some(trash, 1 + Math.floor(rnd() * 3))) items.push({ beatId: id, expectedVersion: await versionOf(pool, lib, id) }); await cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items }); stats.restore++; label = 'restore'; }
    else if (r < 0.72 && active.length) { await bulk('BULK_PATCH', some(active, 2 + Math.floor(rnd() * 8)), { patch: {}, tagsOp: { op: 'add', tags: some(VOCAB, 1 + Math.floor(rnd() * 2)) } }); stats.bulkAdd++; label = 'bulk add'; }
    else if (r < 0.84 && active.length) { await bulk('BULK_PATCH', some(active, 2 + Math.floor(rnd() * 8)), { patch: {}, tagsOp: { op: 'remove', tags: some(VOCAB, 1 + Math.floor(rnd() * 2)) } }); stats.bulkRemove++; label = 'bulk remove'; }
    else if (r < 0.92 && active.length > 8) { await bulk('BULK_TRASH', some(active, 1 + Math.floor(rnd() * 4)), {}); stats.bulkTrash++; label = 'bulk trash'; }
    else { const from = pick(VOCAB); const to = VOCAB[(VOCAB.indexOf(from) + 1 + Math.floor(rnd() * 3)) % VOCAB.length]; const op = await cmd.createOperation({ ...hdr, idempotencyKey: key(), kind: 'TAG_RENAME', rename: { from, to } }); for (let i = 0; i < 6; i++) { const s = await cmd.stepOperation({ ...hdr, operationId: op.operationId }); if (!['QUEUED', 'RUNNING'].includes(s.status)) break; } stats.rename++; label = 'rename'; }
    await assertExact(pool, lib, `paso ${step} (${label})`);
  }
  for (const [k, v] of Object.entries(stats)) assert.ok(v > 0, `la secuencia ejercitó ${k}`);
}));

test('trash/restore no reescriben grupos (sin DELETE/INSERT sobre catalog_beat_tag_groups): la FK ON UPDATE CASCADE propaga state/manual_rank; facetas exactas', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool);
  const seen = [];
  const spy = { connect: async () => { const c = await pool.connect(); const orig = c.query.bind(c); c.query = (text, ...rest) => { seen.push(typeof text === 'string' ? text : text.text); return orig(text, ...rest); }; const rel = c.release.bind(c); c.release = (...a) => { c.query = orig; return rel(...a); }; return c; }, query: (...a) => pool.query(...a) };
  const { cmd } = mk(pool, spy);
  await seedBeats(pool, lib, Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, bpm: '120', key: 'Cm', rating: 1, tags: ['a', 'b', i % 2 ? 'odd' : 'even'] })));
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  const t = await cmd.trashBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: 't0', expectedVersion: '1' }, { beatId: 't1', expectedVersion: '1' }] });
  const r = await cmd.restoreBeats({ ...hdr, idempotencyKey: key(), items: [{ beatId: 't0', expectedVersion: t.items[0].version }] });
  assert.ok(r.revision);
  const writesGroups = seen.filter((s) => /(DELETE FROM|INSERT INTO)\s+catalog_beat_tag_groups/i.test(s));
  assert.deepEqual(writesGroups, [], 'trash/restore no reescriben catalog_beat_tag_groups');
  const g = (await pool.query("SELECT beat_id, state, manual_rank::text AS rank FROM catalog_beat_tag_groups WHERE user_id = $1 AND norm_key = 'a' ORDER BY beat_id", [lib.userId])).rows;
  const b = (await pool.query("SELECT beat_id, state, manual_rank::text AS rank FROM catalog_beats WHERE user_id = $1 ORDER BY beat_id", [lib.userId])).rows;
  assert.deepEqual(g, b, 'state y manual_rank de los grupos siguen al beat (cascada FK)');
  assert.equal(b.find((x) => x.beat_id === 't1').state, 'TRASH');
  assert.equal(b.find((x) => x.beat_id === 't0').rank, '6000', 'restore sube manual_rank al final (max+1000)');
  await assertExact(pool, lib, 'trash/restore');
  const f = (await pool.query("SELECT scope, beat_count::int AS n, rep_beat_id FROM catalog_facets WHERE user_id = $1 AND norm_key = 'a' ORDER BY scope", [lib.userId])).rows;
  assert.deepEqual(f, [{ scope: 'ACTIVE', n: 5, rep_beat_id: 't2' }, { scope: 'TRASH', n: 1, rep_beat_id: 't1' }]);
}));

test('contador cero: la fila de faceta desaparece; y un delta que dejaría el contador negativo aborta (fail-closed)', () => withDb(async (pool) => {
  const lib = await nativeLibrary(pool); const { cmd } = mk(pool);
  await seedBeats(pool, lib, [{ id: 'z0', name: 'Z0', bpm: '120', key: 'Cm', rating: 1, tags: ['solo', 'x'] }, { id: 'z1', name: 'Z1', bpm: '120', key: 'Cm', rating: 1, tags: ['x'] }]);
  const hdr = { userId: lib.userId, era: lib.era, epoch: lib.epoch };
  await cmd.patchBeat({ ...hdr, beatId: 'z0', idempotencyKey: key(), expectedVersion: '1', patch: { tags: ['x'] } });
  const solo = (await pool.query("SELECT 1 FROM catalog_facets WHERE user_id = $1 AND norm_key = 'solo'", [lib.userId])).rows;
  assert.equal(solo.length, 0, 'sin beats: sin fila (misma convención que el recómputo completo)');
  await assertExact(pool, lib, 'contador cero');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const before = [{ beat_id: 'z0', norm_key: 'nunca', projection_version: 1, state: 'ACTIVE' }];
    await assert.rejects(facets.applyFacetDelta(c, lib.userId, lib.generationId, before, [], '9'), (e) => e.code === 'FACET_DELTA_INCONSISTENT');
  } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
}));
