'use strict';

const assert = require('node:assert/strict');
const {
  ASSIGNMENT_LOCK_KEY,
  createDirectVaultAssignmentStore,
} = require('../direct-vault-assignment');

function fakePool() {
  const bots = new Map();
  const vaults = new Map();
  const calls = [];

  function clone(row) { return row ? { ...row } : row; }
  function vaultBySelector(sql, params) {
    if (sql.includes('telegram_chat_id=$1') || sql.includes('telegram_chat_id=$2')) {
      const chatId = String(params[sql.includes('telegram_chat_id=$2') ? 1 : 0]);
      return [...vaults.values()].find(row => String(row.telegram_chat_id) === chatId);
    }
    const id = String(params[sql.includes('id=$2') ? 1 : 0]);
    return vaults.get(id);
  }

  async function query(sql, params = []) {
    calls.push({ sql, params: [...params] });
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(compact)) return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };

    if (sql.includes('UPDATE transport_bots') && sql.includes('NOT (id = ANY')) {
      const live = new Set(params[0].map(String));
      for (const row of bots.values()) if (!live.has(row.id)) row.quarantined = true;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO transport_bots')) {
      const [id, quarantined, rotationPending] = params;
      bots.set(String(id), {
        ...(bots.get(String(id)) || {}),
        id: String(id),
        quarantined: Boolean(quarantined),
        rotation_pending: Boolean(rotationPending),
      });
      return { rows: [] };
    }
    if (sql.includes('FROM transport_bots tb')) {
      const counts = new Map([...bots.keys()].map(id => [id, 0]));
      for (const row of vaults.values()) {
        if (row.transport_bot_id && counts.has(row.transport_bot_id)) {
          counts.set(row.transport_bot_id, counts.get(row.transport_bot_id) + 1);
        }
      }
      const candidates = [...bots.values()]
        .filter(row => !row.quarantined && !row.rotation_pending)
        .map(row => ({ id: row.id, assignment_count: String(counts.get(row.id) || 0) }))
        .sort((a, b) => Number(a.assignment_count) - Number(b.assignment_count) || a.id.localeCompare(b.id));
      return { rows: candidates.slice(0, 1) };
    }
    if (sql.includes('FROM vaults WHERE')) {
      const row = vaultBySelector(sql, params);
      return { rows: row ? [clone(row)] : [] };
    }
    if (sql.includes("SET transport_bot_id=$1")) {
      const [botId, vaultId] = params;
      const row = vaults.get(String(vaultId));
      row.transport_bot_id = String(botId);
      row.transport_membership_state = 'pending';
      row.transport_membership_updated_at = new Date().toISOString();
      return { rows: [clone(row)] };
    }
    if (sql.includes('SET transport_membership_state=$1')) {
      const state = String(params[0]);
      const row = vaultBySelector(sql, params);
      const expectedBotId = params.length === 3 ? String(params[2]) : null;
      if (!row || !row.transport_bot_id || (expectedBotId && row.transport_bot_id !== expectedBotId)) return { rows: [] };
      row.transport_membership_state = state;
      row.transport_membership_updated_at = new Date().toISOString();
      return { rows: [clone(row)] };
    }
    throw new Error(`unexpected SQL: ${compact}`);
  }

  const pool = {
    calls,
    bots,
    vaults,
    query,
    async connect() { return { query, release() {} }; },
  };
  return pool;
}

function addVault(pool, id, chatId) {
  pool.vaults.set(id, {
    id,
    user_id: `user-${id}`,
    telegram_chat_id: String(chatId),
    transport_bot_id: null,
    transport_membership_state: 'pending',
    transport_membership_updated_at: null,
  });
}

(async () => {
  const pool = fakePool();
  const store = createDirectVaultAssignmentStore(pool);

  await store.syncTransportBots([
    { id: 'Bot02' },
    { id: 'Bot01' },
    { id: 'BotBlocked', quarantined: true },
  ]);
  assert.ok(pool.calls.some(call => call.sql.includes('pg_advisory_xact_lock') && call.params[0] === ASSIGNMENT_LOCK_KEY));

  addVault(pool, 'vault-a', '-1001');
  addVault(pool, 'vault-b', '-1002');
  addVault(pool, 'vault-c', '-1003');

  const first = await store.assignIfMissing({ chatId: '-1001' });
  assert.equal(first.transportBotId, 'Bot01', 'equal loads must use deterministic bot id ordering');
  assert.equal((await store.assignIfMissing({ vaultId: 'vault-a' })).transportBotId, 'Bot01', 'same vault must keep its persistent bot');
  assert.equal((await store.assignIfMissing({ vaultId: 'vault-b' })).transportBotId, 'Bot02', 'minimum persistent assignment count must win');
  assert.equal((await store.assignIfMissing({ vaultId: 'vault-c' })).transportBotId, 'Bot01', 'ties must remain deterministic');
  assert.ok(![...pool.vaults.values()].some(row => row.transport_bot_id === 'BotBlocked'));

  const restartedStore = createDirectVaultAssignmentStore(pool);
  assert.equal((await restartedStore.getAssignment('-1001')).transportBotId, 'Bot01', 'assignment must survive store recreation / Cloud restart');
  assert.equal((await restartedStore.markMembershipReady({ vaultId: 'vault-a' }, 'Bot01')).membershipState, 'ready');
  assert.equal((await restartedStore.markMembershipRepairNeeded({ vaultId: 'vault-a' }, 'Bot01')).membershipState, 'repair');
  await assert.rejects(() => restartedStore.markMembershipReady({ vaultId: 'vault-a' }, 'Bot02'), error => error.code === 'TRANSPORT_ASSIGNMENT_MISMATCH');

  const balancedPool = fakePool();
  const balancedStore = createDirectVaultAssignmentStore(balancedPool);
  const eightyBots = Array.from({ length: 80 }, (_, index) => ({ id: `Bot${String(index + 1).padStart(2, '0')}` }));
  await balancedStore.syncTransportBots(eightyBots);
  for (let index = 0; index < 160; index += 1) {
    addVault(balancedPool, `vault-${index}`, String(-2000 - index));
    await balancedStore.assignIfMissing({ vaultId: `vault-${index}` });
  }
  const counts = new Map(eightyBots.map(bot => [bot.id, 0]));
  for (const row of balancedPool.vaults.values()) counts.set(row.transport_bot_id, counts.get(row.transport_bot_id) + 1);
  assert.deepEqual([...counts.values()], Array(80).fill(2), '160 vaults over 80 bots must balance to two persistent assignments each');

  console.log('PASS persistent Direct vault assignment store semantics');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
