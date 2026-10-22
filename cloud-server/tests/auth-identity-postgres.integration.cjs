'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations');
const { createProviderIdentityAuthority } = require('../provider-identity-authority');
const execFileAsync = promisify(execFile);

function databaseUrl(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function bridge() {
  return { adoptIdentityUser() {}, setUsernameByUserId() {}, userIdByUsername() { return null; } };
}

function faultingPool(pool) {
  let fail = true;
  return {
    async connect() {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === 'query') return async (...args) => {
            if (fail && /^INSERT INTO provider_identities\b/i.test(String(args[0]).trim())) {
              fail = false;
              throw new Error('injected provider insert failure');
            }
            return target.query(...args);
          };
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

async function main() {
  const base = String(process.env.DATABASE_URL || '');
  if (!base) throw new Error('DATABASE_URL is required for the PostgreSQL identity integration test.');
  const name = `beatgaler_auth_identity_ci_${crypto.randomBytes(5).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl(base, 'postgres'), ssl: false, max: 1 });
  let poolA;
  let poolB;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = databaseUrl(base, name);
    poolA = new Pool({ connectionString: url, ssl: false, max: 4 });
    poolB = new Pool({ connectionString: url, ssl: false, max: 4 });
    await applyMigrations(poolA);

    const nullableOldEmail = await poolA.query(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name='auth_email_changes' AND column_name='old_email'
    `);
    assert.equal(nullableOldEmail.rows[0]?.is_nullable, 'YES', 'X-only accounts need the first-email migration');

    await poolA.query("INSERT INTO users(id,username,username_source) VALUES('usr_x_a','pepito','x')");
    await poolA.query("INSERT INTO provider_identities(id,user_id,provider,provider_subject,profile) VALUES('prv_x_a','usr_x_a','x','x-a','{}'::jsonb)");
    const authorityB = createProviderIdentityAuthority({ pool: poolB, getBridge: bridge });
    const faulty = createProviderIdentityAuthority({ pool: faultingPool(poolB), getBridge: bridge });

    // A crash before commit must leave the old owner and provider unchanged.
    await assert.rejects(
      faulty.prepareX({ identity: { id: 'x-b', username: 'pepito' }, registrationOpen: true }),
      /injected provider insert failure/,
    );
    let users = await poolA.query("SELECT id,username FROM users ORDER BY id");
    assert.deepEqual(users.rows, [{ id: 'usr_x_a', username: 'pepito' }]);
    assert.equal((await poolA.query("SELECT count(*)::int AS n FROM provider_identities WHERE provider_subject='x-b'")).rows[0].n, 0);

    // The retried OAuth claim moves A and creates B with one durable commit.
    const claimed = await authorityB.prepareX({ identity: { id: 'x-b', username: 'pepito' }, registrationOpen: true });
    assert.equal(claimed.created, true);
    users = await poolA.query("SELECT id,username FROM users ORDER BY id");
    assert.equal(users.rows.length, 2);
    assert.match(users.rows.find(row => row.id === 'usr_x_a').username, /^pepito#\d{4}$/);
    assert.equal(users.rows.find(row => row.id === claimed.existingUserId).username, 'pepito');
    assert.equal((await poolA.query("SELECT user_id FROM provider_identities WHERE provider='x' AND provider_subject='x-a'")).rows[0].user_id, 'usr_x_a');
    assert.equal((await poolA.query("SELECT user_id FROM provider_identities WHERE provider='x' AND provider_subject='x-b'")).rows[0].user_id, claimed.existingUserId);

    // Separate Node processes race for one new subject and return one stable user.
    const worker = path.join(__dirname, 'auth-identity-postgres.worker.cjs');
    const spawnClaim = () => execFileAsync(process.execPath, [worker], {
      env: { ...process.env, DATABASE_URL: url, TEST_X_SUBJECT: 'x-c', TEST_X_HANDLE: 'juanito' },
      timeout: 15_000,
    });
    const [first, second] = await Promise.all([spawnClaim(), spawnClaim()]);
    assert.equal(JSON.parse(first.stdout).userId, JSON.parse(second.stdout).userId);
    assert.equal((await poolA.query("SELECT count(*)::int AS n FROM provider_identities WHERE provider='x' AND provider_subject='x-c'")).rows[0].n, 1);
    assert.equal((await poolA.query("SELECT count(*)::int AS n FROM users WHERE lower(username)='juanito'")).rows[0].n, 1);
    console.log('auth identity PostgreSQL integration: PASS');
  } finally {
    if (poolA) await poolA.end();
    if (poolB) await poolB.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
