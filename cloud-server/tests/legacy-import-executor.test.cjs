'use strict';

const assert = require('assert');
const { buildLegacyRows, importLegacyControlPlane } = require('../legacy-import-executor.js');
const { encryptSecretForStorage, decryptSecretFromStorage } = require('../secret-envelope.js');

const key = Buffer.alloc(32, 7);
const auth = {
  users: [{
    id: 'u1', username: 'producer', usernameSource: 'beatgaler', email: 'p@example.com',
    passwordSalt: '11'.repeat(16), passwordHash: '22'.repeat(64), createdAt: 1000,
    storageChatId: '-1001', storageChatTitle: 'vault', storageCreatedAt: 2000,
    mfaSecret: 'TOTPSECRET', pendingMfaSecret: 'MUST_NOT_MIGRATE',
    providers: { google: { id: 'google-1', accessToken: 'access-secret', refreshToken: 'refresh-secret', tokenExpiresAt: 999999 } },
    planState: { basePlanId: 'paid_entry', grants: [{ id: 'grant-1', planId: 'highest_paid', source: 'promo', startsAt: 100, expiresAt: 200 }] },
  }],
  sessions: { ['a'.repeat(64)]: { userId: 'u1', createdAt: 1000, expiresAt: 900000 } },
};

const rows = buildLegacyRows(auth);
assert.equal(rows.users[0].password_salt, '11'.repeat(16));
assert.equal(rows.users[0].username, 'producer');
assert.equal(rows.mfa.length, 1);
assert.equal(rows.mfa[0].plaintext_secret, 'TOTPSECRET');
assert(!JSON.stringify(rows).includes('MUST_NOT_MIGRATE'));
assert.equal(rows.entitlements.length, 2);
assert.equal(rows.vaults.length, 1);

const calls = [];
const client = {
  async query(sql, params = []) {
    calls.push({ sql: String(sql), params });
    return { rows: [] };
  },
};
const seal = (plaintext, { aad }) => encryptSecretForStorage(plaintext, { key, keyVersion: 3, aad });

(async () => {
  const counts = await importLegacyControlPlane(client, auth, { encryptSecretForStorage: seal });
  assert.equal(counts.users, 1);
  assert.equal(counts.sessions, 1);
  assert.equal(counts.providers, 1);
  assert.equal(counts.mfa, 1);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert(calls.some(call => call.sql.includes('ON CONFLICT(id) DO UPDATE')));
  assert(calls.some(call => call.sql.includes('ON CONFLICT(provider,provider_subject)')));

  const providerCall = calls.find(call => call.sql.includes('INSERT INTO provider_identities'));
  assert(Buffer.isBuffer(providerCall.params[4]));
  assert(Buffer.isBuffer(providerCall.params[5]));
  assert.equal(providerCall.params[8], 3);
  assert(!providerCall.params.some(value => value === 'access-secret' || value === 'refresh-secret'));
  assert.equal(decryptSecretFromStorage({ ciphertext: providerCall.params[4], nonce: providerCall.params[5], keyVersion: 3 }, {
    resolveKey: () => key, aad: 'provider:google:u1:access',
  }), 'access-secret');

  const bad = { query: async sql => { if (String(sql) === 'BEGIN') return { rows: [] }; throw new Error('db down'); } };
  const badCalls = [];
  bad.query = async sql => {
    badCalls.push(String(sql));
    if (String(sql) === 'BEGIN' || String(sql) === 'ROLLBACK') return { rows: [] };
    throw new Error('db down');
  };
  await assert.rejects(() => importLegacyControlPlane(bad, auth, { encryptSecretForStorage: seal }), /db down/);
  assert.equal(badCalls.at(-1), 'ROLLBACK');

  assert.throws(() => buildLegacyRows({ users: [{ id: 'x', passwordHash: 'hash' }], sessions: {} }), /missing passwordSalt/);
  console.log('PASS legacy import executor: auth compatibility, encrypted secrets, idempotent SQL, rollback');
})().catch(error => { console.error(error); process.exitCode = 1; });
