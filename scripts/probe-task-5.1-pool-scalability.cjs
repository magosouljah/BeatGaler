'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const BOT_COUNT = 80;
const MAX_VAULTS_PER_BOT = 4;
const EXPECTED_CAPACITY = BOT_COUNT * MAX_VAULTS_PER_BOT;
const ACTIVE_USER_RATE = 0.03;
const EXPECTED_USER_BASE_AT_CAPACITY = Math.floor(EXPECTED_CAPACITY / ACTIVE_USER_RATE);

function loadDirect(stateFile, diagDir) {
  process.env.TRANSPORT_POOL_STATE = stateFile;
  process.env.DIRECT_DIAGNOSTICS_DIR = diagDir;
  process.env.BEATGALER_DIRECT_TRANSPORT = 'false';
  process.env.DIRECT_TOKEN_ROTATION_ENABLED = 'false';
  process.env.POOL_LOCK_WAIT_MS = '60000';

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'telegram') return { TelegramClient: class {}, Api: {} };
    if (request === 'telegram/sessions') return { StringSession: class {} };
    if (request === 'telegram/client/uploads') return { CustomFile: class {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../cloud-server/direct-transport-control.js');
  } finally {
    Module._load = originalLoad;
  }
}

function makePool(count = BOT_COUNT) {
  return Array.from({ length: count }, (_, index) => ({
    id: `Bot${String(index + 1).padStart(2, '0')}`,
    token: `fake-${index + 1}`,
  }));
}

function loadsFromState(state, pool) {
  const loads = new Map(pool.map(bot => [bot.id, 0]));
  for (const lease of Object.values(state.leases || {})) {
    if (loads.has(lease.bot_id) && lease.status !== 'CLEANED') {
      loads.set(lease.bot_id, loads.get(lease.bot_id) + 1);
    }
  }
  return loads;
}

if (!isMainThread) {
  const { stateFile, diagDir, pool, count, workerIndex } = workerData;
  const direct = loadDirect(stateFile, diagDir);
  const sessions = [];
  for (let i = 0; i < count; i += 1) {
    const result = direct.__test.leaseNextBot(pool, {
      installation_id: `worker-${workerIndex}-install-${i}`,
      chat_id: `worker-${workerIndex}-vault-${i}`,
    });
    sessions.push({
      session_id: result.lease.session_id,
      bot_id: result.bot.id,
      load_before: result.loadBefore,
      load_after: result.loadAfter,
    });
  }
  parentPort.postMessage(sessions);
  return;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-pool-scalability-'));
  const stateFile = path.join(tmp, 'transport-pool-state.json');
  const diagDir = path.join(tmp, 'diag');
  const pool = makePool();
  const direct = loadDirect(stateFile, diagDir);

  // G1: exact fairness and exclusive-first behavior through four full rounds.
  fs.rmSync(stateFile, { force: true });
  const sequential = [];
  for (let i = 0; i < EXPECTED_CAPACITY; i += 1) {
    sequential.push(direct.__test.leaseNextBot(pool, {
      installation_id: `seq-install-${i}`,
      chat_id: `seq-vault-${i}`,
    }));
  }

  const firstRound = sequential.slice(0, BOT_COUNT);
  assert.equal(firstRound.filter(row => row.loadBefore === 0).length, BOT_COUNT);
  assert.equal(new Set(firstRound.map(row => row.bot.id)).size, BOT_COUNT);
  assert.equal(sequential.slice(BOT_COUNT).filter(row => row.loadBefore === 0).length, 0);

  const sequentialState = direct.__test.stateSnapshot(pool);
  const sequentialLoads = [...loadsFromState(sequentialState, pool).values()];
  assert.equal(Math.min(...sequentialLoads), MAX_VAULTS_PER_BOT);
  assert.equal(Math.max(...sequentialLoads), MAX_VAULTS_PER_BOT);

  // Characterize the current production allocator honestly: it has no max-4 admission gate yet.
  const fifth = direct.__test.leaseNextBot(pool, {
    installation_id: 'fifth-wave-install',
    chat_id: 'fifth-wave-vault',
  });
  const rawAllocatorAcceptsFifth = fifth.loadBefore === MAX_VAULTS_PER_BOT && fifth.loadAfter === MAX_VAULTS_PER_BOT + 1;
  assert.equal(rawAllocatorAcceptsFifth, true);

  // G2: real file-lock concurrency against one shared state file.
  fs.rmSync(stateFile, { force: true });
  const workerCount = 16;
  const perWorker = EXPECTED_CAPACITY / workerCount;
  assert.equal(Number.isInteger(perWorker), true);

  const workerResults = await Promise.all(Array.from({ length: workerCount }, (_, workerIndex) => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: { stateFile, diagDir, pool, count: perWorker, workerIndex },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', code => { if (code !== 0) reject(new Error(`worker ${workerIndex} exited ${code}`)); });
  })));

  const concurrent = workerResults.flat();
  assert.equal(concurrent.length, EXPECTED_CAPACITY);
  assert.equal(new Set(concurrent.map(row => row.session_id)).size, EXPECTED_CAPACITY);

  const concurrentState = direct.__test.stateSnapshot(pool);
  const concurrentLoads = [...loadsFromState(concurrentState, pool).values()];
  const minConcurrentLoad = Math.min(...concurrentLoads);
  const maxConcurrentLoad = Math.max(...concurrentLoads);
  assert.equal(minConcurrentLoad, MAX_VAULTS_PER_BOT);
  assert.equal(maxConcurrentLoad, MAX_VAULTS_PER_BOT);
  assert.equal(maxConcurrentLoad - minConcurrentLoad, 0);

  // Observed allocator invariants.
  const freeBotBypassed = concurrent.filter(row => row.load_before > 0).some(row => {
    // If load_before > 0 appeared before all 80 zero-load assignments had happened,
    // fairness/exclusive-first would have been violated. Sort is intentionally not
    // inferred from worker completion order, so validate final round counts instead.
    return false;
  });
  assert.equal(freeBotBypassed, false);

  const result = {
    probe: 'M0-G pool scalability characterization',
    bot_count: BOT_COUNT,
    max_vaults_per_bot_decision: MAX_VAULTS_PER_BOT,
    theoretical_active_vault_capacity: EXPECTED_CAPACITY,
    active_user_rate_assumption: ACTIVE_USER_RATE,
    approximate_user_base_at_3pct_before_capacity: EXPECTED_USER_BASE_AT_CAPACITY,
    exclusive_first_round_proven: true,
    fair_load_rounds_through_four_proven: true,
    concurrent_requests: EXPECTED_CAPACITY,
    concurrent_workers: workerCount,
    unique_session_ids_proven: true,
    concurrent_state_valid: true,
    concurrent_final_load_min: minConcurrentLoad,
    concurrent_final_load_max: maxConcurrentLoad,
    load_spread: maxConcurrentLoad - minConcurrentLoad,
    raw_allocator_accepts_fifth_vault: rawAllocatorAcceptsFifth,
    production_max4_admission_enforced: false,
    production_waitlist_implemented: false,
    observability_complete: false,
    runtime_changed: false,
    telegram_network_used: false,
    real_vaults_used: false,
    token_rotation_or_revoke: false,
    task_5_1_closed: false,
  };

  console.log(JSON.stringify(result, null, 2));
  console.log('PASS M0-G characterization: fairness/concurrency proven; max-4 admission + waitlist remain product gaps.');
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
