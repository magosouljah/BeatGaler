'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_NAME_RE = /^\d{4}_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK_KEY = 'beatgaler:postgres-migrations:v1';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function migrationChecksums(sql) {
  const lfSql = sql.replace(/\r\n/g, '\n');
  return {
    canonical: sha256(lfSql),
    crlf: sha256(lfSql.replace(/\n/g, '\r\n')),
  };
}

function listMigrations(dir = MIGRATIONS_DIR) {
  const names = fs.readdirSync(dir)
    .filter(name => name.endsWith('.sql'))
    .sort();

  for (const name of names) {
    if (!MIGRATION_NAME_RE.test(name)) {
      throw new Error(`Invalid PostgreSQL migration filename: ${name}`);
    }
  }

  const versions = new Set();
  return names.map(name => {
    const version = name.slice(0, 4);
    if (versions.has(version)) {
      throw new Error(`Duplicate PostgreSQL migration version: ${version}`);
    }
    versions.add(version);
    const filePath = path.join(dir, name);
    const sql = fs.readFileSync(filePath, 'utf8');
    if (!/^\s*BEGIN;/i.test(sql) || !/COMMIT;\s*$/i.test(sql)) {
      throw new Error(`Migration must be transaction-bounded: ${name}`);
    }
    return Object.freeze({
      version,
      name,
      path: filePath,
      sql,
      checksumSha256: migrationChecksums(sql).canonical,
    });
  });
}

function migrationBody(sql) {
  const withoutBegin = String(sql).replace(/^\s*BEGIN;\s*/i, '');
  const withoutCommit = withoutBegin.replace(/\s*COMMIT;\s*$/i, '');
  if (withoutCommit === withoutBegin) throw new Error('Migration is missing terminal COMMIT.');
  return withoutCommit.trim();
}

