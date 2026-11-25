'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-index-liveness-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
fs.writeFileSync(poolFile, JSON.stringify({ bots: [{ id: 'Bot01', token: 'fake-token' }] }));

process.env.TRANSPORT_BOTS_FILE = poolFile;
process.env.TRANSPORT_POOL_STATE = stateFile;
process.env.VAULT_REGISTRY_FILE = path.join(tmp, 'vault-registry.json');
process.env.MASTERS_FILE = path.join(tmp, 'missing-masters.json');
process.env.DIRECT_DIAGNOSTICS_DIR = path.join(tmp, 'diag');
process.env.BEATGALER_DIRECT_TRANSPORT = 'true';
process.env.DIRECT_TOKEN_ROTATION_ENABLED = 'false';
process.env.DIRECT_HEARTBEAT_INTERVAL_MS = '600000';
process.env.DIRECT_HEARTBEAT_TIMEOUT_MS = '600000';
process.env.TELEGRAM_API_ID = '12345';
process.env.TELEGRAM_API_HASH = 'fake-api-hash';

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'telegram') return { TelegramClient: class {}, Api: {} };
  if (request === 'telegram/sessions') return { StringSession: class {} };
  if (request === 'telegram/client/uploads') return { CustomFile: class {} };
  return originalLoad.call(this, request, parent, isMain);
};


(async () => {
  const direct = require('../direct-transport-control.js');
  const { prepareAssignedLease } = require('./helpers/prepare-assigned-lease.cjs');
  const { seedOperation } = require('./helpers/seed-operation.cjs');
  const pool = [{ id: 'Bot01' }];
  const chatId = '-1007000000777';
  const first = prepareAssignedLease({ directTransport: direct, status: direct.poolStatus(), transportBotId: 'Bot01', installationId: 'live-device', chatId }).lease;
  // An INDEX operation persisted by an earlier Cloud process (X1d: seeded directly;
  // beginOperation was retired together with the unregistered /transport/operation/begin route).
  const operationId = seedOperation({ directTransport: direct, pool, lease: first, kind: 'replace_index' });
  assert.ok(direct.__testing.stateSnapshot(pool).operations[operationId], 'seeded INDEX operation must be persisted');

  // Simulate a real Cloud restart: reload the module so PROCESS_INSTANCE_ID and
  // its monotonic clock are new. The new process must not compare the persisted
  // operation against its own performance clock: it first gives the operation a
  // bounded re-confirmation window and then reaps it.
  const directPath = require.resolve('../direct-transport-control.js');
  delete require.cache[directPath];
  const restarted = require('../direct-transport-control.js');
  let clockB = 1_000;
  restarted.__testing.setMonotonicNow(() => clockB);

  await restarted.__testing.cleanupExpiredSessions();
  assert.ok(restarted.__testing.stateSnapshot(pool).operations[operationId], 'fresh process keeps the persisted operation during its grace');
  clockB += 14_999;
  await restarted.__testing.cleanupExpiredSessions();
  assert.ok(restarted.__testing.stateSnapshot(pool).operations[operationId], 'operation is retained until the liveness bound');

  // No confirmation: the operation is reaped at the local bound, even when wall
  // time moves backward. Restart recovery must not trust stale process-local
  // performance timestamps from the previous process.
  clockB += 2;
  const originalNow = Date.now;
  Date.now = () => originalNow() - 60 * 60_000;
  try {
    await restarted.__testing.cleanupExpiredSessions();
  } finally {
    Date.now = originalNow;
  }
  const state = restarted.__testing.stateSnapshot(pool);
  assert.equal(state.operations[operationId], undefined, 'a dead owner operation is reaped after the short liveness bound');
  assert.ok(state.leases[first.session_id], 'reaping the operation keeps the valid lease');

  console.log('PASS Direct INDEX liveness: restarted process grants a bounded grace to persisted operations and reaps them within 15s despite a backward wall clock');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});
