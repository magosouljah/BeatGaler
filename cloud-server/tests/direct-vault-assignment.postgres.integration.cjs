'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { applyMigrations, listMigrations } = require('../postgres-migrations');
const { createDirectVaultAssignmentStore } = require('../direct-vault-assignment');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const WORKER = path.join(__dirname, 'direct-vault-assignment.postgres.worker.cjs');

function assertDestructiveTestDatabase(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL is required for persistent assignment PostgreSQL integration.');
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const explicitlyAllowed = String(process.env.BEATGALER_ALLOW_DESTRUCTIVE_PG_TEST || '').toLowerCase() === 'true';
  if (!explicitlyAllowed && !/(^|[_-])(ci|test)([_-]|$)/i.test(databaseName)) {
    throw new Error(`Refusing destructive PostgreSQL test against non-test database: ${databaseName || '<empty>'}`);
  }
}

function runWorker(chatIds) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(chatIds)], {
      env: { ...process.env, DATABASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`assignment worker exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        resolve(JSON.parse(lines.at(-1) || '[]'));
      } catch (error) {
        reject(new Error(`assignment worker returned invalid JSON: ${stdout.trim()} (${error.message})`));
      }
    });
  });
}

async function insertVault(pool, id, chatId) {
  const userId = `user-${id}`;
  await pool.query('INSERT INTO users(id) VALUES($1)', [userId]);
  await pool.query(
    'INSERT INTO vaults(id,user_id,telegram_chat_id,title) VALUES($1,$2,$3,$4)',
    [id, userId, String(chatId), `Vault ${id}`],
  );
}

function bots(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => {
    const id = `Bot${String(index + 1).padStart(3, '0')}`;
    return { id, ...(overrides[id] || {}) };
  });
}

async function main() {
  assertDestructiveTestDatabase(DATABASE_URL);

  const poolA = new Pool({ connectionString: DATABASE_URL, max: 8 });
  const poolB = new Pool({ connectionString: DATABASE_URL, max: 8 });
  try {
    await poolA.query('DROP SCHEMA public CASCADE');
    await poolA.query('CREATE SCHEMA public');

    const migrations = listMigrations();
    const migrationResult = await applyMigrations(poolA, migrations);
    assert.equal(migrationResult.applied.length, migrations.length);
    assert(migrationResult.applied.includes('0010'), 'migration 0010 must be applied in the real PostgreSQL gate');

    const columns = await poolA.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='vaults'
    `);
    const columnNames = new Set(columns.rows.map(row => row.column_name));
    for (const name of ['transport_bot_id', 'transport_membership_state', 'transport_membership_updated_at']) {
      assert(columnNames.has(name), `missing migrated vault column: ${name}`);
    }

    const storeA = createDirectVaultAssignmentStore(poolA);
    const storeB = createDirectVaultAssignmentStore(poolB);
    const initialBots = bots(80);
    await storeA.syncTransportBots(initialBots);

    const persistedBots = await poolA.query('SELECT id,secret_ref,quarantined,rotation_pending FROM transport_bots ORDER BY id');
    assert.equal(persistedBots.rows.length, 80);
    assert(persistedBots.rows.every(row => row.secret_ref === null), 'pool sync must not persist bot secrets');

    // Two independent Node processes racing the same first assignment must converge on one persisted bot.
    await insertVault(poolA, 'race-vault', '-1000000001');
    const [raceA, raceB] = await Promise.all([
      runWorker(['-1000000001']),
      runWorker(['-1000000001']),
    ]);
    assert.equal(raceA.length, 1);
    assert.equal(raceB.length, 1);
    assert.equal(raceA[0].transportBotId, raceB[0].transportBotId);
    assert.equal(raceA[0].membershipState, 'pending');
    const raceRow = (await poolA.query(
      'SELECT transport_bot_id,transport_membership_state FROM vaults WHERE id=$1',
      ['race-vault'],
    )).rows[0];
    assert.equal(raceRow.transport_bot_id, raceA[0].transportBotId);
    assert.equal(raceRow.transport_membership_state, 'pending');

    // Remove the race fixture so the 80/160 distribution starts from a clean persistent count.
    await poolA.query('DELETE FROM users WHERE id=$1', ['user-race-vault']);

    const balanceChatIds = [];
    for (let index = 0; index < 160; index += 1) {
      const id = `balance-vault-${String(index + 1).padStart(3, '0')}`;
      const chatId = String(-1000100000 - index);
      balanceChatIds.push(chatId);
      await insertVault(poolA, id, chatId);
    }

    // Two real processes assign disjoint vault sets concurrently. The global PostgreSQL assignment lock
    // serializes only the short selection transaction, so exact least-persistent-count balance is deterministic.
    const left = balanceChatIds.filter((_, index) => index % 2 === 0);
    const right = balanceChatIds.filter((_, index) => index % 2 === 1);
    const [leftAssignments, rightAssignments] = await Promise.all([runWorker(left), runWorker(right)]);
    assert.equal(leftAssignments.length + rightAssignments.length, 160);

    const balance = await poolA.query(`
      SELECT transport_bot_id,COUNT(*)::int AS assignment_count
      FROM vaults
      WHERE id LIKE 'balance-vault-%'
      GROUP BY transport_bot_id
      ORDER BY transport_bot_id
    `);
    assert.equal(balance.rows.length, 80);
    assert(balance.rows.every(row => row.assignment_count === 2), '80 bots / 160 vaults must produce exactly two persistent assignments per bot');

    // A brand-new process after the initial assignment observes the same authority, proving process restart persistence.
    const restartBefore = await storeA.getAssignment({ chatId: balanceChatIds[0] });
    const restartRead = await runWorker([balanceChatIds[0]]);
    assert.equal(restartRead[0].transportBotId, restartBefore.transportBotId);

    // Membership state transitions are persisted independently of the session/lease tables.
    const ready = await storeB.markMembershipReady({ chatId: balanceChatIds[0] }, restartBefore.transportBotId);
    assert.equal(ready.membershipState, 'ready');
    const repair = await storeA.markMembershipRepairNeeded({ chatId: balanceChatIds[0] }, restartBefore.transportBotId);
    assert.equal(repair.membershipState, 'repair');

    // Active session load must not decide persistent ownership. Four ACTIVE leases on Bot001 are deliberately
    // present, but with equal persistent counts the next vault still selects Bot001 by deterministic id tie-break.
    const leaseVaults = (await poolA.query(`
      SELECT id FROM vaults WHERE id LIKE 'balance-vault-%' ORDER BY id LIMIT 4
    `)).rows;
    for (let index = 0; index < leaseVaults.length; index += 1) {
      await poolA.query(`
        INSERT INTO direct_leases(
          id,transport_bot_id,vault_id,installation_id,generation,credential_version,status,started_at,last_heartbeat_at
        ) VALUES($1,'Bot001',$2,$3,1,1,'ACTIVE',now(),now())
      `, [`lease-${index + 1}`, leaseVaults[index].id, `install-${index + 1}`]);
    }
    await insertVault(poolA, 'lease-ignored-vault', '-1000999001');
    const leaseIgnored = await storeA.assignIfMissing({ chatId: '-1000999001' });
    assert.equal(leaseIgnored.transportBotId, 'Bot001', 'persistent assignment must ignore active lease load');

    // Quarantine blocks only NEW ownership. Existing vaults keep the same bot even after it is quarantined.
    const bot001Existing = (await poolA.query(`
      SELECT telegram_chat_id FROM vaults
      WHERE transport_bot_id='Bot001' AND id LIKE 'balance-vault-%'
      ORDER BY id LIMIT 1
    `)).rows[0];
    await storeA.syncTransportBots(bots(80, { Bot001: { quarantined: true } }));
    const existingAfterQuarantine = await storeB.assignIfMissing({ chatId: bot001Existing.telegram_chat_id });
    assert.equal(existingAfterQuarantine.transportBotId, 'Bot001');
    await insertVault(poolA, 'quarantine-new-vault', '-1000999002');
    const quarantineNew = await storeA.assignIfMissing({ chatId: '-1000999002' });
    assert.notEqual(quarantineNew.transportBotId, 'Bot001');

    // A configured bot missing from the supplied pool is fail-closed for future assignment, but does not
    // rewrite existing vault ownership. This confirms the intended syncTransportBots() policy.
    const bot080Existing = (await poolA.query(`
      SELECT telegram_chat_id FROM vaults
      WHERE transport_bot_id='Bot080' AND id LIKE 'balance-vault-%'
      ORDER BY id LIMIT 1
    `)).rows[0];
    await storeA.syncTransportBots(initialBots.filter(bot => bot.id !== 'Bot080'));
    const bot080State = (await poolA.query('SELECT quarantined FROM transport_bots WHERE id=$1', ['Bot080'])).rows[0];
    assert.equal(bot080State.quarantined, true);
    const existingAfterRemoval = await storeB.assignIfMissing({ chatId: bot080Existing.telegram_chat_id });
    assert.equal(existingAfterRemoval.transportBotId, 'Bot080');
    await insertVault(poolA, 'missing-pool-new-vault', '-1000999003');
    const missingPoolNew = await storeA.assignIfMissing({ chatId: '-1000999003' });
    assert.notEqual(missingPoolNew.transportBotId, 'Bot080');

    // Adding a fresh bot with zero persistent assignments naturally attracts future vaults without rebalance.
    await storeA.syncTransportBots([...initialBots, { id: 'Bot081' }]);
    await insertVault(poolA, 'new-bot-vault', '-1000999004');
    const newBotAssignment = await storeA.assignIfMissing({ chatId: '-1000999004' });
    assert.equal(newBotAssignment.transportBotId, 'Bot081');

    // Existing assignments remain singular and durable; no test above writes ownership through direct_leases.
    const unassigned = await poolA.query("SELECT COUNT(*)::int AS n FROM vaults WHERE transport_bot_id IS NULL");
    assert.equal(unassigned.rows[0].n, 0);

    console.log('PASS persistent Direct vault assignment PostgreSQL integration: migrations, cross-process locking, 80/160 balance, restart persistence, lease independence, quarantine, and pool growth');
  } finally {
    await Promise.allSettled([poolA.end(), poolB.end()]);
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
