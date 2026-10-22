'use strict';

const assert = require('node:assert/strict');
const {
  removedKeys,
  authSnapshotDelta,
  mergeAuthSnapshotDelta,
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

// A stale process adding a session must not restore an email or provider that
// another process changed directly in PostgreSQL after this snapshot loaded.
(async () => {
  const original = {
    users: [{ id: 'u1', username: 'alpha#0001', email: 'old@example.com',
      providers: { x: { id: 'x-alpha' } } }],
    sessions: {},
  };
  const current = JSON.parse(JSON.stringify(original));
  current.sessions[`${'a'.repeat(64)}`] = { userId: 'u1', createdAt: 1, expiresAt: 9999999999999 };
  const statements = [];
  const client = { async query(sql) { statements.push(String(sql)); return { rows: [], rowCount: 0 }; }, release() {} };
  await mergeAuthSnapshotDelta({ async connect() { return client; } }, current,
    { key: Buffer.alloc(32, 7), keyVersion: 1 }, original);
  assert.equal(statements.some(sql => /(?:INSERT INTO|UPDATE) users\b/.test(sql)), false);
  assert.equal(statements.some(sql => /INSERT INTO provider_identities\b/.test(sql)), false);
  assert.equal(statements.some(sql => /INSERT INTO auth_sessions\b/.test(sql)), true);
  const adopted = {
    users: [...current.users, { id: 'u2', username: 'newhandle', usernameSource: 'x',
      providers: { x: { id: 'x-new' } } }],
    sessions: current.sessions,
  };
  statements.length = 0;
  await mergeAuthSnapshotDelta({ async connect() { return client; } }, adopted,
    { key: Buffer.alloc(32, 7), keyVersion: 1 }, current);
  assert.equal(statements.some(sql => /INSERT INTO users\b[\s\S]*ON CONFLICT\(id\) DO NOTHING/.test(sql)), true);
  console.log('postgres-auth-multiprocess-compat tests: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
