'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');
const { buildLegacyRows } = require('../legacy-import-executor');
const { hashPassword, verifyPassword } = require('../password-kdf');
const { loadAuthSnapshot } = require('../postgres-control-plane-runtime');

test('auth migration retains the identity and password constraints in a transaction', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0002_auth_identity_compat.sql'), 'utf8');
  for (const token of [
    'ADD COLUMN IF NOT EXISTS username text',
    'ADD COLUMN IF NOT EXISTS username_source text',
    'ADD COLUMN IF NOT EXISTS password_salt text',
    'users_username_unique_idx',
    'users_password_material_check',
  ]) assert(migration.includes(token), `missing auth compatibility token: ${token}`);

  assert(migration.includes('password_hash IS NULL AND password_hash_algorithm IS NULL AND password_salt IS NULL'));
  assert(migration.includes('password_hash IS NOT NULL AND password_hash_algorithm IS NOT NULL AND password_salt IS NOT NULL'));
  assert.match(migration, /^\s*BEGIN;/i);
  assert.match(migration, /COMMIT;\s*$/i);
});

test('legacy auth rows round-trip username identity and scrypt password material', async () => {
  const password = 'round-trip test password';
  const legacyUser = {
    id: 'usr_password',
    username: 'legacy_handle',
    usernameSource: 'beatgaler',
    passwordSalt: '00112233445566778899aabbccddeeff',
  };
  legacyUser.passwordHash = await hashPassword(password, legacyUser.passwordSalt);
  const passwordlessUser = { id: 'usr_passwordless', username: 'provider_handle', usernameSource: 'x' };
  const rows = buildLegacyRows({ users: [legacyUser, passwordlessUser] }).users;
  assert.deepEqual(rows.map(row => [row.password_hash, row.password_hash_algorithm, row.password_salt]), [
    [legacyUser.passwordHash, 'scrypt-v1', legacyUser.passwordSalt],
    [null, null, null],
  ]);
  const tables = new Map([
    ['users', rows],
    ['auth_sessions', []],
    ['provider_identities', []],
    ['mfa_factors', []],
    ['entitlements', []],
    ['vaults', []],
  ]);
  const pool = {
    async query(sql) {
      const table = /^SELECT \* FROM (\w+)/.exec(sql)?.[1];
      assert(tables.has(table), `Unexpected auth snapshot query: ${sql}`);
      return { rows: tables.get(table) };
    },
  };

  const { users: [restored, passwordless], sessions } = await loadAuthSnapshot(pool, {
    key: Buffer.alloc(32, 1), keyVersion: 1,
  });
  assert.deepEqual(sessions, {});
  assert.equal(restored.id, legacyUser.id);
  assert.equal(restored.username, legacyUser.username);
  assert.equal(restored.usernameSource, legacyUser.usernameSource);
  assert.equal(restored.passwordHash, legacyUser.passwordHash);
  assert.equal(restored.passwordSalt, legacyUser.passwordSalt);
  assert.equal(await verifyPassword(password, restored), true);
  assert.equal(passwordless.id, passwordlessUser.id);
  assert.equal(passwordless.username, passwordlessUser.username);
  assert.equal(passwordless.usernameSource, passwordlessUser.usernameSource);
  assert.equal(Object.hasOwn(passwordless, 'passwordHash'), false);
  assert.equal(Object.hasOwn(passwordless, 'passwordSalt'), false);
});
