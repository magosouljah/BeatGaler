'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations');
const { createLibraryIndexPublication } = require('../library-index-publication');
const { createLibraryBeatQuota } = require('../library-beat-quota');

const ADMIN_URL = process.env.BEATGALER_STEP3_TEST_ADMIN_URL || '';
const root = (beats, trash = [], deleted = []) => ({ schema: 'beatgaler.telegram.library', version: 2, beats, trash, deleted });
const beat = (id, master) => ({ id, name: id, master: { telegram_message_id: master,
  telegram_file_id: `direct:${master}` } });

test('STEP 6: real PostgreSQL Trash purge, quota and recovery', { skip: !ADMIN_URL }, async t => {
  const dbName = `beatgaler_f3s6_${crypto.randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: ADMIN_URL });
  const url = new URL(ADMIN_URL); url.pathname = `/${dbName}`;
  let pool;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: url.toString(), max: 16 });
    await applyMigrations(pool);
    const vaults = new Map();
    let nextMessage = 200000;
    let deletionHook = null;
    let publicationHook = null;
    const transport = {
      async getPinnedMessage(chatId) {
        const v = vaults.get(chatId);
        return { message_id: v.pin, caption: 'BEATGALER_LIBRARY_INDEX_V1' };
      },
      async downloadMessageBuffer(chatId, id) {
        const raw = vaults.get(chatId).documents.get(Number(id));
        if (!raw) throw new Error('message missing');
        return raw;
      },
      async publishIndexBuffer({ chatId, bytes }) {
        const v = vaults.get(chatId);
        const id = nextMessage++;
        v.documents.set(id, Buffer.from(bytes));
        v.pin = id;
        if (publicationHook) await publicationHook(chatId, id);
        return { messageId: id };
      },
      async pinExistingIndexMessage(chatId, id) {
        assert.ok(vaults.get(chatId).documents.has(Number(id)));
        vaults.get(chatId).pin = Number(id);
      },
      async deleteMessages(chatId, ids) {
        for (const id of ids) vaults.get(chatId).documents.delete(Number(id));
      },
      async deleteAndVerifyMessages(chatId, ids) {
        const v = vaults.get(chatId);
        for (const id of ids) {
          if (deletionHook) await deletionHook(chatId, id);
          v.documents.delete(Number(id));
        }
        if (ids.some(id => v.documents.has(Number(id)))) throw new Error('delete not verified');
        return ids.length;
      },
    };
    const readIndex = async uid => {
      const v = vaults.get(`chat-${uid}`);
      const raw = v.documents.get(v.pin);
      return { messageId: v.pin, raw, manifest: JSON.parse(raw.toString('utf8')), serverVerified: true };
    };
    const a = createLibraryIndexPublication({ pool, transport, readIndex });
    const b = createLibraryIndexPublication({ pool, transport, readIndex });
    const quota = createLibraryBeatQuota({ pool, readIndex });
    async function setup(uid, manifest, assetIds = [], highest = false) {
      await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [uid, `${uid}@example.com`]);
      if (highest) await pool.query(`INSERT INTO billing_subscription_state(user_id,plan_id,status,paid_through)
        VALUES($1,'highest_paid','active',$2)`, [uid, new Date(Date.now() + 86400_000)]);
      await pool.query('INSERT INTO vaults(id,user_id,telegram_chat_id) VALUES($1,$2,$3)',
        [`vault-${uid}`, uid, `chat-${uid}`]);
      const pin = nextMessage++;
      const documents = new Map([[pin, Buffer.from(JSON.stringify(manifest))]]);
      for (const id of assetIds) documents.set(id, Buffer.from(`asset:${id}`));
      vaults.set(`chat-${uid}`, { pin, documents });
      await quota.bootstrap(uid);
      return { uid, chatId: `chat-${uid}`, get pin() { return vaults.get(`chat-${uid}`).pin; },
        manifest: () => JSON.parse(vaults.get(`chat-${uid}`).documents.get(vaults.get(`chat-${uid}`).pin).toString('utf8')),
        documents };
    }
    const plain20 = (prefix, trashBeat) => root(
      Array.from({ length: 19 }, (_, i) => beat(`${prefix}-${i}`, 300000 + i + nextMessage)),
      [{ beat: trashBeat, trash_id: `trash:${trashBeat.id}` }]);
    async function used(uid) { return (await quota.usage(uid)).used; }
    async function operation(uid, id) {
      return (await pool.query('SELECT state,operation_id,last_error FROM library_trash_purges WHERE user_id=$1 AND beat_id=$2',
        [uid, id])).rows[0];
    }

    await t.test('A/B/C/F/H/I: move, restore, confirmed purge and durable anti-resurrection', async () => {
      const original = root(Array.from({ length: 20 }, (_, i) => beat(`life-${i}`, 10000 + i)));
      const v = await setup('life', original, [10000]);
      const moved = { ...original, beats: original.beats.slice(1), trash: [{ beat: original.beats[0], trash_id: 'trash:life-0' }] };
      await a.publish({ userId: v.uid, chatId: v.chatId, manifest: moved, expectedMessageId: v.pin });
      assert.equal(await used(v.uid), 20);
      assert.equal((await quota.usage(v.uid)).trash, 1);
      const restored = { ...moved, beats: original.beats, trash: [] };
      await b.publish({ userId: v.uid, chatId: v.chatId, manifest: restored, expectedMessageId: v.pin });
      assert.equal(await used(v.uid), 20);
      await a.publish({ userId: v.uid, chatId: v.chatId, manifest: moved, expectedMessageId: v.pin });
      assert.equal(await used(v.uid), 20);
      await assert.rejects(a.assertPurged({ userId: v.uid, beatIds: ['life-0'] }), { code: 'LIBRARY_PURGE_REQUIRED' });
      const naked = { ...moved, trash: [], deleted: [{ beat_id: 'life-0', deleted_at: 1 }] };
      await assert.rejects(a.publish({ userId: v.uid, chatId: v.chatId, manifest: naked, expectedMessageId: v.pin }),
        { code: 'LIBRARY_PURGE_REQUIRED' });
      assert.equal(await used(v.uid), 20);
      const confirmed = await a.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['life-0'] });
      assert.equal(confirmed.deleted, 1);
      assert.equal(await used(v.uid), 19);
      assert.equal(v.documents.has(10000), false);
      assert.equal((await operation(v.uid, 'life-0')).state, 'CONFIRMED');
      assert.equal(await a.assertPurged({ userId: v.uid, beatIds: ['life-0'] }), true);
      const retry = await b.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['life-0'] });
      assert.equal(retry.status, 'confirmed');
      assert.equal(retry.operationIds[0], 'purge:life-0');
      assert.equal(await used(v.uid), 19);
      await assert.rejects(a.publish({ userId: v.uid, chatId: v.chatId,
        manifest: { ...v.manifest(), beats: [original.beats[0], ...v.manifest().beats] },
        expectedMessageId: v.pin }), { code: 'LIBRARY_PURGE_TOMBSTONE' });
      await assert.rejects(a.publish({ userId: v.uid, chatId: v.chatId, manifest: moved,
        expectedMessageId: v.pin }), { code: 'LIBRARY_PURGE_TOMBSTONE' });
      await assert.rejects(a.reserve({ userId: v.uid, beatId: 'life-0' }), { code: 'LIBRARY_PURGE_TOMBSTONE' });
      assert.equal(v.manifest().trash.length, 0);
      assert.equal(v.manifest().deleted.some(row => row.beat_id === 'life-0'), true);
    });

    await t.test('D/E/G/P: before, partial and post-delete failures retain quota until verified retry', async () => {
      const rich = { ...beat('fault-target', 11000), artwork: { telegram_message_id: 11001 }, metadata_message_id: 11008,
        files: [{ type: 'WAV', manifest: { parts: [{ telegram_message_id: 11002 }, { telegram_message_id: 11003 }] } }],
        project: { manifest: { parts: [{ telegram_message_id: 11004 }, { telegram_message_id: 11005 }] } } };
      const v = await setup('fault', plain20('fault', rich), [11000,11001,11002,11003,11004,11005,11006,11007,11008,11009]);
      await pool.query(`INSERT INTO library_project_uploads(user_id,beat_id,sha256,message_id,telegram_document_id,size_bytes)
        VALUES('fault','fault-target',$1,11006,'doc-11006',1)`, ['a'.repeat(64)]);
      await pool.query(`INSERT INTO library_legacy_project_copies(user_id,beat_id,part_index,source_message_id,message_id,telegram_document_id,size_bytes)
        VALUES('fault','fault-target',0,11009,11007,'doc-11007',1)`);
      deletionHook = async () => { throw new Error('before delete'); };
      await assert.rejects(a.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['fault-target'] }), /before delete/);
      assert.equal(await used(v.uid), 20);
      assert.equal((await operation(v.uid, 'fault-target')).state, 'PENDING');
      assert.ok((await operation(v.uid, 'fault-target')).last_error);
      await assert.rejects(a.publish({ userId: v.uid, chatId: v.chatId,
        manifest: { ...v.manifest(), trash: [], beats: [...v.manifest().beats, rich] },
        expectedMessageId: v.pin }), { code: 'LIBRARY_PURGE_PENDING' });
      deletionHook = async (_chatId, id) => { if (id === 11005) throw new Error('PROJECT part delete failed'); };
      await assert.rejects(b.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['fault-target'] }), /PROJECT part delete failed/);
      assert.equal(await used(v.uid), 20);
      assert.equal(v.documents.has(11000), false);
      assert.equal(v.documents.has(11005), true);
      deletionHook = null;
      publicationHook = async () => { publicationHook = null; throw new Error('after all assets before commit'); };
      await assert.rejects(a.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['fault-target'] }), /after all assets before commit/);
      assert.equal(await used(v.uid), 20);
      assert.equal([11000,11001,11002,11003,11004,11005,11006,11007,11008,11009].every(id => !v.documents.has(id)), true);
      assert.equal((await operation(v.uid, 'fault-target')).state, 'PENDING');
      await b.recover({ userId: v.uid, chatId: v.chatId });
      assert.equal(v.manifest().trash.length, 1);
      await b.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['fault-target'] });
      assert.equal(await used(v.uid), 19);
      assert.equal((await operation(v.uid, 'fault-target')).state, 'CONFIRMED');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM library_project_uploads WHERE user_id='fault'")).rows[0].n, 0);
    });

    await t.test('G: startup recovery resumes a durable pending purge', async () => {
      const v = await setup('restart', plain20('restart', beat('restart-target', 11100)), [11100]);
      deletionHook = async () => { throw new Error('process stopped before delete'); };
      await assert.rejects(a.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['restart-target'] }),
        /process stopped before delete/);
      assert.equal(await used(v.uid), 20);
      deletionHook = null;
      await b.recoverAll();
      assert.equal(await used(v.uid), 19);
      assert.equal((await operation(v.uid, 'restart-target')).state, 'CONFIRMED');
    });

    await t.test('H: historical INDEX tombstones stay protected without false deletion proof', async () => {
      const v = await setup('legacy6', root([], [], [{ beat_id: 'old-deleted', deleted_at: 1 }]));
      assert.equal((await operation(v.uid, 'old-deleted')).state, 'LEGACY_TOMBSTONE');
      await assert.rejects(a.reserve({ userId: v.uid, beatId: 'old-deleted' }), { code: 'LIBRARY_PURGE_TOMBSTONE' });
      await assert.rejects(a.assertPurged({ userId: v.uid, beatIds: ['old-deleted'] }), { code: 'LIBRARY_PURGE_REQUIRED' });
      await pool.query("DELETE FROM library_trash_purges WHERE user_id='legacy6'");
      await b.recover({ userId: v.uid, chatId: v.chatId });
      assert.equal((await operation(v.uid, 'old-deleted')).state, 'LEGACY_TOMBSTONE');
    });

    await t.test('O/P: shared or unverifiable media never deletes another beat or frees quota', async () => {
      const shared = plain20('shared', beat('shared-target', 15000));
      shared.beats[0].master.telegram_message_id = 15000;
      shared.beats[0].master.telegram_file_id = 'direct:15000';
      const v = await setup('shared6', shared, [15000]);
      await assert.rejects(a.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['shared-target'] }),
        { code: 'LIBRARY_PURGE_ASSETS_UNVERIFIED' });
      assert.equal(await used(v.uid), 20);
      assert.equal(v.documents.has(15000), true);
      const unverifiable = plain20('unknown', { id: 'unknown-target', master: { telegram_file_id: 'opaque-bot-file' } });
      const other = await setup('unknown6', unverifiable);
      await assert.rejects(a.purgeTrash({ userId: other.uid, chatId: other.chatId, beatIds: ['unknown-target'] }),
        { code: 'LIBRARY_PURGE_ASSETS_UNVERIFIED' });
      assert.equal(await used(other.uid), 20);
      const receipt = await setup('receipt6', plain20('receipt', beat('receipt-target', 16000)), [16000]);
      await pool.query(`INSERT INTO library_project_uploads(user_id,beat_id,sha256,message_id,telegram_document_id,size_bytes)
        VALUES('receipt6','receipt-0',$1,16000,'shared-receipt',1)`, ['b'.repeat(64)]);
      await assert.rejects(a.purgeTrash({ userId: receipt.uid, chatId: receipt.chatId, beatIds: ['receipt-target'] }),
        { code: 'LIBRARY_PURGE_ASSETS_UNVERIFIED' });
      assert.equal(receipt.documents.has(16000), true);
      assert.equal(await used(receipt.uid), 20);
    });

    await t.test('J/K/L: 100/20 retains reading and editing; imports return only below the limit', async () => {
      const original = root(Array.from({ length: 100 }, (_, i) => beat(`over-${i}`, 12000 + i)));
      const v = await setup('over6', original, Array.from({ length: 100 }, (_, i) => 12000 + i), true);
      assert.equal((await quota.usage(v.uid)).limit, null);
      await pool.query("UPDATE billing_subscription_state SET paid_through=now()-interval '1 day' WHERE user_id='over6'");
      const usage = await quota.usage(v.uid);
      assert.equal(usage.used, 100); assert.equal(usage.limit, 20); assert.equal(usage.overQuota, true);
      assert.equal(v.manifest().beats.length, 100);
      assert.ok((await transport.downloadMessageBuffer(v.chatId, 12000)).length > 0);
      const edited = { ...original, beats: original.beats.map((row, i) => i ? row : { ...row, name: 'metadata edit' }) };
      await a.publish({ userId: v.uid, chatId: v.chatId, manifest: edited, expectedMessageId: v.pin });
      const moved = { ...edited, beats: edited.beats.slice(81),
        trash: edited.beats.slice(0, 81).map(row => ({ beat: row })) };
      await a.publish({ userId: v.uid, chatId: v.chatId, manifest: moved, expectedMessageId: v.pin });
      assert.equal(await used(v.uid), 100);
      const restored = { ...moved, beats: edited.beats, trash: [] };
      await b.publish({ userId: v.uid, chatId: v.chatId, manifest: restored, expectedMessageId: v.pin });
      assert.equal(await used(v.uid), 100);
      await a.publish({ userId: v.uid, chatId: v.chatId, manifest: moved, expectedMessageId: v.pin });
      assert.equal(await used(v.uid), 100);
      await assert.rejects(a.reserve({ userId: v.uid, beatId: 'over-new' }), { code: 'LIBRARY_QUOTA_EXCEEDED' });
      await a.purgeTrash({ userId: v.uid, chatId: v.chatId,
        beatIds: moved.trash.map(row => row.beat.id) });
      assert.equal(await used(v.uid), 19);
      assert.equal((await a.reserve({ userId: v.uid, beatId: 'over-new' })).status, 'PENDING');
      const next = { ...v.manifest(), beats: [...v.manifest().beats, beat('over-new', 12999)] };
      await a.publish({ userId: v.uid, chatId: v.chatId, manifest: next, expectedMessageId: v.pin });
      assert.equal(await used(v.uid), 20);
    });

    await t.test('M/N/O: purge/import race, duplicate purge and tenant isolation', async () => {
      const v = await setup('race', plain20('race', beat('race-target', 13000)), [13000]);
      const other = await setup('other6', plain20('other', beat('other-target', 14000)), [14000]);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      let entered;
      const reached = new Promise(resolve => { entered = resolve; });
      deletionHook = async chatId => { if (chatId === v.chatId) { entered(); await gate; } };
      const first = a.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['race-target'] });
      await reached;
      let reserveDone = false;
      const reservation = b.reserve({ userId: v.uid, beatId: 'race-new' }).then(result => { reserveDone = true; return result; });
      const second = b.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['race-target'] });
      await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(reserveDone, false);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM library_beats WHERE user_id='race'")).rows[0].n, 20);
      assert.equal(await used(other.uid), 20);
      assert.equal(other.documents.has(14000), true);
      release(); deletionHook = null;
      const [one, two, reserved] = await Promise.all([first, second, reservation]);
      assert.equal(one.status, 'confirmed'); assert.equal(two.status, 'confirmed');
      assert.equal(reserved.status, 'PENDING');
      assert.equal(await used(v.uid), 19);
      assert.equal(await used(other.uid), 20);
      assert.equal((await operation(v.uid, 'race-target')).operation_id, 'purge:race-target');
      assert.equal(await b.purgeTrash({ userId: v.uid, chatId: v.chatId, beatIds: ['race-target'] }).then(r => r.deleted), 1);
      assert.equal(await used(v.uid), 19);
    });
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});
