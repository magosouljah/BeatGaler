'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createPostgresPool } = require('../postgres-runtime-config');
const { emailHash, normalizeEmail } = require('../email-verification-authority');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

function legacyEntries(state) {
  const records = state?.email_verified;
  return records && typeof records === 'object' && !Array.isArray(records)
    ? Object.entries(records)
    : [];
}

async function importLegacyEmailVerifications(pool, state, { dryRun = false } = {}) {
  if (!pool?.connect) throw new Error('POSTGRES_REQUIRED');
  const entries = legacyEntries(state);
  const tombstones = state?.tombstones && typeof state.tombstones === 'object' ? state.tombstones : {};
  const report = {
    LEGACY_ROWS_FOUND: entries.length,
    MATCHED: 0,
    IMPORTED: 0,
    SKIPPED_MISMATCH: 0,
    SKIPPED_MISSING_USER: 0,
  };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [userId, legacy] of entries) {
      if (Object.hasOwn(tombstones, userId)) {
        report.SKIPPED_MISSING_USER += 1;
        continue;
      }
      const result = await client.query(
        dryRun ? 'SELECT email FROM users WHERE id=$1' : 'SELECT email FROM users WHERE id=$1 FOR UPDATE',
        [userId],
      );
      const currentEmail = normalizeEmail(result.rows[0]?.email);
      if (result.rows.length !== 1 || !currentEmail) {
        report.SKIPPED_MISSING_USER += 1;
        continue;
      }
      const verifiedAt = new Date(legacy?.verified_at);
      if (typeof legacy?.verified_at !== 'string' || !legacy.verified_at.trim()
        || legacy.email_hash !== emailHash(currentEmail) || !Number.isFinite(verifiedAt.getTime())) {
        report.SKIPPED_MISMATCH += 1;
        continue;
      }
      report.MATCHED += 1;
      if (!dryRun) {
        const imported = await client.query(`
          INSERT INTO user_email_verifications(user_id,email_hash,verified_at)
          VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING
        `, [userId, legacy.email_hash, verifiedAt]);
        report.IMPORTED += Number(imported.rowCount || 0);
      }
    }
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main(args = process.argv.slice(2)) {
  let dryRun = false;
  let stateFile = process.env.BEATGALER_ACCOUNT_LIFECYCLE_STATE_FILE
    || path.resolve(__dirname, '../account-lifecycle-state.json');
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--dry-run') dryRun = true;
    else if (args[index] === '--state-file' && args[index + 1]) stateFile = args[++index];
    else throw new Error('INVALID_ARGUMENT');
  }
  const state = JSON.parse(fs.readFileSync(path.resolve(stateFile), 'utf8'));
  const pool = createPostgresPool(Pool, process.env);
  if (!pool) throw new Error('POSTGRES_REQUIRED');
  try {
    const report = await importLegacyEmailVerifications(pool, state, { dryRun });
    process.stdout.write(`${JSON.stringify({ ...report, DRY_RUN: dryRun })}\n`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    const code = ['INVALID_ARGUMENT', 'POSTGRES_REQUIRED'].includes(error?.message)
      ? error.message : 'LEGACY_EMAIL_IMPORT_FAILED';
    process.stderr.write(`${JSON.stringify({ code })}\n`);
    process.exitCode = 1;
  });
}

module.exports = { legacyEntries, importLegacyEmailVerifications, main };
