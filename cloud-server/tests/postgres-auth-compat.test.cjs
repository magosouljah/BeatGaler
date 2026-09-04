'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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

console.log('PASS PostgreSQL auth compatibility: username identity and scrypt salt preserved');
