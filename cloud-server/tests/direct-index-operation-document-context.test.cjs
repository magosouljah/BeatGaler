'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-index-document-context-'));
const poolFile = path.join(tmp, 'transport-bots.json');
const stateFile = path.join(tmp, 'transport-pool-state.json');
const registryFile = path.join(tmp, 'vault-registry.json');
const mastersFile = path.join(tmp, 'masters-does-not-exist.json');
const bot = {
  id: 'Bot01',
  token: 'fake-direct-token',
  telegram_user_id: '123456789',
  telegram_username: 'BeatGalerTransport01Bot',
};

fs.writeFileSync(poolFile, JSON.stringify({ bots: [bot] }));
fs.writeFileSync(registryFile, JSON.stringify({ version: 1, vaults: {} }));

process.env.TRANSPORT_BOTS_FILE = poolFile;
process.env.TRANSPORT_POOL_STATE = stateFile;
process.env.VAULT_REGISTRY_FILE = registryFile;
process.env.MASTERS_FILE = mastersFile;
process.env.DIRECT_DIAGNOSTICS_DIR = path.join(tmp, 'diag');
process.env.BEATGALER_DIRECT_TRANSPORT = 'true';
process.env.DIRECT_TOKEN_ROTATION_ENABLED = 'false';
process.env.DIRECT_HEARTBEAT_INTERVAL_MS = '600000';
process.env.DIRECT_HEARTBEAT_TIMEOUT_MS = '600000';
process.env.TELEGRAM_API_ID = '12345';
process.env.TELEGRAM_API_HASH = 'fake-api-hash';
delete process.env.BEATGALER_MASTER_SESSION;
delete process.env.MASTER_SESSION;
delete process.env.MASTER_SESSION_FILE;

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'telegram') {
    return {
      TelegramClient: class {
        constructor() {
          throw new Error('TelegramClient must not be constructed by this regression.');
        }
      },
      Api: {},
    };
  }
  if (request === 'telegram/sessions') return { StringSession: class {} };
  if (request === 'telegram/client/uploads') return { CustomFile: class {} };
  return originalLoad.call(this, request, isMain);
};

function context(tab, document, generation) {
  return { tab_id: tab, document_id: document, generation };
}

(async () => {
  const direct = require('../direct-transport-control.js');
  const { prepareAssignedLease } = require('../direct-persistent-session-runtime');
  const runtimePool = [{ id: 'Bot01' }];
  const chatId = '-1007000000999';

  const first = prepareAssignedLease({
    directTransport: direct,
    status: direct.poolStatus(),
    transportBotId: bot.id,
    installationId: 'browser-installation-a',
    chatId,
  }).lease;

  const begin = (lease, kind, documentContext) => direct.beginOperation({
    installationId: lease.installation_id,
    sessionId: lease.session_id,
    generation: lease.generation,
    credentialVersion: lease.credential_version,
    kind,
    documentContext,
  });

  // Old document begins an INDEX read and disappears without operation/end.
  const abandonedRead = await begin(first, 'get_index', context('tab-a', 'doc-a-1', 1));
  assert.equal(abandonedRead.ok, true);

  // A newer Document in the SAME browser tab fences that orphan and recovers immediately.
  const recoveredRead = await begin(first, 'get_index', context('tab-a', 'doc-a-2', 2));
  assert.equal(recoveredRead.ok, true);
  assert.notEqual(recoveredRead.operation_id, abandonedRead.operation_id);

  let state = direct.__test.stateSnapshot(runtimePool);
  assert.equal(state.operations[abandonedRead.operation_id], undefined, 'superseded same-tab document must be reclaimed');
  assert.equal(state.operations[recoveredRead.operation_id].document_generation, 2);

  // Same-document concurrency is still serialized.
  const sameDocumentWrite = await begin(first, 'replace_index', context('tab-a', 'doc-a-2', 2));
  assert.deepEqual(
    { ok: sameDocumentWrite.ok, wait: sameDocumentWrite.wait, reason: sameDocumentWrite.reason },
    { ok: false, wait: true, reason: 'index_busy' },
  );

  // Another legitimate tab in the same session cannot steal the active operation.
  const otherTab = await begin(first, 'get_index', context('tab-b', 'doc-b-1', 1));
  assert.deepEqual(
    { ok: otherTab.ok, wait: otherTab.wait, reason: otherTab.reason },
    { ok: false, wait: true, reason: 'index_busy' },
  );

  // A stale request from an older generation cannot arrive late and fence the newer one.
  const staleLateRequest = await begin(first, 'get_index', context('tab-a', 'doc-a-late', 1));
  assert.deepEqual(
    { ok: staleLateRequest.ok, wait: staleLateRequest.wait, reason: staleLateRequest.reason },
    { ok: false, wait: true, reason: 'index_busy' },
  );

  await direct.endOperation({
    installationId: first.installation_id,
    sessionId: first.session_id,
    generation: first.generation,
    operationId: recoveredRead.operation_id,
  });

  // The same reclaim rule applies to an abandoned INDEX write after its Document died.
  const abandonedWrite = await begin(first, 'replace_index', context('tab-a', 'doc-a-3', 3));
  assert.equal(abandonedWrite.ok, true);
  const recoveredAfterWrite = await begin(first, 'get_index', context('tab-a', 'doc-a-4', 4));
  assert.equal(recoveredAfterWrite.ok, true);
  state = direct.__test.stateSnapshot(runtimePool);
  assert.equal(state.operations[abandonedWrite.operation_id], undefined, 'newer same-tab document must reclaim abandoned write owner');
  await direct.endOperation({
    installationId: first.installation_id,
    sessionId: first.session_id,
    generation: first.generation,
    operationId: recoveredAfterWrite.operation_id,
  });

  // Multi-device safety: a different Direct session for the same vault remains exclusive.
  const second = prepareAssignedLease({
    directTransport: direct,
    status: direct.poolStatus(),
    transportBotId: bot.id,
    installationId: 'browser-installation-b',
    chatId,
  }).lease;

  const activeOtherDevice = await begin(second, 'replace_index', context('tab-device-b', 'doc-device-b-1', 1));
  assert.equal(activeOtherDevice.ok, true);

  const attemptedSteal = await begin(first, 'get_index', context('tab-a', 'doc-a-5', 5));
  assert.deepEqual(
    { ok: attemptedSteal.ok, wait: attemptedSteal.wait, reason: attemptedSteal.reason },
    { ok: false, wait: true, reason: 'index_busy' },
  );

  await direct.endOperation({
    installationId: second.installation_id,
    sessionId: second.session_id,
    generation: second.generation,
    operationId: activeOtherDevice.operation_id,
  });

  console.log('PASS Direct INDEX document fencing: same-tab Reload reclaims orphan; same-document, other-tab, stale-generation, and other-device operations remain serialized');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});
