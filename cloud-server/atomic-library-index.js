'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const directTransport = require('./direct-transport-control');

const EMPTY_LIBRARY_INDEX = Object.freeze({
  schema: 'beatgaler.telegram.library',
  version: 2,
  beats: [],
  trash: [],
  deleted: [],
});
const INDEX_CAPTION = 'BEATGALER_LIBRARY_INDEX_V1';

function positiveMessageId(value) {
  const id = Number(value || 0);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function createAtomicLibraryIndexCoordinator({ pool, getPointer, createIndex, recordPointer, deleteIndex }) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL is required for atomic library-index bootstrap.');
  for (const [name, fn] of Object.entries({ getPointer, createIndex, recordPointer, deleteIndex })) {
    if (typeof fn !== 'function') throw new Error(`${name} is required for atomic library-index bootstrap.`);
  }

  return Object.freeze({
    async ensure(vaultId) {
      const vault = String(vaultId || '').trim();
      if (!vault) throw new Error('vaultId is required for atomic library-index bootstrap.');
      const client = await pool.connect();
      let locked = false;
      const lockName = `beatgaler:library-index:${vault}`;
      try {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
        locked = true;

        const before = await getPointer(vault);
        const existingId = positiveMessageId(before?.message_id ?? before?.messageId);
        if (existingId) return Object.freeze({ status: 'existing', messageId: existingId });

        const created = await createIndex(vault);
        const createdId = positiveMessageId(created?.messageId ?? created?.message_id);
        if (!createdId) throw new Error('Index provider returned no valid message id.');

        try {
          await recordPointer(vault, createdId);
          const winner = await getPointer(vault);
          const winnerId = positiveMessageId(winner?.message_id ?? winner?.messageId);
          if (winnerId !== createdId) throw new Error('Atomic index winner could not be verified.');
          return Object.freeze({ status: 'created', messageId: createdId });
        } catch (error) {
          await deleteIndex(vault, createdId).catch(() => {});
          throw error;
        }
      } finally {
        if (locked) {
          try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]); } catch (_) {}
        }
        client.release();
      }
    },
  });
}

function linkedVaultId(dataDir, installationId) {
  const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'cloud-data.json'), 'utf8'));
  const account = parsed?.linkedAccounts?.[String(installationId)] || null;
  const vault = String(account?.storageChatId || '').trim();
  if (!vault) throw new Error('BeatGaler private storage is not provisioned for this account.');
  return vault;
}

async function createEmptyProviderIndex(vaultId, direct = directTransport) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-index-'));
  const filePath = path.join(dir, `beatgaler-library-${crypto.randomBytes(6).toString('hex')}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(EMPTY_LIBRARY_INDEX), 'utf8');
    return await direct.commitIndexCopyOnWrite({
      chatId: vaultId,
      filePath,
      caption: INDEX_CAPTION,
      previousMessageId: 0,
    });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

function installAtomicLibraryIndexBootstrap(express, { pool, dataDir = __dirname, direct = directTransport } = {}) {
  const application = express?.application;
  if (!application || application.__beatgalerAtomicIndexPatchInstalled) return;
  application.__beatgalerAtomicIndexPatchInstalled = true;
  const previousPost = application.post;
  let coordinator = null;
  if (pool) {
    coordinator = createAtomicLibraryIndexCoordinator({
      pool,
      getPointer: vaultId => direct.getIndexPointer(vaultId),
      createIndex: vaultId => createEmptyProviderIndex(vaultId, direct),
      recordPointer: async (vaultId, messageId) => { direct.recordIndexPointer(vaultId, { messageId, fileId: '' }); },
      deleteIndex: async (vaultId, messageId) => { await direct.deleteMessages(vaultId, [messageId]); },
    });
  }

  application.post = function atomicIndexPatchedPost(routePath, ...handlers) {
    if (!this.__beatgalerAtomicIndexRouteInstalled) {
      this.__beatgalerAtomicIndexRouteInstalled = true;
      previousPost.call(this, '/transport/index/ensure', async (req, res) => {
        const installationId = String(req.body?.beatgalerUserId || '').trim();
        const authorizedInstallation = String(req.beatgalerAuthorizedInstallationId || installationId).trim();
        if (!installationId || !authorizedInstallation || installationId !== authorizedInstallation) {
          return res.status(403).json({ error: 'Atomic library-index bootstrap requires the authenticated installation.' });
        }
        if (!coordinator) {
          return res.status(503).json({ error: 'Atomic library-index bootstrap requires PostgreSQL authority.' });
        }
        try {
          const vaultId = linkedVaultId(dataDir, installationId);
          const result = await coordinator.ensure(vaultId);
          return res.json({ ok: true, status: result.status, message_id: result.messageId, manifest: EMPTY_LIBRARY_INDEX });
        } catch (error) {
          console.error('[index] atomic bootstrap failed:', error?.message || error);
          return res.status(503).json({ error: 'Atomic library-index bootstrap could not be committed.' });
        }
      });
    }
    return previousPost.call(this, routePath, ...handlers);
  };
}

module.exports = {
  EMPTY_LIBRARY_INDEX,
  INDEX_CAPTION,
  positiveMessageId,
  createAtomicLibraryIndexCoordinator,
  createEmptyProviderIndex,
  installAtomicLibraryIndexBootstrap,
};
