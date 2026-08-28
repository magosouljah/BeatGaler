'use strict';

const assert = require('node:assert/strict');
const {
  installationClaimLockKey,
  createPostgresInstallationClaimCoordinator,
} = require('../postgres-installation-claim-coordinator');

function fakePool() {
  const locks = new Set();
  const calls = [];
  return {
    calls,
    async connect() {
      let released = false;
      return {
        async query(sql, params) {
          calls.push({ sql, params: [...params] });
          const key = params.join(':');
          if (sql.includes('pg_try_advisory_lock')) {
            if (locks.has(key)) return { rows: [{ locked: false }] };
            locks.add(key);
            return { rows: [{ locked: true }] };
          }
          if (sql.includes('pg_advisory_unlock')) {
            const unlocked = locks.delete(key);
            return { rows: [{ unlocked }] };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
        release(error) {
          if (released && !error) throw new Error('client released twice');
          released = true;
        },
      };
    },
  };
}

(async () => {
  assert.deepEqual(installationClaimLockKey('install_a'), installationClaimLockKey('install_a'));
  assert.notDeepEqual(installationClaimLockKey('install_a'), installationClaimLockKey('install_b'));

  const pool = fakePool();
  const processA = createPostgresInstallationClaimCoordinator(pool);
  const processB = createPostgresInstallationClaimCoordinator(pool);

  const releaseA = await processA.tryAcquire('shared-installation');
  assert.equal(typeof releaseA, 'function', 'first process must acquire the installation claim');

  const blockedB = await processB.tryAcquire('shared-installation');
  assert.equal(blockedB, null, 'second coordinator must be denied while the same advisory lock is held');

  const releaseOther = await processB.tryAcquire('different-installation');
  assert.equal(typeof releaseOther, 'function', 'different installation claims may proceed concurrently');
  await releaseOther();

  await releaseA();
  const releaseBAfter = await processB.tryAcquire('shared-installation');
  assert.equal(typeof releaseBAfter, 'function', 'claim must become available after explicit release');
  await releaseBAfter();

  assert.ok(pool.calls.some(call => call.sql.includes('pg_try_advisory_lock')));
  assert.ok(pool.calls.some(call => call.sql.includes('pg_advisory_unlock')));
  console.log('PASS PostgreSQL installation claim coordinator semantics');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
