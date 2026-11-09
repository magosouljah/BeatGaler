'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { listMigrations, assertInitialSchemaContract } = require('../postgres-migrations.js');

const migrations = assertInitialSchemaContract();
assert(migrations.length >= 1);
assert.equal(migrations[0].version, '0001');
assert.match(migrations[0].checksumSha256, /^[0-9a-f]{64}$/);
const persistentAssignmentMigration = migrations.find(item => item.version === '0010' && item.name === '0010_persistent_transport_assignment.sql');
assert(persistentAssignmentMigration, 'persistent transport assignment migration 0010 is required');
assert(persistentAssignmentMigration.sql.includes('DROP TRIGGER IF EXISTS direct_leases_active_cap_trigger ON direct_leases'), 'migration 0010 must retire the old direct lease cap trigger');
assert(persistentAssignmentMigration.sql.includes('DROP FUNCTION IF EXISTS enforce_transport_bot_active_lease_cap()'), 'migration 0010 must retire the old direct lease cap function');
const emailVerificationMigration = migrations.find(item => item.name === '0024_user_email_verifications.sql');
assert(emailVerificationMigration, 'durable email verification migration is required');
assert.match(emailVerificationMigration.sql, /user_id text PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE/i);
assert.match(emailVerificationMigration.sql, /email_hash text NOT NULL/i);
assert.match(emailVerificationMigration.sql, /verified_at timestamptz NOT NULL/i);
assert.match(emailVerificationMigration.sql, /AFTER UPDATE OF email ON users/i);

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
  'pg_advisory_xact_lock',
  'transport_bot_id text REFERENCES transport_bots(id)',
  "transport_membership_state text NOT NULL DEFAULT 'pending'",
  "transport_membership_state IN ('pending', 'ready', 'repair')",
  'transport_membership_updated_at timestamptz',
  'vaults_transport_bot_id_idx',
  'index_bootstrap_pending boolean NOT NULL DEFAULT false',
]) {
  assert(sql.includes(token), `missing PostgreSQL contract token: ${token}`);
}

for (const forbidden of ['CREATE TABLE beats', 'CREATE TABLE trash', 'CREATE TABLE deleted', 'bot_token text', 'telegram_api_hash text']) {
  assert(!sql.includes(forbidden), `forbidden PostgreSQL authority/secret token: ${forbidden}`);
}

// T03: contrato del catálogo (C3 + T01-B) reconocido explícitamente.
const catalogMigration = migrations.find(item => item.name === '0026_catalog_core.sql');
assert(catalogMigration, 'catalog core migration 0026 is required');
for (const token of [
  'ALTER TABLE vaults ADD CONSTRAINT vaults_user_id_id_key UNIQUE (user_id, id)',
  "authority text NOT NULL DEFAULT 'LEGACY'",
  'cleanup_enabled boolean NOT NULL DEFAULT false',
  'legacy_json text NOT NULL',
  'value_json text NOT NULL',
  'raw_index bytea',
  "CHECK (legacy_sha256 = encode(sha256(convert_to(legacy_json, 'UTF8')), 'hex'))",
]) {
  assert(catalogMigration.sql.includes(token), `missing catalog contract token: ${token}`);
}
assert(!/\bjsonb\b/i.test(catalogMigration.sql), 'catalog core migration must not use jsonb (D-08)');

// T05-N: 0027 aditiva y condicionada (NATIVO r2.1 §3.2, §5.1 capa 0, §6, §7). 0026 no cambia (checksum del runner).
const nativeMigration = migrations.find(item => item.name === '0027_catalog_native.sql');
assert(nativeMigration, 'catalog native migration 0027 is required');
for (const token of [
  'CREATE TABLE catalog_native_activation (',
  'ALTER TABLE vaults ADD COLUMN catalog_native_eligible boolean NOT NULL DEFAULT false',
  "ALTER TABLE catalog_generations ADD COLUMN origin text NOT NULL DEFAULT 'LEGACY_IMPORT'",
  'CREATE TABLE catalog_library_chats (',
  'CREATE TABLE catalog_chat_rebinds (',
  'CREATE TABLE catalog_account_deletions (',
  'CREATE TABLE control_plane_flush_quarantine (',
  'CREATE TRIGGER vaults_catalog_native_eligible BEFORE INSERT ON vaults',
  'CREATE TRIGGER catalog_libraries_delete_guard BEFORE DELETE ON catalog_libraries',
  'CREATE TRIGGER vaults_catalog_rebind_guard BEFORE UPDATE OF telegram_chat_id, id, user_id ON vaults',
  "current_setting('beatgaler.account_deletion_id', true)",
  "ERRCODE = 'BGL01'",
]) {
  assert(nativeMigration.sql.includes(token), `missing catalog native contract token: ${token}`);
}
assert(!/\bjsonb\b/i.test(nativeMigration.sql), 'catalog native migration must not use jsonb (D-08)');
assert(!/ALTER TABLE catalog_\w+ (DROP|ALTER COLUMN)/i.test(nativeMigration.sql), '0027 must be additive: no DROP or ALTER COLUMN on 0026 tables');
assert(!/DROP TABLE|DROP TRIGGER|DROP FUNCTION/i.test(nativeMigration.sql), '0027 must not drop anything');

