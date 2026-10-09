'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client, Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations');
const { measureProjectChunks } = require('../project-upload-authority');
const { createLibraryIndexPublication } = require('../library-index-publication');
const { createLibraryBeatQuota } = require('../library-beat-quota');

const ADMIN_URL = process.env.BEATGALER_STEP3_TEST_ADMIN_URL || '';
const MB = 1_000_000;
const empty = () => ({ schema: 'beatgaler.telegram.library', version: 2, beats: [], trash: [], deleted: [] });
const beat = (id, project = null) => ({ id, name: id, ...(project ? { project } : {}) });
const project = (messageId, size, filename = 'project.zip') => ({
  size,
  manifest: { telegram_file_id: `direct:${messageId}`, telegram_message_id: messageId,
    filename, original_size: size, transport: 'direct-web',
    parts: [{ telegram_file_id: `direct:${messageId}`, telegram_message_id: messageId,
      index: 0, size, filename }] },
});
async function* sizedChunks(size) {
  const chunk = Buffer.alloc(MB);
  let remaining = size;
  while (remaining >= chunk.length) { yield chunk; remaining -= chunk.length; }
  if (remaining) yield chunk.subarray(0, remaining);
}

test('PROJECT byte counter uses received chunks and stops at the exact decimal ceiling', async () => {
  await assert.rejects(measureProjectChunks(sizedChunks(0), 1_000_000_000), { code: 'PROJECT_BYTES_UNVERIFIED' });
  assert.equal((await measureProjectChunks(sizedChunks(1_000_000_000), 1_000_000_000)).bytes, 1_000_000_000);
  await assert.rejects(measureProjectChunks(sizedChunks(1_000_000_001), 1_000_000_000), { code: 'PROJECT_TOO_LARGE' });
  assert.equal((await measureProjectChunks(sizedChunks(1_900_000_000), 1_900_000_000)).bytes, 1_900_000_000);
  await assert.rejects(measureProjectChunks(sizedChunks(1_900_000_001), 1_900_000_000), { code: 'PROJECT_TOO_LARGE' });
});

