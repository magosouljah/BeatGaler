'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-direct-stale-operation-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
const diagnosticsDir = path.join(tmp, 'diag');
const diagnosticsFile = path.join(diagnosticsDir, 'telegram-direct-control.txt');
fs.writeFileSync(poolFile, JSON.stringify({ bots: [{ id: 'Bot01', token: 'fake-token' }] }));

process.env.TRANSPORT_BOTS_FILE = poolFile;
process.env.TRANSPORT_POOL_STATE = stateFile;
process.env.VAULT_REGISTRY_FILE = path.join(tmp, 'vault-registry.json');
process.env.MASTERS_FILE = path.join(tmp, 'missing-masters.json');
process.env.DIRECT_DIAGNOSTICS_DIR = diagnosticsDir;
process.env.BEATGALER_DIRECT_TRANSPORT = 'true';
process.env.DIRECT_TOKEN_ROTATION_ENABLED = 'false';
process.env.DIRECT_HEARTBEAT_INTERVAL_MS = '600000';
process.env.DIRECT_HEARTBEAT_TIMEOUT_MS = '600000';
process.env.DIRECT_INDEX_OPERATION_LIVENESS_TIMEOUT_MS = '15000';
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
  const { prepareAssignedLease } = require('../direct-persistent-session-runtime');
  const runtimePool = [{ id: 'Bot01' }];
  let monotonicClock = 100;
  direct.__test.setMonotonicNow(() => monotonicClock);

  const { lease } = prepareAssignedLease({
    directTransport: direct,
    status: direct.poolStatus(),
    transportBotId: 'Bot01',
    installationId: 'stale-operation-installation',
    chatId: '-1007000000999',
  });
  const operation = await direct.beginOperation({
    installationId: lease.installation_id,
    sessionId: lease.session_id,
    generation: lease.generation,
    credentialVersion: lease.credential_version,
    kind: 'get_index',
    documentContext: { tab_id: 'tab-1', document_id: 'document-1', generation: 1 },
  });
  assert.equal(operation.ok, true);

  monotonicClock += 15_001;
  const beforeRead = fs.readFileSync(stateFile, 'utf8');
  const readOnlySnapshot = direct.__test.stateSnapshot(runtimePool);
  assert.ok(readOnlySnapshot.operations[operation.operation_id], 'read-only snapshot must not reap stale operations');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), beforeRead, 'read-only snapshot must not write pool state');
  await direct.cleanupExpiredSessions();

  let persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.leases[lease.session_id], 'valid lease must survive stale operation cleanup');
  assert.equal(persisted.operations[operation.operation_id], undefined, 'stale operation must be removed from disk');

  const reapCount = () => {
    const diagnostics = fs.existsSync(diagnosticsFile) ? fs.readFileSync(diagnosticsFile, 'utf8') : '';
    return diagnostics.split('\n').filter(line =>
      line.includes('STALE_OPERATION_REAPED') && line.includes(operation.operation_id)
    ).length;
  };
  assert.equal(reapCount(), 1, 'stale operation must emit one reap diagnostic');

  monotonicClock += 60_000;
  await direct.cleanupExpiredSessions();
  persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.leases[lease.session_id], 'later maintenance must preserve the valid lease');
  assert.equal(persisted.operations[operation.operation_id], undefined, 'stale operation must not reappear on disk');
  assert.equal(reapCount(), 1, 'later maintenance must not reap the same operation again');

  console.log('PASS Direct stale operation cleanup: persisted once, diagnosed once, valid lease preserved');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});
