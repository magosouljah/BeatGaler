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

function context(tab, generation) { return { tab_id: tab, document_id: `${tab}-document`, generation }; }

(async () => {
  const direct = require('../direct-transport-control.js');
  let clockA = 100;
  direct.__test.setMonotonicNow(() => clockA);
  const { prepareAssignedLease } = require('../direct-persistent-session-runtime');
  const pool = [{ id: 'Bot01' }];
  const chatId = '-1007000000777';
  const first = prepareAssignedLease({ directTransport: direct, status: direct.poolStatus(), transportBotId: 'Bot01', installationId: 'live-device', chatId }).lease;
  const second = prepareAssignedLease({ directTransport: direct, status: direct.poolStatus(), transportBotId: 'Bot01', installationId: 'next-device', chatId }).lease;
  const begin = (lease, tab, kind = 'get_index') => direct.beginOperation({
    installationId: lease.installation_id, sessionId: lease.session_id, generation: lease.generation,
    credentialVersion: lease.credential_version, kind, documentContext: context(tab, 1),
  });

  const active = await begin(first, 'first-tab', 'replace_index');
  assert.equal(active.ok, true);
  assert.equal((await begin(second, 'second-tab')).reason, 'index_busy', 'a live owner is exclusive');

  // A different installation does not own A's session and cannot extend its
  // lease. This must not alter the persisted liveness record.
  const livenessBeforeHijack = direct.__test.stateSnapshot(pool).operations[active.operation_id].last_liveness_monotonic_ms;
  const hijack = await direct.renewOperation({
    installationId: second.installation_id, sessionId: second.session_id, generation: second.generation, operationId: active.operation_id,
  });
  assert.deepEqual(hijack, { ok: false, expired: true }, 'B cannot renew A\'s operation');
  assert.equal(
    direct.__test.stateSnapshot(pool).operations[active.operation_id].last_liveness_monotonic_ms,
    livenessBeforeHijack,
    'a rejected renewal never updates A\'s liveness',
  );

  // A paused-but-live worker renews the lock and remains exclusive.
  const renewal = await direct.renewOperation({
    installationId: first.installation_id, sessionId: first.session_id, generation: first.generation, operationId: active.operation_id,
  });
  assert.equal(renewal.ok, true);
  assert.equal(renewal.liveness_timeout_ms, 15_000);
  assert.equal((await begin(second, 'second-tab')).reason, 'index_busy', 'renewed active owner cannot be stolen');

  // Simulate a real Cloud restart: reload the module so PROCESS_INSTANCE_ID and
  // its monotonic clock are new. B must not compare A's persisted performance
  // timestamp. It first gives A a bounded re-confirmation window.
  const directPath = require.resolve('../direct-transport-control.js');
  delete require.cache[directPath];
  const restarted = require('../direct-transport-control.js');
  let clockB = 1_000;
  restarted.__test.setMonotonicNow(() => clockB);
  const beginAfterRestart = (lease, tab) => restarted.beginOperation({
    installationId: lease.installation_id, sessionId: lease.session_id, generation: lease.generation,
    credentialVersion: lease.credential_version, kind: 'get_index', documentContext: context(tab, 1),
  });
  assert.equal((await beginAfterRestart(second, 'second-tab')).reason, 'index_busy', 'process B keeps A exclusive during its fresh-process grace');

  // A genuine owner request routed to B re-confirms A's persisted operation;
  // only A's session/generation can do this. The renewed record remains
  // exclusive through B's liveness bound.
  const reconfirmed = await restarted.renewOperation({
    installationId: first.installation_id, sessionId: first.session_id, generation: first.generation, operationId: active.operation_id,
  });
  assert.equal(reconfirmed.ok, true);
  clockB += 14_999;
  assert.equal((await beginAfterRestart(second, 'second-tab')).reason, 'index_busy', 'B retains a re-confirmed A operation until the bound');

  // No later confirmation: B reaps the persisted lease at its local bound,
  // even when wall time moves backward. This proves restart recovery does not
  // trust stale process-local performance timestamps from A.
  clockB += 2;
  const originalNow = Date.now;
  Date.now = () => originalNow() - 60 * 60_000;
  try {
    const recovered = await beginAfterRestart(second, 'second-tab');
    assert.equal(recovered.ok, true, 'a dead owner is reclaimed after the short liveness bound');
    const state = restarted.__test.stateSnapshot(pool);
    assert.equal(state.operations[active.operation_id], undefined);
    await restarted.endOperation({ installationId: second.installation_id, sessionId: second.session_id, generation: second.generation, operationId: recovered.operation_id });
  } finally {
    Date.now = originalNow;
  }

  console.log('PASS Direct INDEX liveness: no cross-installation renewal; fresh process grace/re-confirmation preserves exclusion; no re-confirm expires within 15s despite backward wall clock');
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true });
});
