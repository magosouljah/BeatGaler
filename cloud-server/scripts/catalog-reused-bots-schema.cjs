#!/usr/bin/env node
'use strict';

// Owner-operated, one-shot DDL for migration 0042. The connected AWS tool
// intentionally does not receive or display the RDS administrator password.
// Secrets stay inside this process; no token rotation or Telegram I/O.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
const { migrationBody } = require('../postgres-migrations');

const apply = process.argv.slice(2).length === 1 && process.argv[2] === '--apply';
if (process.argv.length > 3 || (process.argv[2] && !apply)) {
  console.error('USAGE: node catalog-reused-bots-schema.cjs [--apply]');
  process.exit(2);
}

async function main() {
  if (execFileSync('systemctl', ['is-active', 'beatgaler-cloud.service'], { encoding: 'utf8' }).trim() !== 'active') {
    throw Error('STOP_CLOUD_NOT_ACTIVE');
  }
  const text = execFileSync('aws', [
    'secretsmanager', 'get-secret-value',
    '--region', 'us-east-2', '--secret-id', 'beatgaler/prod/postgres',
    '--query', 'SecretString', '--output', 'text',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 512000 });
  const secret = JSON.parse(text);
  if (secret.username !== 'galer_admin' || secret.host !== 'galer-cloud-prod.cvwoqa80k8h6.us-east-2.rds.amazonaws.com') {
    throw Error('STOP_UNEXPECTED_DATABASE_IDENTITY');
  }
  const url = new URL('postgresql://' + encodeURIComponent(secret.username)
    + '@' + secret.host + ':' + String(secret.port || 5432) + '/postgres');
  url.password = secret.password;
  const client = new Client({
    connectionString: url.toString(), application_name: 'beatgaler-owner-migration-0042',
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync('/home/ec2-user/rds-global-bundle.pem', 'utf8') },
    connectionTimeoutMillis: 10000,
  });
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '0042_catalog_reused_bots.sql'), 'utf8');
  const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['beatgaler:postgres-migrations:v1']);
    const role = await client.query('SELECT current_user');
    const versions = await client.query("SELECT version, checksum_sha256 FROM schema_migrations WHERE version IN ('0041','0042') ORDER BY version");
    const native = await client.query('SELECT (SELECT count(*) FROM catalog_native_activation)::int AS activations');
    if (role.rows[0].current_user !== 'galer_admin') throw Error('STOP_WRONG_DB_ROLE');
    if (!versions.rows.some(r => r.version === '0041')) throw Error('STOP_BASELINE_0041_MISSING');
    if (native.rows[0].activations !== 0) throw Error('STOP_ALREADY_NATIVE_ACTIVE');
    const current = versions.rows.find(r => r.version === '0042');
    if (current) {
      if (current.checksum_sha256 !== checksum) throw Error('STOP_0042_CHECKSUM_MISMATCH');
      await client.query('ROLLBACK');
      console.log('MIGRATION_0042_ALREADY_PRESENT');
      return;
    }
    if (!apply) {
      await client.query('ROLLBACK');
      console.log('MIGRATION_0042_READY_TO_APPLY');
      return;
    }
    await client.query(migrationBody(sql));
    await client.query('INSERT INTO schema_migrations(version,checksum_sha256) VALUES ($1,$2)', ['0042', checksum]);
    await client.query('COMMIT');
    console.log('MIGRATION_0042_APPLIED');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch(error => {
  console.error('MIGRATION_STOP:', error.code || error.message);
  process.exitCode = 1;
});
