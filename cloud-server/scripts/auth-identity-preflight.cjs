'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { createPostgresPool } = require('../postgres-runtime-config');
const { analyzeIdentityPreflight } = require('../auth-identity-preflight');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

function readLifecycleState(file) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) {
    const error = new Error(`Lifecycle state is required for auth identity preflight: ${resolved}`);
    error.code = 'AUTH_IDENTITY_PREFLIGHT_STATE_REQUIRED';
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (cause) {
    const error = new Error(`Lifecycle state could not be parsed: ${resolved}`);
    error.code = 'AUTH_IDENTITY_PREFLIGHT_STATE_INVALID';
    error.cause = cause;
    throw error;
  }
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function loadIdentityRows(pool) {
  const [usersResult, providersResult] = await Promise.all([
    pool.query(`
      SELECT
        u.id,
        u.email,
        u.username,
        CASE WHEN u.password_hash IS NULL THEN NULL ELSE 'present' END AS password_hash,
        v.email_hash AS verified_email_hash
      FROM users u
      LEFT JOIN user_email_verifications v ON v.user_id=u.id
      ORDER BY u.id
    `),
    pool.query(`
      SELECT
        id,
        user_id,
        provider,
        provider_subject,
        CASE WHEN access_token_ciphertext IS NULL THEN NULL ELSE true END AS access_token_ciphertext,
        CASE WHEN refresh_token_ciphertext IS NULL THEN NULL ELSE true END AS refresh_token_ciphertext
      FROM provider_identities
      ORDER BY provider, provider_subject, id
    `),
  ]);
  return { users: usersResult.rows, providers: providersResult.rows };
}

async function main() {
  const stateFile = process.env.BEATGALER_ACCOUNT_LIFECYCLE_STATE_FILE
    || path.resolve(__dirname, '../account-lifecycle-state.json');
  const lifecycleState = readLifecycleState(stateFile);
  const pool = createPostgresPool(Pool, process.env);
  if (!pool) {
    const error = new Error('Auth identity preflight requires BEATGALER_POSTGRES_ENABLED=true and DATABASE_URL.');
    error.code = 'AUTH_IDENTITY_PREFLIGHT_POSTGRES_REQUIRED';
    throw error;
  }

  try {
    const rows = await loadIdentityRows(pool);
    const report = analyzeIdentityPreflight({ ...rows, lifecycleState });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ready ? 0 : 2;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({
      schema: 'beatgaler-auth-identity-preflight-error/v1',
      ready: false,
      code: String(error?.code || 'AUTH_IDENTITY_PREFLIGHT_FAILED'),
      error: String(error?.message || error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { readLifecycleState, loadIdentityRows };
