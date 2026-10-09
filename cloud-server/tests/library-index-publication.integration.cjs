'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { Client, Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations');
const { createLibraryIndexPublication } = require('../library-index-publication');
const { createLibraryBeatQuota } = require('../library-beat-quota');
const { createDirectIndexPinAuthority } = require('../direct-index-pin-authority');

const ADMIN_URL = process.env.BEATGALER_STEP3_TEST_ADMIN_URL || '';
const execFileAsync = promisify(execFile);
const library = ids => ({ schema: 'beatgaler.telegram.library', version: 2,
  beats: ids.map(id => ({ id, title: id })), trash: [], deleted: [] });

test('STEP 4: real PostgreSQL INDEX publication enforces reservations and recovers a pin-before-commit retry',
  { skip: !ADMIN_URL }, async t => {
    const dbName = `beatgaler_f3s4_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Client({ connectionString: ADMIN_URL });
    const dbUrl = new URL(ADMIN_URL);
    dbUrl.pathname = `/${dbName}`;
    let pool;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      pool = new Pool({ connectionString: dbUrl.toString(), max: 12 });
      await applyMigrations(pool);
      await pool.query("INSERT INTO users(id,email) VALUES('free','free-step4@example.com')");
      await pool.query("INSERT INTO vaults(id,user_id,telegram_chat_id) VALUES('vault-free','free','chat-free')");

      const documents = new Map();
      documents.set(500, Buffer.from('master asset'));
      let pinnedId = 42;
      let nextId = 43;
      let failAfterPin = false;
      documents.set(42, Buffer.from(JSON.stringify(library(Array.from({ length: 19 }, (_, i) => `old-${i}`)))));
      const transport = {
        async getPinnedMessage(chatId) {
          assert.equal(chatId, 'chat-free');
          return pinnedId ? { message_id: pinnedId,
            caption: pinnedId === 42 ? 'BEATGALER_LIBRARY_INDEX_V1\nBG_COW_V1=[]' : 'BEATGALER_LIBRARY_INDEX_V1' } : null;
        },
        async downloadMessageBuffer(_chatId, id) {
          const raw = documents.get(Number(id));
          if (!raw) throw new Error('INDEX document missing');
          return raw;
        },
        async publishIndexBuffer({ bytes }) {
          const id = nextId++;
          documents.set(id, Buffer.from(bytes));
          pinnedId = id;
          if (failAfterPin) { failAfterPin = false; throw new Error('simulated process death after pin'); }
          return { messageId: id };
        },
        async deleteMessages(_chatId, ids) { for (const id of ids) documents.delete(Number(id)); },
        async deleteAndVerifyMessages(_chatId, ids) {
          for (const id of ids) documents.delete(Number(id));
          assert.ok(ids.every(id => !documents.has(Number(id))));
          return ids.length;
        },
        async pinExistingIndexMessage(_chatId, id) {
          assert.ok(documents.has(Number(id)));
          pinnedId = Number(id);
        },
      };
      const readIndex = async () => ({ messageId: pinnedId, raw: documents.get(pinnedId),
        manifest: JSON.parse(documents.get(pinnedId).toString('utf8')), serverVerified: true });
      const a = createLibraryIndexPublication({ pool, transport, readIndex });
      const b = createLibraryIndexPublication({ pool, transport, readIndex });
      const quota = createLibraryBeatQuota({ pool, readIndex });

      await t.test('Free 19/20 across two instances admits only one new beat', async () => {
        await quota.bootstrap('free');
        const worker = path.join(__dirname, 'library-index-publication.worker.cjs');
        const results = await Promise.all(['new-a', 'new-b'].map(async beatId => {
          const { stdout } = await execFileAsync(process.execPath, [worker, beatId], {
            env: { ...process.env, BEATGALER_STEP4_TEST_DB_NAME: dbName },
          });
          return JSON.parse(stdout);
        }));
        assert.equal(results.filter(result => result.status === 'PENDING').length, 1);
        assert.equal(results.filter(result => result.code === 'LIBRARY_QUOTA_EXCEEDED').length, 1);
        const winner = results[0].status === 'PENDING' ? 'new-a' : 'new-b';
        const denied = winner === 'new-a' ? 'new-b' : 'new-a';
        const renewal = await b.renew({ userId: 'free', beatId: winner });
        assert.equal(renewal.status, 'PENDING');
        const candidate = library([...Array.from({ length: 19 }, (_, i) => `old-${i}`), winner]);
        await assert.rejects(a.publish({ userId: 'free', chatId: 'chat-free',
          manifest: library([...Array.from({ length: 19 }, (_, i) => `old-${i}`), denied]), expectedMessageId: 42 }),
        { code: 'LIBRARY_QUOTA_RESERVATION_NOT_FOUND' });
        assert.equal(pinnedId, 42);
        failAfterPin = true;
        await assert.rejects(a.publish({ userId: 'free', chatId: 'chat-free', manifest: candidate, expectedMessageId: 42 }),
          /simulated process death/);
        assert.equal((await quota.usage('free')).used, 19);
        const recovered = await b.publish({ userId: 'free', chatId: 'chat-free', manifest: candidate, expectedMessageId: 42 });
        assert.equal(recovered.messageId, 43);
        assert.equal((await quota.usage('free')).used, 20);
        const retry = await a.publish({ userId: 'free', chatId: 'chat-free', manifest: candidate, expectedMessageId: 42 });
        assert.equal(retry.messageId, recovered.messageId);
        assert.equal((await quota.usage('free')).used, 20);
      });

      await t.test('at-cap edits and Trash moves preserve identities without consuming a slot', async () => {
        const before = JSON.parse(documents.get(pinnedId).toString('utf8'));
        const edited = { ...before, beats: before.beats.map((row, i) => i === 0 ? { ...row, title: 'Edited' } : row) };
        const editResult = await a.publish({ userId: 'free', chatId: 'chat-free', manifest: edited, expectedMessageId: pinnedId });
        assert.equal((await quota.usage('free')).used, 20);
        const moved = { ...edited, beats: edited.beats.slice(1),
          trash: [{ beat: { ...edited.beats[0], master: { telegram_message_id: 500 } } }] };
        await b.publish({ userId: 'free', chatId: 'chat-free', manifest: moved, expectedMessageId: editResult.messageId });
        const usage = await quota.usage('free');
        assert.equal(usage.used, 20);
        assert.equal(usage.trash, 1);
        await assert.rejects(a.reserve({ userId: 'free', beatId: 'beat-21' }), { code: 'LIBRARY_QUOTA_EXCEEDED' });
      });

      await t.test('an uncommitted pin is restored from the ledger before another session reads it', async () => {
        const beforeId = pinnedId;
        const before = JSON.parse(documents.get(beforeId).toString('utf8'));
        failAfterPin = true;
        await assert.rejects(a.publish({ userId: 'free', chatId: 'chat-free',
          manifest: { ...before, updated_at: 123 }, expectedMessageId: beforeId }), /simulated process death/);
        assert.notEqual(pinnedId, beforeId);
        assert.deepEqual(await b.recover({ userId: 'free', chatId: 'chat-free' }), { status: 'restored' });
        assert.equal(pinnedId, beforeId);
        assert.equal((await quota.usage('free')).used, 20);
      });

      await t.test('a real Trash purge releases capacity and a previously denied import can retry', async () => {
        const currentId = pinnedId;
        const current = JSON.parse(documents.get(currentId).toString('utf8'));
        const activeId = current.beats[0].id;
        await assert.rejects(a.publish({ userId: 'free', chatId: 'chat-free',
          manifest: { ...current, beats: current.beats.slice(1),
            deleted: [...current.deleted, { beat_id: activeId, deleted_at: 123 }] },
          expectedMessageId: currentId }), { code: 'LIBRARY_PURGE_REQUIRED' });
        assert.equal(pinnedId, currentId);
        const removedId = current.trash[0].beat.id;
        const purged = { ...current, trash: [], deleted: [{ beat_id: removedId, deleted_at: 123 }] };
        await assert.rejects(a.publish({ userId: 'free', chatId: 'chat-free', manifest: purged,
          expectedMessageId: currentId }), { code: 'LIBRARY_PURGE_REQUIRED' });
        await a.purgeTrash({ userId: 'free', chatId: 'chat-free', beatIds: [removedId] });
        assert.equal(documents.has(500), false);
        assert.equal((await quota.usage('free')).used, 19);
        const reserved = await b.reserve({ userId: 'free', beatId: 'beat-21' });
        assert.equal(reserved.status, 'PENDING');
        const confirmed = JSON.parse(documents.get(pinnedId).toString('utf8'));
        const next = { ...confirmed, beats: [...confirmed.beats, { id: 'beat-21' }] };
        await b.publish({ userId: 'free', chatId: 'chat-free', manifest: next, expectedMessageId: pinnedId });
        assert.equal((await quota.usage('free')).used, 20);
      });

      await t.test('a client-pinned altered INDEX cannot be acknowledged and is restored', async () => {
        const committedId = pinnedId;
        const committed = JSON.parse(documents.get(committedId).toString('utf8'));
        const forgedId = nextId++;
        documents.set(forgedId, Buffer.from(JSON.stringify({ ...committed,
          beats: [...committed.beats, { id: 'unreserved-21' }] })));
        pinnedId = forgedId;
        await assert.rejects(a.verifyCommitted({ userId: 'free', chatId: 'chat-free', messageId: forgedId }),
          { code: 'LIBRARY_QUOTA_INDEX_CHANGED' });
        await b.recover({ userId: 'free', chatId: 'chat-free' });
        assert.equal(pinnedId, committedId);
        assert.equal((await quota.usage('free')).used, 20);
      });

      await t.test('older READY bot gains PROJECT media restriction before credentials are exposed', async () => {
        await pool.query("INSERT INTO transport_bots(id) VALUES('bot-a')");
        await pool.query(`UPDATE vaults SET transport_bot_id='bot-a',transport_membership_state='ready',
          index_pin_restricted_bot_id='bot-a' WHERE id='vault-free'`);
        let restrictions = 0;
        const authority = createDirectIndexPinAuthority({ pool, transport: {
          async restrictBotPinRights(chatId, botId) {
            assert.equal(chatId, 'chat-free');
            assert.equal(botId, 'bot-a');
            restrictions += 1;
          },
        } });
        assert.equal(await authority.ensureAll(), 1);
        assert.equal(await authority.ensureAll(), 1);
        assert.equal(restrictions, 1);
        assert.equal((await pool.query('SELECT project_media_restricted_bot_id FROM vaults WHERE id=$1',
          ['vault-free'])).rows[0].project_media_restricted_bot_id, 'bot-a');
      });

      await t.test('downgraded 21/20 library remains editable while all new identities are denied', async () => {
        await pool.query("INSERT INTO users(id,email) VALUES('over','over-step4@example.com')");
        await pool.query("INSERT INTO vaults(id,user_id,telegram_chat_id) VALUES('vault-over','over','chat-over')");
        const docs = new Map([[90, Buffer.from(JSON.stringify(library(Array.from({ length: 21 }, (_, i) => `over-${i}`))))]]);
        let pin = 90;
        const overTransport = {
          async getPinnedMessage() { return { message_id: pin, caption: 'BEATGALER_LIBRARY_INDEX_V1' }; },
          async downloadMessageBuffer(_chatId, id) { return docs.get(Number(id)); },
          async publishIndexBuffer({ bytes }) { pin += 1; docs.set(pin, Buffer.from(bytes)); return { messageId: pin }; },
          async deleteMessages(_chatId, ids) { for (const id of ids) docs.delete(Number(id)); },
        };
        const overReadIndex = async () => ({ messageId: pin, raw: docs.get(pin),
          manifest: JSON.parse(docs.get(pin).toString('utf8')), serverVerified: true });
        const overQuota = createLibraryBeatQuota({ pool, readIndex: overReadIndex });
        const overService = createLibraryIndexPublication({ pool, transport: overTransport, readIndex: overReadIndex });
        await overQuota.bootstrap('over');
        assert.equal((await overQuota.usage('over')).overQuota, true);
        const before = JSON.parse(docs.get(pin).toString('utf8'));
        await overService.publish({ userId: 'over', chatId: 'chat-over',
          manifest: { ...before, beats: before.beats.map((row, i) => i ? row : { ...row, title: 'Still editable' }) },
          expectedMessageId: pin });
        assert.equal((await overQuota.usage('over')).used, 21);
        await assert.rejects(overService.reserve({ userId: 'over', beatId: 'over-22' }),
          { code: 'LIBRARY_QUOTA_EXCEEDED' });
      });

      await t.test('a downgrade rechecks all pending slots before publication', async () => {
        await pool.query("INSERT INTO users(id,email) VALUES('down','down-step4@example.com')");
        await pool.query("INSERT INTO vaults(id,user_id,telegram_chat_id) VALUES('vault-down','down','chat-down')");
        await pool.query(`INSERT INTO billing_subscription_state(user_id,plan_id,status,paid_through)
          VALUES('down','paid_entry','active',$1)`, [new Date(Date.now() + 86400_000)]);
        const docs = new Map([[190, Buffer.from(JSON.stringify(library(Array.from({ length: 19 }, (_, i) => `down-${i}`))))]]);
        let pin = 190;
        const downTransport = {
          async getPinnedMessage() { return { message_id: pin, caption: 'BEATGALER_LIBRARY_INDEX_V1' }; },
          async downloadMessageBuffer(_chatId, id) { return docs.get(Number(id)); },
          async publishIndexBuffer({ bytes }) { pin += 1; docs.set(pin, Buffer.from(bytes)); return { messageId: pin }; },
          async deleteMessages(_chatId, ids) { for (const id of ids) docs.delete(Number(id)); },
        };
        const downReadIndex = async () => ({ messageId: pin, raw: docs.get(pin),
          manifest: JSON.parse(docs.get(pin).toString('utf8')), serverVerified: true });
        const downQuota = createLibraryBeatQuota({ pool, readIndex: downReadIndex });
        const downService = createLibraryIndexPublication({ pool, transport: downTransport, readIndex: downReadIndex });
        await downService.reserve({ userId: 'down', beatId: 'pending-a' });
        await downService.reserve({ userId: 'down', beatId: 'pending-b' });
        await pool.query("UPDATE billing_subscription_state SET paid_through=$1 WHERE user_id='down'",
          [new Date(Date.now() - 1000)]);
        const current = JSON.parse(docs.get(pin).toString('utf8'));
        const candidate = { ...current, beats: [...current.beats, { id: 'pending-a' }] };
        await assert.rejects(downService.publish({ userId: 'down', chatId: 'chat-down',
          manifest: candidate, expectedMessageId: pin }), { code: 'LIBRARY_QUOTA_EXCEEDED' });
        assert.equal(pin, 190);
        await downQuota.cancel({ userId: 'down', reservationId: 'new:pending-b' });
        await downService.publish({ userId: 'down', chatId: 'chat-down', manifest: candidate, expectedMessageId: pin });
        assert.equal((await downQuota.usage('down')).used, 20);
      });
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });
