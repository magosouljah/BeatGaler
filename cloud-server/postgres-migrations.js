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
      checksumSha256: sha256(sql),
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
  return migrations;
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
      const existing = await client.query(
        'SELECT checksum_sha256 FROM schema_migrations WHERE version = $1',
        [migration.version],
      );
      if (existing.rows.length) {
        if (existing.rows[0].checksum_sha256 !== migration.checksumSha256) {
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
          [migration.version, migration.checksumSha256],
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
  applyMigrations,
};