test('STEP 5: PROJECT publication enforces Access and server-measured bytes on real PostgreSQL',
  { skip: !ADMIN_URL }, async t => {
    const dbName = `beatgaler_f3s5_${crypto.randomBytes(6).toString('hex')}`;
    const admin = new Client({ connectionString: ADMIN_URL });
    const dbUrl = new URL(ADMIN_URL); dbUrl.pathname = `/${dbName}`;
    let pool;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      pool = new Pool({ connectionString: dbUrl.toString(), max: 8 });
      await applyMigrations(pool);
      const chats = new Map();
      const docs = new Map();
      const pins = new Map();
      const projectBytes = new Map();
      const legacyCopies = new Map();
      let nextId = 100;
      let writes = 0;
      let failAfterPin = false;
      let masterProjectWrites = 0;
      let failAfterMasterSend = false;
      for (const [userId, starting, paid] of [
        ['free', Array.from({ length: 19 }, (_, i) => beat(`old-${i}`)), null],
        ['entry', [], 'paid_entry'],
        ['highest', [], 'highest_paid'],
        ['other', [], 'paid_entry'],
      ]) {
        const chatId = `chat-${userId}`;
        if (userId === 'free') {
          starting[0].project = { size: 7, manifest: {
            telegram_file_id: 'direct:9100', telegram_message_id: 9100,
            original_size: 7, filename: 'old-project.zip',
            parts: [
              { index: 0, telegram_file_id: 'direct:9100', telegram_message_id: 9100, size: 3 },
              { index: 1, telegram_file_id: 'direct:9101', telegram_message_id: 9101, size: 4 },
            ],
          } };
          projectBytes.set(`${chatId}:9100`, { beatId: 'old-0', actualBytes: 3,
            sha256: 'legacy', documentId: 'old-doc-0' });
          projectBytes.set(`${chatId}:9101`, { beatId: 'old-0', actualBytes: 4,
            sha256: 'legacy', documentId: 'old-doc-1' });
        }
        chats.set(userId, chatId);
        await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [userId, `${userId}-step5@example.com`]);
        await pool.query('INSERT INTO vaults(id,user_id,telegram_chat_id) VALUES($1,$2,$3)', [`vault-${userId}`, userId, chatId]);
        if (paid) await pool.query(`INSERT INTO billing_subscription_state(user_id,plan_id,status,paid_through)
          VALUES($1,$2,'active',$3)`, [userId, paid, new Date(Date.now() + 86400_000)]);
        const id = nextId++;
        pins.set(chatId, id);
        docs.set(`${chatId}:${id}`, Buffer.from(JSON.stringify({ ...empty(), beats: starting })));
      }
      const transport = {
        async getPinnedMessage(chatId) { return { message_id: pins.get(chatId), caption: 'BEATGALER_LIBRARY_INDEX_V1' }; },
        async downloadMessageBuffer(chatId, id) {
          const raw = docs.get(`${chatId}:${id}`);
          if (!raw) throw new Error('INDEX document missing');
          return raw;
        },
        async publishIndexBuffer({ chatId, bytes }) {
          const id = nextId++;
          docs.set(`${chatId}:${id}`, Buffer.from(bytes));
          pins.set(chatId, id);
          writes += 1;
          if (failAfterPin) { failAfterPin = false; throw new Error('simulated crash after pin'); }
          return { messageId: id };
        },
        async pinExistingIndexMessage(chatId, id) { pins.set(chatId, id); },
        async deleteMessages(chatId, ids) { for (const id of ids) docs.delete(`${chatId}:${id}`); },
        async publishProjectFile({ chatId, beatId, sha256, sizeBytes }) {
          const id = nextId++;
          masterProjectWrites += 1;
          projectBytes.set(`${chatId}:${id}`, { beatId, actualBytes: sizeBytes, sha256, documentId: `doc-${id}` });
          if (failAfterMasterSend) { failAfterMasterSend = false; throw new Error('simulated crash after MASTER send'); }
          return { messageId: id, documentId: `doc-${id}` };
        },
        async findProjectFile({ chatId, beatId, sha256, sizeBytes }) {
          for (const [key, stored] of projectBytes) {
            if (!key.startsWith(`${chatId}:`) || stored.beatId !== beatId ||
                stored.sha256 !== sha256 || stored.actualBytes !== sizeBytes) continue;
            return { messageId: Number(key.split(':')[1]), documentId: stored.documentId };
          }
          return null;
        },
        async verifyProjectMessage({ chatId, messageId, beatId, sha256, documentId, sizeBytes }) {
          const stored = projectBytes.get(`${chatId}:${messageId}`);
          if (!stored || stored.beatId !== beatId || stored.sha256 !== sha256 ||
              stored.documentId !== documentId || stored.actualBytes !== sizeBytes) {
            throw new Error('MASTER PROJECT receipt is not scoped to this beat');
          }
          if (stored.failStream) {
            throw new Error('MASTER PROJECT verification interrupted');
          }
          return true;
        },
        async copyLegacyProjectPart({ chatId, beatId, sourceMessageId, partIndex }) {
          const key = `${chatId}:${beatId}:${sourceMessageId}:${partIndex}`;
          if (legacyCopies.has(key)) return legacyCopies.get(key);
          const source = projectBytes.get(`${chatId}:${sourceMessageId}`);
          if (!source) throw new Error('legacy source unavailable');
          const messageId = nextId++;
          const copy = { sourceMessageId, messageId, documentId: source.documentId,
            sizeBytes: source.actualBytes, partIndex };
          legacyCopies.set(key, copy);
          projectBytes.set(`${chatId}:${messageId}`, { ...source, masterCopy: true });
          return copy;
        },
        async verifyLegacyProjectCopy({ chatId, beatId, sourceMessageId, messageId,
          documentId, sizeBytes, partIndex }) {
          const copy = legacyCopies.get(`${chatId}:${beatId}:${sourceMessageId}:${partIndex}`);
          const stored = projectBytes.get(`${chatId}:${messageId}`);
          if (!copy || copy.messageId !== messageId || !stored?.masterCopy ||
              stored.documentId !== documentId || stored.actualBytes !== sizeBytes) {
            throw new Error('MASTER legacy copy invalid');
          }
        },
      };
      const readIndex = async userId => {
        const chatId = chats.get(userId), id = pins.get(chatId), raw = docs.get(`${chatId}:${id}`);
        return { messageId: id, raw, manifest: JSON.parse(raw.toString('utf8')), serverVerified: true };
      };
      const service = createLibraryIndexPublication({ pool, transport, readIndex });
      const quota = createLibraryBeatQuota({ pool, readIndex });
      const current = userId => {
        const chatId = chats.get(userId), id = pins.get(chatId);
        return { chatId, id, manifest: JSON.parse(docs.get(`${chatId}:${id}`).toString('utf8')) };
      };
      const attach = async (userId, beatId, messageId, actualBytes, declaredBytes = actualBytes, filename,
        withReceipt = true) => {
        const sha256 = crypto.createHash('sha256').update(`${userId}:${beatId}:${messageId}`).digest('hex');
        const documentId = `doc-${messageId}`;
        projectBytes.set(`${chats.get(userId)}:${messageId}`, { beatId, actualBytes, sha256, documentId });
        if (withReceipt) await pool.query(`INSERT INTO library_project_uploads
          (user_id,beat_id,sha256,message_id,telegram_document_id,size_bytes) VALUES($1,$2,$3,$4,$5,$6)`,
        [userId, beatId, sha256, messageId, documentId, actualBytes]);
        return beat(beatId, project(messageId, declaredBytes, filename));
      };
      const publish = (userId, manifest, expectedMessageId) =>
        service.publish({ userId, chatId: chats.get(userId), manifest, expectedMessageId });

      await t.test('A/J/K: Free 19/20 cannot publish a new PROJECT, even with a beat reservation', async () => {
        await assert.rejects(service.authorizeProject({ userId: 'free', declaredBytes: 1 }), { code: 'PROJECT_UPLOAD_DENIED' });
        await service.reserve({ userId: 'free', beatId: 'free-new' });
        const before = current('free');
        const candidate = { ...before.manifest, beats: [...before.manifest.beats,
          await attach('free', 'free-new', 8001, 1, 1, undefined, false)] };
        await assert.rejects(publish('free', candidate, before.id), { code: 'PROJECT_UPLOAD_DENIED' });
        assert.equal(pins.get(before.chatId), before.id);
        assert.equal((await quota.usage('free')).used, 19);
        await service.cancel({ userId: 'free', beatId: 'free-new' });
        assert.equal((await quota.usage('free')).pending, 0);
      });

      await t.test('MASTER upload counts the disk stream, stores one receipt and reuses it on retry', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-step5-'));
        const filePath = path.join(dir, 'project.zip');
        fs.writeFileSync(filePath, Buffer.from('real project bytes'));
        try {
          const input = { userId: 'other', beatId: 'upload-once', chatId: chats.get('other'),
            filePath, filename: 'project.zip', threadId: 0 };
          const first = await service.uploadProject(input);
          const second = await service.uploadProject(input);
          assert.equal(first.bytes, Buffer.byteLength('real project bytes'));
          assert.equal(second.messageId, first.messageId);
          assert.equal(second.status, 'same');
          assert.equal(masterProjectWrites, 1);
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM library_project_uploads WHERE user_id=$1 AND beat_id=$2',
            ['other', 'upload-once'])).rows[0].n, 1);
          assert.equal((await quota.usage('other')).used, 0);
        } finally {
          fs.unlinkSync(filePath);
          fs.rmdirSync(dir);
        }
      });

      await t.test('MASTER send acknowledged before a crash is recovered without a second asset', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-step5-retry-'));
        const filePath = path.join(dir, 'project.zip');
        fs.writeFileSync(filePath, Buffer.from('recoverable project bytes'));
        try {
          const input = { userId: 'other', beatId: 'crash-before-receipt', chatId: chats.get('other'),
            filePath, filename: 'project.zip', threadId: 0 };
          failAfterMasterSend = true;
          const before = masterProjectWrites;
          await assert.rejects(service.uploadProject(input), /simulated crash after MASTER send/);
          const recovered = await service.uploadProject(input);
          assert.equal(recovered.status, 'uploaded');
          assert.equal(masterProjectWrites, before + 1);
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM library_project_uploads WHERE user_id=$1 AND beat_id=$2',
            ['other', 'crash-before-receipt'])).rows[0].n, 1);
        } finally { fs.unlinkSync(filePath); fs.rmdirSync(dir); }
      });

      await t.test('C/D/G: Entry accepts 1 GB, rejects 1 GB+1 and ignores a false smaller declaration', async () => {
        await service.reserve({ userId: 'entry', beatId: 'entry-project' });
        const before = current('entry');
        const exact = { ...before.manifest, beats: [await attach('entry', 'entry-project', 8100, 1_000_000_000)] };
        await publish('entry', exact, before.id);
        assert.equal((await quota.usage('entry')).used, 1);
        await service.reserve({ userId: 'entry', beatId: 'too-large' });
        const now = current('entry');
        const oversized = { ...now.manifest, beats: [...now.manifest.beats,
          await attach('entry', 'too-large', 8101, 1_000_000_001, 1_000_000_000, 'renamed.mp3')] };
        await assert.rejects(publish('entry', oversized, now.id), { code: 'PROJECT_TOO_LARGE' });
        assert.equal((await quota.usage('entry')).used, 1);
        assert.equal(pins.get(now.chatId), now.id);
        await service.cancel({ userId: 'entry', beatId: 'too-large' });
        await assert.rejects(service.authorizeProject({ userId: 'entry', declaredBytes: 1_000_000_001 }), { code: 'PROJECT_TOO_LARGE' });
      });

      await t.test('E/F/M: Highest accepts 1.9 GB and rejects 1.9 GB+1 independently', async () => {
        await service.reserve({ userId: 'highest', beatId: 'highest-project' });
        const before = current('highest');
        await publish('highest', { ...before.manifest, beats: [await attach('highest', 'highest-project', 8200, 1_900_000_000)] }, before.id);
        await service.reserve({ userId: 'highest', beatId: 'highest-too-large' });
        const now = current('highest');
        await assert.rejects(publish('highest', { ...now.manifest, beats: [...now.manifest.beats,
          await attach('highest', 'highest-too-large', 8201, 1_900_000_001)] }, now.id), { code: 'PROJECT_TOO_LARGE' });
        assert.equal((await quota.usage('highest')).used, 1);
        await service.cancel({ userId: 'highest', beatId: 'highest-too-large' });
        assert.equal((await quota.usage('other')).used, 0);
      });

      await t.test('K: altered PROJECT reference, false size and cross-beat document do not publish', async () => {
        const before = current('highest');
        const original = before.manifest.beats[0];
        const botOnly = await attach('highest', original.id, 8205, 10, 10, 'generic.zip', false);
        await assert.rejects(publish('highest', { ...before.manifest, beats: [botOnly] }, before.id),
          { code: 'PROJECT_UPLOAD_UNVERIFIED' });
        const forged = beat(original.id, project(8202, 10));
        forged.project.manifest.parts[0].telegram_message_id = 9999;
        await assert.rejects(publish('highest', { ...before.manifest, beats: [forged] }, before.id),
          { code: 'PROJECT_REFERENCE_INVALID' });
        const falseSize = await attach('highest', original.id, 8203, 10, 9);
        await assert.rejects(publish('highest', { ...before.manifest, beats: [falseSize] }, before.id),
          { code: 'PROJECT_SIZE_MISMATCH' });
        const foreignBeat = await attach('highest', original.id, 8204, 10);
        projectBytes.get(`${before.chatId}:8204`).beatId = 'different-beat';
        await assert.rejects(publish('highest', { ...before.manifest, beats: [foreignBeat] }, before.id),
          /not scoped to this beat/);
        assert.equal(pins.get(before.chatId), before.id);
      });

      await t.test('J: interrupted MASTER verification leaves no published beat and its slot can be released', async () => {
        await service.reserve({ userId: 'other', beatId: 'interrupted' });
        const before = current('other');
        const candidate = { ...before.manifest, beats: [await attach('other', 'interrupted', 8299, 100)] };
        projectBytes.get(`${before.chatId}:8299`).failStream = true;
        await assert.rejects(publish('other', candidate, before.id), /MASTER PROJECT verification interrupted/);
        assert.equal(pins.get(before.chatId), before.id);
        assert.equal((await quota.usage('other')).used, 0);
        await service.cancel({ userId: 'other', beatId: 'interrupted' });
        assert.equal((await quota.usage('other')).pending, 0);
      });

      await t.test('B/H/I: downgrade preserves old PROJECT and metadata edit but denies replacement', async () => {
        await pool.query('UPDATE billing_subscription_state SET paid_through=$1 WHERE user_id=$2',
          [new Date(Date.now() - 1000), 'entry']);
        const before = current('entry');
        const existing = before.manifest.beats[0];
        assert.equal(projectBytes.get(`${before.chatId}:8100`).actualBytes, 1_000_000_000);
        await assert.rejects(service.authorizeProject({ userId: 'entry', declaredBytes: 1 }), { code: 'PROJECT_UPLOAD_DENIED' });
        const edited = { ...before.manifest, beats: [{ ...existing, name: 'edited after downgrade' }] };
        await publish('entry', edited, before.id);
        assert.equal(current('entry').manifest.beats[0].project.manifest.telegram_message_id, 8100);
        const now = current('entry');
        await assert.rejects(publish('entry', { ...now.manifest, beats: [
          await attach('entry', 'entry-project', 8102, 10)] }, now.id), { code: 'PROJECT_UPLOAD_DENIED' });
        assert.equal(current('entry').manifest.beats[0].project.manifest.telegram_message_id, 8100);
      });

      await t.test('legacy Direct PROJECT migrates to MASTER before another Direct session, including pin crash retry', async () => {
        await pool.query('DELETE FROM library_project_uploads WHERE user_id=$1 AND beat_id=$2',
          ['entry', 'entry-project']);
        const poisoned = current('entry');
        poisoned.manifest.beats[0].project.manifest.legacy_master_copy = true;
        const poisonedBytes = Buffer.from(JSON.stringify(poisoned.manifest));
        docs.set(`${poisoned.chatId}:${poisoned.id}`, poisonedBytes);
        await pool.query('UPDATE library_quota_state SET index_sha256=$2 WHERE user_id=$1',
          ['entry', crypto.createHash('sha256').update(poisonedBytes).digest('hex')]);
        const before = current('entry');
        const originalMessageId = before.manifest.beats[0].project.manifest.telegram_message_id;
        failAfterPin = true;
        await assert.rejects(service.migrateLegacyProjects({ userId: 'entry', chatId: before.chatId }),
          /simulated crash after pin/);
        assert.equal((await quota.usage('entry')).used, 1);
        const copiesBeforeRetry = legacyCopies.size;
        const migrated = await service.migrateLegacyProjects({ userId: 'entry', chatId: before.chatId });
        assert.equal(migrated.status, 'migrated');
        assert.equal(legacyCopies.size, copiesBeforeRetry);
        const after = current('entry');
        const newProject = after.manifest.beats[0].project;
        const newMessageId = newProject.manifest.telegram_message_id;
        assert.notEqual(newMessageId, originalMessageId);
        assert.equal(newProject.manifest.legacy_master_copy, true);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM library_legacy_project_copies WHERE user_id=$1',
          ['entry'])).rows[0].n, 1);
        projectBytes.get(`${before.chatId}:${originalMessageId}`).actualBytes = 123;
        assert.equal(projectBytes.get(`${before.chatId}:${newMessageId}`).actualBytes, 1_000_000_000);
        const stable = await service.migrateLegacyProjects({ userId: 'entry', chatId: before.chatId });
        assert.equal(stable.status, 'current');
        assert.equal(legacyCopies.size, copiesBeforeRetry);
        await publish('entry', { ...after.manifest, beats: [{ ...after.manifest.beats[0], name: 'Free metadata edit' }] }, after.id);
        const now = current('entry');
        const forged = beat('entry-project', project(8999, 100));
        forged.project.manifest.legacy_master_copy = true;
        await assert.rejects(publish('entry', { ...now.manifest, beats: [forged] }, now.id),
          { code: 'PROJECT_UPLOAD_DENIED' });
      });

      await t.test('Free legacy multipart PROJECT remains readable after MASTER migration', async () => {
        const before = current('free');
        const result = await service.migrateLegacyProjects({ userId: 'free', chatId: before.chatId });
        assert.equal(result.status, 'migrated');
        const after = current('free');
        const migrated = after.manifest.beats[0].project;
        assert.equal(migrated.size, 7);
        assert.equal(migrated.manifest.parts.length, 2);
        assert.notEqual(migrated.manifest.parts[0].telegram_message_id, 9100);
        assert.notEqual(migrated.manifest.parts[1].telegram_message_id, 9101);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM library_legacy_project_copies WHERE user_id=$1',
          ['free'])).rows[0].n, 2);
        const edited = { ...after.manifest, beats: [{ ...after.manifest.beats[0], name: 'Free old project edit' },
          ...after.manifest.beats.slice(1)] };
        await publish('free', edited, after.id);
        assert.equal(current('free').manifest.beats[0].project.manifest.parts.length, 2);
        assert.equal((await quota.usage('free')).used, 19);
      });

      await t.test('L: pin-before-commit crash retries the same INDEX and same beat slot', async () => {
        await service.reserve({ userId: 'other', beatId: 'retry-project' });
        const before = current('other');
        const candidate = { ...before.manifest, beats: [await attach('other', 'retry-project', 8300, 128)] };
        failAfterPin = true;
        await assert.rejects(publish('other', candidate, before.id), /simulated crash after pin/);
        assert.equal((await quota.usage('other')).used, 0);
        const pinnedAfterCrash = pins.get(before.chatId);
        const writesAfterCrash = writes;
        const retry = await publish('other', candidate, before.id);
        assert.equal(retry.messageId, pinnedAfterCrash);
        assert.equal(writes, writesAfterCrash);
        assert.equal((await quota.usage('other')).used, 1);
        const again = await publish('other', candidate, before.id);
        assert.equal(again.messageId, retry.messageId);
        assert.equal((await quota.usage('other')).used, 1);
      });
    } finally {
      if (pool) await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  });
