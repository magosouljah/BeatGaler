'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { listMigrations, assertInitialSchemaContract } = require('../postgres-migrations.js');

const migrations = assertInitialSchemaContract();
assert(migrations.length >= 1);
assert.equal(migrations[0].version, '0001');
assert.match(migrations[0].checksumSha256, /^[0-9a-f]{64}$/);

const sql = migrations.map(item => item.sql).join('\n');

for (const token of [
  'REFERENCES users(id)',
  'REFERENCES vaults(id)',
  "plan_id IN ('free', 'paid_entry', 'highest_paid')",
  "status IN ('ACTIVE', 'RELEASING', 'RELEASED', 'EXPIRED')",
  "state IN ('pending', 'retrying', 'blocked', 'done')",
  'idempotency_key text NOT NULL UNIQUE',
  'manifest_sha256',
  'secret_key_version',
  'access_token_nonce',
  'refresh_token_nonce',
  'enforce_transport_bot_active_lease_cap',
  'active_count >= 4',
  'pg_advisory_xact_lock',
]) {
  assert(sql.includes(token), `missing PostgreSQL contract token: ${token}`);
}

for (const forbidden of ['CREATE TABLE beats', 'CREATE TABLE trash', 'CREATE TABLE deleted', 'bot_token text', 'telegram_api_hash text']) {
  assert(!sql.includes(forbidden), `forbidden PostgreSQL authority/secret token: ${forbidden}`);
}

const migrationDir = path.join(__dirname, '..', 'migrations');
for (const file of fs.readdirSync(migrationDir).filter(name => name.endsWith('.sql'))) {
  const contents = fs.readFileSync(path.join(migrationDir, file), 'utf8');
  assert.match(contents, /^\s*BEGIN;/i);
  assert.match(contents, /COMMIT;\s*$/i);
}

console.log(`PASS PostgreSQL schema contract: ${migrations.length} migration(s)`);