function assertInitialSchemaContract(migrations = listMigrations()) {
  if (migrations.length === 0) throw new Error('No PostgreSQL migrations found.');
  const sql = migrations.map(item => item.sql).join('\n');
  const requiredTables = [
    'schema_migrations', 'users', 'auth_sessions', 'provider_identities',
    'mfa_factors', 'entitlements', 'vaults', 'transport_bots', 'direct_leases',
    'direct_operations', 'index_observations', 'garbage_journal', 'jobs', 'audit_events',
  ];
  for (const table of requiredTables) {
    const re = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)?\\s+${table}\\b`, 'i');
    if (!re.test(sql)) throw new Error(`Missing required PostgreSQL table: ${table}`);
  }

  const forbidden = [
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?beats\b/i,
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?trash\b/i,
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?deleted\b/i,
    /bot_token\s+(?:text|varchar|bytea)/i,
    /telegram_api_hash\s+(?:text|varchar|bytea)/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(sql)) throw new Error(`Forbidden authority/secret pattern in PostgreSQL schema: ${pattern}`);
  }

  if (!/idempotency_key\s+text\s+NOT NULL\s+UNIQUE/i.test(sql)) {
    throw new Error('Garbage/operation idempotency constraint is missing.');
  }
  if (!/state\s+text\s+NOT NULL\s+CHECK\s*\(state IN \('pending', 'retrying', 'blocked', 'done'\)\)/i.test(sql)) {
    throw new Error('Garbage journal state constraint is missing.');
  }
  if (/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?catalog_/i.test(sql)) assertCatalogSchemaContract(sql);
  return migrations;
}

// T03: contrato del catálogo (CONTRATO C3 + T01-B). Solo se evalúa cuando existen tablas catalog_*.
// No relaja nada de lo anterior: los nombres catalog_* no eluden las prohibiciones de beats/trash/deleted.
const CATALOG_REQUIRED_TABLES = Object.freeze([
  'catalog_libraries', 'catalog_generations', 'catalog_beats', 'catalog_beat_tags', 'catalog_beat_tag_groups',
  'catalog_facets', 'catalog_trash_entries', 'catalog_tombstones', 'catalog_file_versions', 'catalog_file_parts',
  'catalog_media_objects', 'catalog_part_locations', 'catalog_current_files', 'catalog_legacy_fields',
  'catalog_query_sets', 'catalog_query_set_leases', 'catalog_query_members',
  // T05-N (0027_catalog_native.sql): tablas nativas; las guardas solo actúan con activación u origin NATIVE/RESET.
  'catalog_native_activation', 'catalog_library_chats', 'catalog_chat_rebinds', 'catalog_account_deletions',
  // T07 (0029_catalog_commands.sql): operaciones, eventos, lotes, selección.
  'catalog_operations', 'catalog_events', 'catalog_operation_batches', 'catalog_operation_batch_items', 'catalog_selections', 'catalog_selection_ops', 'catalog_selection_op_ids',
  // T09 (0030_catalog_transfer_operations.sql): intenciones de transferencia, partes con random_id, reservas y jobs con lease.
  'catalog_transfer_operations', 'catalog_operation_parts', 'catalog_reservations', 'catalog_jobs',
  // T12 (0031_catalog_transfer_capabilities.sql): capacidades de transferencia (solo hash) y journal de intentos por parte.
  'catalog_transfer_capabilities',
  // T14 (0032_catalog_playback.sql): rondas Shuffle persistidas (mapping disperso, consumidos, comandos idempotentes) y concesiones de medios.
  'catalog_playback_rounds', 'catalog_round_mapping', 'catalog_round_consumed', 'catalog_round_commands', 'catalog_media_grants',
  // T15 (0033_catalog_purge.sql): intenciones de purge, items por beat, manifiesto de objetos con journal y confirmación.
  'catalog_purges', 'catalog_purge_items', 'catalog_purge_objects',
  // T17 (0034_catalog_native_cli.sql): auditoría append-only de rebind-chat (vaults con o sin fila de catálogo).
  'catalog_vault_rebind_audit',
]);
// Guardas 0027 que el contrato exige presentes (NATIVO r2.1 §3.2, §5.1, §6, §7). No relajan nada de 0026.
const CATALOG_NATIVE_REQUIRED = Object.freeze([
  [/ALTER TABLE vaults ADD COLUMN catalog_native_eligible boolean NOT NULL DEFAULT false/i, 'vault native eligibility must default to false'],
  [/ALTER TABLE catalog_generations ADD COLUMN origin text NOT NULL DEFAULT 'LEGACY_IMPORT'\s+CHECK \(origin IN \('LEGACY_IMPORT', 'NATIVE', 'RESET'\)\)/i, 'generation origin must default to LEGACY_IMPORT'],
  [/CREATE TABLE control_plane_flush_quarantine \(/i, 'flush quarantine table is required'],
  [/CREATE TRIGGER vaults_catalog_native_eligible BEFORE INSERT ON vaults/i, 'vault eligibility trigger is required'],
  [/CREATE TRIGGER catalog_libraries_delete_guard BEFORE DELETE ON catalog_libraries/i, 'library delete guard is required'],
  [/CREATE TRIGGER vaults_catalog_rebind_guard BEFORE UPDATE OF telegram_chat_id, id, user_id ON vaults/i, 'vault rebind guard is required'],
  [/ERRCODE = 'BGL01'/, 'legacy write fence SQLSTATE is required'],
]);
// T06 (0028_catalog_queries.sql): perfil A1 ICU, proyecciones display/search NOT NULL e índices de tupla (C12-r4 §3–§4).
const CATALOG_QUERIES_REQUIRED = Object.freeze([
  [/CREATE COLLATION catalog_name_icu_und_v1 \(provider = icu, locale = 'und', deterministic = false\)/, 'name order profile must be ICU und, non-deterministic (A1)'],
  [/ALTER TABLE catalog_beats ALTER COLUMN name_display SET NOT NULL/, 'name_display projection must be NOT NULL'],
  [/ALTER TABLE catalog_beats ALTER COLUMN rating_display SET NOT NULL/, 'rating_display projection must be NOT NULL'],
  [/ALTER TABLE catalog_beat_tags ALTER COLUMN search_key SET NOT NULL/, 'tag search_key projection must be NOT NULL'],
  [/CREATE INDEX catalog_beats_order_name_idx ON catalog_beats\(user_id, generation_id, state, name_display COLLATE catalog_name_icu_und_v1, manual_rank, beat_id COLLATE "C"\)/, 'name order index must use the ICU profile and the full tuple'],
  [/CREATE INDEX catalog_beats_order_rating_idx/, 'rating order index is required'],
  [/CREATE INDEX catalog_beats_order_bpm_idx/, 'bpm order index is required'],
  [/CREATE INDEX catalog_beats_order_manual_idx/, 'manual order index is required'],
]);
function assertCatalogSchemaContract(sql) {
  for (const table of CATALOG_REQUIRED_TABLES) {
    if (!new RegExp(`CREATE TABLE\\s+${table}\\s*\\(`, 'i').test(sql)) throw new Error(`Missing required catalog table: ${table}`);
  }
  const required = [
    [/authority text NOT NULL DEFAULT 'LEGACY' CHECK \(authority IN \('LEGACY', 'POSTGRES'\)\)/i, 'catalog libraries must default to LEGACY authority'],
    [/cleanup_enabled boolean NOT NULL DEFAULT false/i, 'catalog cleanup must default to disabled'],
    [/CHECK \(NOT cleanup_enabled OR authority = 'POSTGRES'\)/i, 'catalog cleanup must be impossible under LEGACY'],
    [/restore_hold boolean NOT NULL DEFAULT true/i, 'catalog restore hold must default to true'],
    [/legacy_json text NOT NULL/i, 'catalog legacy_json must be TEXT'],
    [/value_json text NOT NULL/i, 'catalog legacy fields must be TEXT'],
    [/raw_index bytea/i, 'catalog raw INDEX must be bytea'],
    [/FOREIGN KEY \(user_id, vault_id\) REFERENCES vaults\(user_id, id\)/i, 'catalog library must reference its vault by (user_id, id)'],
    [/FOREIGN KEY \(user_id, active_generation_id, active_generation_status\)\s+REFERENCES catalog_generations\(user_id, generation_id, status\)/i, 'catalog active generation must belong to the same user and be ACTIVE'],
  ];
  for (const [pattern, message] of required) if (!pattern.test(sql)) throw new Error(`Catalog schema contract: ${message}.`);
  const forbidden = [
    /legacy_json\s+jsonb/i, /value_json\s+jsonb/i, /wrapper_json\s+jsonb/i, /original_json\s+jsonb/i, /raw_index\s+jsonb/i,
    /descriptor_json\s+jsonb/i, /predicate_json\s+jsonb/i, /CREATE\s+TABLE\s+catalog_\w*\s*\([^;]*\bdata\s+jsonb/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(sql)) throw new Error(`Forbidden catalog legacy storage pattern (TEXT required, D-08): ${pattern}`);
  }
  if (/CREATE COLLATION catalog_name_icu_und_v1/i.test(sql)) {
    for (const [pattern, message] of CATALOG_QUERIES_REQUIRED) if (!pattern.test(sql)) throw new Error(`Catalog queries schema contract: ${message}.`);
    if (/CREATE COLLATION[^;]*provider\s*=\s*libc/i.test(sql)) throw new Error('Catalog queries schema contract: libc collations are not an A1 substitute.');
  }
  if (/CREATE TABLE catalog_transfer_operations \(/i.test(sql)) {
    for (const [pattern, message] of [
      [/random_id text NOT NULL CHECK \(random_id ~ '\^-\?\[0-9\]\{1,19\}\$'\)/, 'random_id must be a signed 64-bit integer stored as text'],
      [/UNIQUE \(sender_id, random_id\)/, 'random_id must be unique per sender'],
      [/CREATE TRIGGER catalog_transfer_operations_transition BEFORE UPDATE ON catalog_transfer_operations/, 'transfer operation transition trigger is required'],
      [/CREATE TABLE catalog_reservations \(/, 'reservations table is required'],
      [/CREATE TABLE catalog_jobs \(/, 'jobs table is required'],
      [/lease_generation bigint NOT NULL DEFAULT 0/, 'job lease generation is required'],
    ]) if (!pattern.test(sql)) throw new Error(`Catalog transfer schema contract: ${message}.`);
    if (/CREATE TABLE catalog_(?:transfer_operations|operation_parts|reservations|jobs) \([^;]*\bjsonb\b/i.test(sql)) throw new Error('Catalog transfer schema contract: no jsonb (D-08).');
  }
  if (/CREATE TABLE catalog_operations \(/i.test(sql)) {
    for (const [pattern, message] of [
      [/UNIQUE \(user_id, idempotency_key\)/, 'operations must be idempotent per user and key'],
      [/CREATE TRIGGER catalog_operations_transition BEFORE UPDATE ON catalog_operations/, 'operation transition trigger is required'],
      [/CREATE TABLE catalog_events \(/, 'durable events table is required'],
      [/item_count integer NOT NULL CHECK \(item_count BETWEEN 0 AND 50\)/, 'batches are limited to 50 items'],
      [/selection_version bigint NOT NULL DEFAULT 0/, 'selection CAS version is required'],
    ]) if (!pattern.test(sql)) throw new Error(`Catalog commands schema contract: ${message}.`);
    if (/CREATE TABLE catalog_(?:operations|events|operation_batches|operation_batch_items|selections|selection_ops|selection_op_ids) \([^;]*\bjsonb\b/i.test(sql)) throw new Error('Catalog commands schema contract: no jsonb (D-08).');
  }
  if (/CREATE TABLE catalog_native_activation/i.test(sql)) {
    for (const [pattern, message] of CATALOG_NATIVE_REQUIRED) if (!pattern.test(sql)) throw new Error(`Catalog native schema contract: ${message}.`);
    if (/CREATE TABLE (?:catalog_native_activation|catalog_library_chats|catalog_chat_rebinds|catalog_account_deletions|control_plane_flush_quarantine) \([^;]*\bjsonb\b/i.test(sql)) {
      throw new Error('Catalog native schema contract: native tables must not use jsonb (D-08).');
    }
  }
}

async function ensureMigrationLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applyMigrations(pool, migrations = listMigrations()) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('PostgreSQL pool with connect() is required.');
  const client = await pool.connect();
  const applied = [];
  const skipped = [];
  let locked = false;
  try {
    // Serialize the very first bootstrap too. CREATE TABLE IF NOT EXISTS is not
    // sufficient when two fresh server instances concurrently create the same
    // relation/type in PostgreSQL's catalogs.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    locked = true;
    await ensureMigrationLedger(client);

    for (const migration of migrations) {
      const checksums = migrationChecksums(migration.sql);
      const existing = await client.query(
        'SELECT checksum_sha256 FROM schema_migrations WHERE version = $1',
        [migration.version],
      );
      if (existing.rows.length) {
        if (existing.rows[0].checksum_sha256 !== checksums.canonical
          && existing.rows[0].checksum_sha256 !== checksums.crlf) {
          throw new Error(`Applied migration ${migration.version} checksum mismatch.`);
        }
        skipped.push(migration.version);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(migrationBody(migration.sql));
        await client.query(
          'INSERT INTO schema_migrations(version, checksum_sha256) VALUES ($1, $2)',
          [migration.version, checksums.canonical],
        );
        await client.query('COMMIT');
        applied.push(migration.version);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    return Object.freeze({ applied, skipped });
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

// T16 (NATIVO r2.1 §11): un binario más viejo que la DB no arranca. Si schema_migrations contiene versiones que este código no conoce,
// se lanza CATALOG_SCHEMA_AHEAD y el arranque se niega (fail-closed). No modifica la DB.
async function assertKnownMigrations(pool, migrations = listMigrations()) {
  if (!pool || typeof pool.query !== 'function') throw new Error('PostgreSQL pool with query() is required.');
  const known = new Set(migrations.map((m) => m.version));
  const rows = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows;
  const unknown = rows.map((r) => String(r.version)).filter((v) => !known.has(v));
  if (unknown.length) {
    const error = new Error(`CATALOG_SCHEMA_AHEAD: the database has migrations this binary does not know (${unknown.join(', ')}); refusing to start with an older binary.`);
    error.code = 'CATALOG_SCHEMA_AHEAD'; error.unknown = unknown;
    throw error;
  }
  return Object.freeze({ known: known.size, applied: rows.length, unknown: [] });
}

module.exports = {
  assertKnownMigrations,
  MIGRATIONS_DIR,
  MIGRATION_LOCK_KEY,
  listMigrations,
  migrationBody,
  assertInitialSchemaContract,
  assertCatalogSchemaContract,
  CATALOG_REQUIRED_TABLES,
  CATALOG_NATIVE_REQUIRED,
  applyMigrations,
};
