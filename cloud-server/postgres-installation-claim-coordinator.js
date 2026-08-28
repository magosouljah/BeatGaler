'use strict';

const crypto = require('crypto');

function installationClaimLockKey(installationId) {
  const id = String(installationId || '').trim();
  if (!id) throw new Error('installationId is required for authorization claim locking.');
  const digest = crypto.createHash('sha256').update(`beatgaler:installation-claim:${id}`).digest();
  return Object.freeze([digest.readInt32BE(0), digest.readInt32BE(4)]);
}

function createPostgresInstallationClaimCoordinator(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('A PostgreSQL pool is required for cross-process installation claim coordination.');
  }

  return Object.freeze({
    async tryAcquire(installationId) {
      const [keyA, keyB] = installationClaimLockKey(installationId);
      const client = await pool.connect();
      let locked = false;
      try {
        const result = await client.query(
          'SELECT pg_try_advisory_lock($1::integer,$2::integer) AS locked',
          [keyA, keyB],
        );
        locked = result.rows?.[0]?.locked === true;
        if (!locked) {
          client.release();
          return null;
        }

        let released = false;
        return async function releaseInstallationClaim() {
          if (released) return;
          released = true;
          try {
            const unlock = await client.query(
              'SELECT pg_advisory_unlock($1::integer,$2::integer) AS unlocked',
              [keyA, keyB],
            );
            if (unlock.rows?.[0]?.unlocked !== true) {
              throw new Error('PostgreSQL installation claim advisory lock was not held at release.');
            }
            client.release();
          } catch (error) {
            try { client.release(error); } catch (_) {}
            throw error;
          }
        };
      } catch (error) {
        if (!locked) {
          try { client.release(error); } catch (_) {}
        }
        throw error;
      }
    },
  });
}

module.exports = {
  installationClaimLockKey,
  createPostgresInstallationClaimCoordinator,
};
