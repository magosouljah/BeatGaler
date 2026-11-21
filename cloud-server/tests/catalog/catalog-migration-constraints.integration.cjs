'use strict';
// T03 — Restricciones de 0041 y 0042 en PostgreSQL aislado, vía catalog-check.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const db = require('../helpers/catalog-test-db.cjs');
const mig = require('../../postgres-migrations.js');

const { Pool } = require(path.join(__dirname, '..', '..', 'node_modules', 'pg'));
db.validateAdminTarget(); // sin destino aprobado el archivo falla, no se salta

async function withDb(fn) {
  const h = await db.createCatalogTestDb();
  const pool = new Pool({ ...h.config, max: 6 });
  try { return await fn(pool, h); } finally { await pool.end(); await h.cleanup(); }
}

async function withRollback(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try { await fn(client); } finally { await client.query('ROLLBACK'); }
  } finally {
    client.release();
  }
}

async function seedUsers(pool) {
  await pool.query("INSERT INTO users(id, email) VALUES ('u1','u1@fake.invalid'), ('u2','u2@fake.invalid')");
  await pool.query("INSERT INTO vaults(id, user_id, telegram_chat_id) VALUES ('v1','u1','-1001'), ('v2','u2','-1002')");
}

const hash = 'a'.repeat(64);

function insertPack(client, id, { userId = 'u1', status = 'FAILED', seq = null, botId = 'bot-1', randomId = String(id) } = {}) {
  return client.query(`
    INSERT INTO catalog_prefix_packs
      (user_id, pack_id, generation_id, status, base_seq, seq, bot_id, random_id, chat_id,
       message_id, size_bytes, sha256, entry_count, data_bytes, published_at, superseded_at)
    VALUES ($1, $2, 'g1', $3, 0, $4, $5, $6, $7,
            CASE WHEN $4::bigint IS NOT NULL THEN $8::bigint END, 1, $9, 1, 1,
            CASE WHEN $4::bigint IS NOT NULL THEN now() END,
            CASE WHEN $3 = 'SUPERSEDED' THEN now() END)`,
  [userId, `pk-fixture-${id}`, status, seq, botId, randomId, userId === 'u1' ? '-1001' : '-1002', id, hash]);
}

test('0041: unicidad de paquetes de prefijos', (t) => withDb(async (pool) => {
  await mig.applyMigrations(pool);
  await seedUsers(pool);
  await pool.query("INSERT INTO catalog_libraries(user_id, vault_id) VALUES ('u1','v1'), ('u2','v2')");

  await t.test('seq: única por biblioteca cuando tiene valor', () => withRollback(pool, async (client) => {
    await insertPack(client, 1, { status: 'SUPERSEDED', seq: 1 });
    await insertPack(client, 2, { status: 'SUPERSEDED', seq: 2 });
    await insertPack(client, 3, { userId: 'u2', status: 'SUPERSEDED', seq: 1 });
    await insertPack(client, 4);
    await insertPack(client, 5);
    await assert.rejects(insertPack(client, 6, { status: 'SUPERSEDED', seq: 1 }), {
      code: '23505', constraint: 'catalog_prefix_packs_seq_idx',
    });
  }));

  await t.test('main: un único PUBLISHED por biblioteca, con histórico SUPERSEDED', () => withRollback(pool, async (client) => {
    await insertPack(client, 1, { status: 'PUBLISHED', seq: 1 });
    await insertPack(client, 2, { status: 'SUPERSEDED', seq: 2 });
    await insertPack(client, 3, { userId: 'u2', status: 'PUBLISHED', seq: 1 });
    await assert.rejects(insertPack(client, 4, { status: 'PUBLISHED', seq: 3 }), {
      code: '23505', constraint: 'catalog_prefix_packs_main_idx',
    });
  }));

  await t.test('build: un único STAGED por biblioteca, con paquetes FAILED', () => withRollback(pool, async (client) => {
    await insertPack(client, 1, { status: 'STAGED' });
    await insertPack(client, 2);
    await insertPack(client, 3, { userId: 'u2', status: 'STAGED' });
    await assert.rejects(insertPack(client, 4, { status: 'STAGED' }), {
      code: '23505', constraint: 'catalog_prefix_packs_build_idx',
    });
  }));

  await t.test('bot/random: pareja única incluso entre bibliotecas', () => withRollback(pool, async (client) => {
    await insertPack(client, 1);
    await insertPack(client, 2);
    await insertPack(client, 3, { botId: 'bot-2', randomId: '1' });
    await assert.rejects(insertPack(client, 4, { userId: 'u2', randomId: '1' }), {
      code: '23505', constraint: 'catalog_prefix_packs_bot_id_random_id_key',
    });
  }));
}));

test('0042: la activación acepta REUSED_UNROTATED y ROTATED y rechaza un valor inválido', () => withDb(async (pool) => {
  await mig.applyMigrations(pool);
  await withRollback(pool, async (client) => {
    const inserted = await client.query(`
      INSERT INTO catalog_native_activation
        (environment_id, run_id, transport_bot_ids, direct_token_exposure, manifest_sha256, instance_inventory)
      VALUES ('lab', 'run-1', '["Bot20"]', 'REUSED_UNROTATED', $1, '[]')
      RETURNING direct_token_exposure`, [hash]);
    assert.deepEqual(inserted.rows, [{ direct_token_exposure: 'REUSED_UNROTATED' }]);

    const updateExposure = (value) => client.query(`
      UPDATE catalog_native_activation SET direct_token_exposure = $1
      WHERE environment_id = 'lab' RETURNING direct_token_exposure`, [value]);
    assert.deepEqual((await updateExposure('ROTATED')).rows, [{ direct_token_exposure: 'ROTATED' }]);
    await assert.rejects(updateExposure('UNKNOWN'), {
      code: '23514', constraint: 'catalog_native_activation_direct_token_exposure_check',
    });
  });
}));
