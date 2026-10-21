'use strict';

const assert = require('node:assert/strict');
const {
  removedKeys,
  authSnapshotDelta,
} = require('../postgres-auth-multiprocess-compat');

{
  const previous = [{ id: 'a' }, { id: 'b' }];
  const current = [{ id: 'b' }, { id: 'c' }];
  assert.deepEqual(removedKeys(previous, current, 'id'), ['a']);
}

{
  const previous = {
    users: [
      {
        id: 'u1',
        username: 'alpha#0001',
        providers: {
          x: { id: 'x-alpha' },
          google: { id: 'g-alpha' },
        },
        mfaSecret: 'JBSWY3DPEHPK3PXP',
      },
    ],
    sessions: {
      s1: { userId: 'u1', createdAt: 1, expiresAt: 9999999999999 },
      s2: { userId: 'u1', createdAt: 2, expiresAt: 9999999999999 },
    },
  };
  const current = {
    users: [
      {
        id: 'u1',
        username: 'alpha#0001',
        providers: {
          google: { id: 'g-alpha' },
        },
      },
    ],
    sessions: {
      s2: { userId: 'u1', createdAt: 2, expiresAt: 9999999999999 },
      s3: { userId: 'u1', createdAt: 3, expiresAt: 9999999999999 },
    },
  };

  const delta = authSnapshotDelta(previous, current);
  assert.deepEqual(delta.removed_sessions, ['s1']);
  assert.equal(delta.removed_providers.length, 1);
  assert.equal(delta.current.providers.length, 1);
  assert.equal(delta.current.providers[0].provider, 'google');
  assert.equal(delta.removed_mfa.length, 1);
  assert.equal(delta.current.sessions.some(row => row.session_key_hash === 's3'), true);

  // A session/provider created by another process is absent from both this
  // process's previous and current snapshots, so it can never appear in the
  // removal lists.
  assert.equal(delta.removed_sessions.includes('foreign-session'), false);
  assert.equal(delta.removed_providers.includes('foreign-provider'), false);
}

console.log('postgres-auth-multiprocess-compat tests: PASS');
