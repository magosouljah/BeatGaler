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

module.exports = {
  MIGRATIONS_DIR,
  MIGRATION_LOCK_KEY,
  listMigrations,
  migrationBody,
  assertInitialSchemaContract,
  assertCatalogSchemaContract,
  CATALOG_REQUIRED_TABLES,
  applyMigrations,
};