// T06: 0028 aditiva (colación ICU A1, proyecciones display/search, índices de tupla). Solo ALTER COLUMN ... SET NOT NULL sobre columnas que ella misma añade.
const queriesMigration = migrations.find(item => item.name === '0028_catalog_queries.sql');
assert(queriesMigration, 'catalog queries migration 0028 is required');
for (const token of [
  "CREATE COLLATION catalog_name_icu_und_v1 (provider = icu, locale = 'und', deterministic = false)",
  'ALTER TABLE catalog_beats ADD COLUMN name_display text',
  'ALTER TABLE catalog_beats ADD COLUMN name_search text',
  'ALTER TABLE catalog_beats ADD COLUMN bpm_display text',
  'ALTER TABLE catalog_beats ADD COLUMN rating_display smallint',
  'ALTER TABLE catalog_beat_tags ADD COLUMN search_key text',
  'CREATE INDEX catalog_beats_order_manual_idx',
  'CREATE INDEX catalog_beats_order_rating_idx',
  'CREATE INDEX catalog_beats_order_name_idx',
  'CREATE INDEX catalog_beats_order_bpm_idx',
  'CREATE INDEX catalog_facets_order_idx',
]) {
  assert(queriesMigration.sql.includes(token), `missing catalog queries contract token: ${token}`);
}
assert(!/\bjsonb\b/i.test(queriesMigration.sql), 'catalog queries migration must not use jsonb (D-08)');
assert(!/DROP TABLE|DROP TRIGGER|DROP FUNCTION|DROP COLUMN|DROP INDEX|DROP COLLATION/i.test(queriesMigration.sql), '0028 must not drop anything');
for (const m of queriesMigration.sql.matchAll(/ALTER TABLE (\w+) ALTER COLUMN (\w+) SET NOT NULL/g)) {
  assert(queriesMigration.sql.includes(`ALTER TABLE ${m[1]} ADD COLUMN ${m[2]} `), `0028 may only SET NOT NULL on columns it adds: ${m[1]}.${m[2]}`);
}
assert(!/ALTER TABLE \w+ ALTER COLUMN \w+ (TYPE|DROP|SET DEFAULT)/i.test(queriesMigration.sql), '0028 must not retype or default existing columns');
assert(!/provider\s*=\s*libc/i.test(queriesMigration.sql), '0028 must not substitute A1 with a libc collation');

const migrationDir = path.join(__dirname, '..', 'migrations');
for (const file of fs.readdirSync(migrationDir).filter(name => name.endsWith('.sql'))) {
  const contents = fs.readFileSync(path.join(migrationDir, file), 'utf8');
  assert.match(contents, /^\s*BEGIN;/i);
  assert.match(contents, /COMMIT;\s*$/i);
}

console.log(`PASS PostgreSQL schema contract: ${migrations.length} migration(s)`);

// T07: 0029 aditiva (operaciones, eventos, lotes <=50, seleccion CAS). Solo TEXT para JSON.
const commandsMigration = migrations.find(item => item.name === '0029_catalog_commands.sql');
assert(commandsMigration, 'catalog commands migration 0029 is required');
for (const token of ['CREATE TABLE catalog_operations (', 'UNIQUE (user_id, idempotency_key)', 'CREATE TABLE catalog_events (', 'CREATE TABLE catalog_operation_batches (', 'item_count integer NOT NULL CHECK (item_count BETWEEN 0 AND 50)', 'CREATE TABLE catalog_operation_batch_items (', 'CREATE TABLE catalog_selections (', 'selection_version bigint NOT NULL DEFAULT 0', 'CREATE TABLE catalog_selection_ops (', 'CREATE TABLE catalog_selection_op_ids (', 'CREATE TRIGGER catalog_operations_transition BEFORE UPDATE ON catalog_operations']) {
  assert(commandsMigration.sql.includes(token), `missing catalog commands contract token: ${token}`);
}
assert(!/[j]sonb/i.test(commandsMigration.sql), 'catalog commands migration must not use jsonb (D-08)');
assert(!/ALTER TABLE|DROP /i.test(commandsMigration.sql), '0029 only creates new objects');
