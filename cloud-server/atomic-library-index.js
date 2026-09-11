'use strict';

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

function installAtomicLibraryIndexBootstrap(express) {
  const application = express?.application;
  if (!application || application.__beatgalerAtomicIndexPatchInstalled) return;
  application.__beatgalerAtomicIndexPatchInstalled = true;
  const previousPost = application.post;
  application.post = function atomicIndexPatchedPost(routePath, ...handlers) {
    if (!this.__beatgalerAtomicIndexRouteInstalled) {
      this.__beatgalerAtomicIndexRouteInstalled = true;
      previousPost.call(this, '/transport/index/ensure', (_req, res) => {
        return res.status(410).json({ error: 'Create the library INDEX through the active Direct transport.', code: 'DIRECT_INDEX_REQUIRED' });
      });
    }
    return previousPost.call(this, routePath, ...handlers);
  };
}

module.exports = {
  positiveMessageId,
  createAtomicLibraryIndexCoordinator,
  installAtomicLibraryIndexBootstrap,
};
