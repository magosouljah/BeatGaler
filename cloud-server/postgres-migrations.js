'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MIGRATION_NAME_RE = /^\d{4}_[a-z0-9_]+\.sql$/;

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

module.exports = {
  MIGRATIONS_DIR,
  listMigrations,
  assertInitialSchemaContract,
};
