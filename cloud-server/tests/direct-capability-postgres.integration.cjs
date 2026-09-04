'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');
const { Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations.js');

// Store tests do not need Telegram. Keep the capability module import pure here
// instead of loading the Direct provider runtime and its external dependencies.
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === './direct-transport-control' && String(parent?.filename || '').endsWith('direct-capability-boundary.js')) {
    return { endOperation: async () => ({ ok: true }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { createPostgresStore } = require('../direct-capability-boundary.js');
Module._load = originalLoad;

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/beatgaler_ci';
const pool = new Pool({ connectionString });
const suffix = crypto.randomBytes(6).toString('hex');
const tenantId = `d7-cap-${suffix}`;
const userId = `user-${suffix}`;
const installationId = `install-${suffix}`;
const authSessionHash = crypto.createHash('sha256').update(`auth-${suffix}`).digest('hex');
const sessionId = `session-${suffix}`;

function record(hashChar, operationId, objectId) {
  const now = Date.now();
  return {
    capability_hash: hashChar.repeat(64),
    internal_operation_id: `${operationId}-${suffix}`,
    user_id: userId,
    tenant_id: tenantId,
    installation_id: installationId,
    auth_session_hash: authSessionHash,
    session_id: sessionId,
    generation: 1,
    vault_scope: `vault-${suffix}`,
    operation_type: 'download',
    object_scope: { object_type: 'message', object_ids: [String(objectId)] },
    issued_at_ms: now,
    expires_at_ms: now + 60_000,
  };
}

function request(hashChar, objectId, overrides = {}) {
  return {
    capabilityHash: hashChar.repeat(64),
    userId,
    tenantId,
    installationId,
    authSessionHash,
    sessionId,
    generation: 1,
    operationType: 'download',
    objectScope: { object_type: 'message', object_ids: [String(objectId)] },
    clockSkewMs: 0,
    ...overrides,
  };
}

async function main() {
  await applyMigrations(pool);
  const store = createPostgresStore(pool, { maxActivePerTenant: 2 });
  try {
    await store.issue(record('a', 'op-a', 101));

    const wrongObject = await store.authorize(request('a', 102));
    assert.equal(wrongObject.ok, false);
    assert.equal(wrongObject.reason, 'scope');

    const authorized = await store.authorize(request('a', 101));
    assert.equal(authorized.ok, true);
    assert.equal(authorized.record.status, 'AUTHORIZED');

    const replay = await store.authorize(request('a', 101));
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, 'authorized');

    await store.issue(record('b', 'op-b', 202));
    await assert.rejects(
      store.issue(record('c', 'op-c', 303)),
      error => error?.code === 'DIRECT_TENANT_CAP_REACHED' && error?.status === 429,
    );

    const finished = await store.finish(request('a', 101));
    assert.equal(finished.ok, true);
    assert.equal(finished.authorized, true);
    assert.equal(finished.record.status, 'CONSUMED');

    const finishRetry = await store.finish(request('a', 101));
    assert.equal(finishRetry.ok, true);
    assert.equal(finishRetry.replay, true);

    // CONSUMED no longer counts against the live tenant ceiling.
    await store.issue(record('c', 'op-c', 303));

    const revoked = await store.revokeTenant({ tenantId, reason: 'ci_incident' });
    assert.equal(revoked, 2);
    const live = await pool.query(
      "SELECT count(*)::int AS n FROM direct_capabilities WHERE tenant_id=$1 AND status IN ('ACTIVE','AUTHORIZED')",
      [tenantId],
    );
    assert.equal(Number(live.rows[0].n), 0);

    const stored = await pool.query(
      'SELECT capability_hash,status,object_scope FROM direct_capabilities WHERE tenant_id=$1 ORDER BY internal_operation_id',
      [tenantId],
    );
    assert.equal(stored.rows.length, 3);
    assert(stored.rows.every(row => /^[0-9a-f]{64}$/.test(row.capability_hash)));
    assert(stored.rows.some(row => row.status === 'CONSUMED'));
    assert(stored.rows.filter(row => row.status === 'REVOKED').length === 2);

    console.log('PASS D7 PostgreSQL Direct capability integration');
  } finally {
    await pool.query('DELETE FROM direct_capabilities WHERE tenant_id=$1', [tenantId]).catch(() => {});
    await pool.end();
  }
}

main().catch(async error => {
  console.error(error);
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
