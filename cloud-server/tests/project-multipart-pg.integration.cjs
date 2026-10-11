'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations');
const { createProjectMultipartRepository } = require('../project-multipart-repository');

const ADMIN_URL = process.env.PROJECT_MULTIPART_TEST_ADMIN_URL || '';
test('resumable PROJECT ledger applies and fences concurrent workers in isolated PostgreSQL',
  { skip: !ADMIN_URL }, async () => {
    const dbName = `beatgaler_project_multipart_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Client({ connectionString: ADMIN_URL });
    const dbUrl = new URL(ADMIN_URL); dbUrl.pathname = `/${dbName}`;
    let pool;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      pool = new Pool({ connectionString: dbUrl.toString(), max: 5 });
      await applyMigrations(pool);
      await pool.query("INSERT INTO users(id,email) VALUES('u1','u1-project@example.com'),('u2','u2-project@example.com')");
      await pool.query("INSERT INTO vaults(id,user_id,telegram_chat_id) VALUES('v1','u1','chat1'),('v2','u2','chat2')");
      const repo = createProjectMultipartRepository(pool);
      assert.equal(await repo.ownsVault('u1', 'chat1'), true);
      assert.equal(await repo.ownsVault('u2', 'chat1'), false);
      await pool.query(`INSERT INTO library_beat_reservations(id,user_id,beat_id,state,expires_at)
        VALUES('new:beat1','u1','beat1','PENDING',now()+interval '1 hour')`);
      assert.equal(await repo.ownsBeatOrReservation('u1', 'beat1'), true);
      assert.equal(await repo.ownsBeatOrReservation('u2', 'beat1'), false);
      const id = crypto.randomUUID();
      const first = { id, userId: 'u1', beatId: 'beat1', clientUploadId: crypto.randomUUID(),
        chatId: 'chat1', threadId: 12, filename: 'PROJECT.zip', fingerprint: 'a'.repeat(64),
        sizeBytes: 1_900_000_000 };
      await repo.insert(first);
      await assert.rejects(repo.insert({ ...first, id: crypto.randomUUID(), beatId: 'another',
        clientUploadId: crypto.randomUUID() }), { code: '23505' });
      assert.equal((await repo.byClient('u1', 'beat1', first.clientUploadId)).id, id);
      assert.equal(await repo.byId('u2', id), null);
      await assert.rejects(repo.insert({ ...first, id: crypto.randomUUID(), clientUploadId: crypto.randomUUID() }),
        { code: '23505' });
      await repo.setUploading(id, 's3-upload-1');
      await repo.setReady(id);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      const holding = repo.withWorkerSlot(async () => { entered(); await gate; return true; });
      await started;
      assert.equal(await repo.withWorkerSlot(async () => true), false);
      release(); assert.equal(await holding, true);
      const claimed = await repo.claim('worker-one');
      assert.equal(claimed.id, id);
      assert.equal(await repo.heartbeat(id, 'worker-two'), false);
      assert.equal(await repo.heartbeat(id, 'worker-one'), true);
      assert.equal(await repo.completeJob(id, 'worker-two', { messageId: 99, sha256: 'b'.repeat(64) }), null);
      assert.equal((await repo.completeJob(id, 'worker-one', { messageId: 99, sha256: 'b'.repeat(64) })).state,
        'COMPLETED');
      assert.ok((await repo.expired()).some(row => row.id === id));
      await repo.insert({ ...first, id: crypto.randomUUID(), clientUploadId: crypto.randomUUID() });
      await assert.rejects(repo.insert({ ...first, id: crypto.randomUUID(), beatId: 'another',
        clientUploadId: crypto.randomUUID(), sizeBytes: 1_900_000_001 }), { code: '23514' });
    } finally {
      if (pool) await pool.end().catch(() => {});
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
        [dbName]).catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {});
      await admin.end().catch(() => {});
    }
  });
