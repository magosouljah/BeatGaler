'use strict';

const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createDirectVaultAssignmentStore } = require('../direct-vault-assignment');

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();

async function main() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required for legacy lazy PostgreSQL integration.');
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  try {
    const store = createDirectVaultAssignmentStore(pool);
    const bots = [
      { id: 'LegacyLazyBot01' },
      { id: 'LegacyLazyBot02' },
    ];
    await store.syncTransportBots(bots);

    const fixtures = [
      ['legacy-lazy-user-a', 'legacy-lazy-vault-a', '-1008800000001'],
      ['legacy-lazy-user-b', 'legacy-lazy-vault-b', '-1008800000002'],
    ];
    for (const [userId, vaultId, chatId] of fixtures) {
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
      await pool.query('INSERT INTO users(id) VALUES($1)', [userId]);
      await pool.query(
        'INSERT INTO vaults(id,user_id,telegram_chat_id,title) VALUES($1,$2,$3,$4)',
        [vaultId, userId, chatId, `Legacy Lazy ${vaultId}`],
      );
    }

    let rows = await pool.query(`
      SELECT id,transport_bot_id,transport_membership_state
      FROM vaults
      WHERE id IN ('legacy-lazy-vault-a','legacy-lazy-vault-b')
      ORDER BY id
    `);
    assert.equal(rows.rows.length, 2);
    assert(rows.rows.every(row => row.transport_bot_id === null));
    assert(rows.rows.every(row => row.transport_membership_state === 'pending'));

    const first = await store.assignIfMissing({ chatId: '-1008800000001' });
    assert.ok(first.transportBotId, 'first legacy access must establish persistent ownership');
    assert.equal(first.membershipState, 'pending');

    rows = await pool.query(`
      SELECT id,transport_bot_id,transport_membership_state
      FROM vaults
      WHERE id IN ('legacy-lazy-vault-a','legacy-lazy-vault-b')
      ORDER BY id
    `);
    const a = rows.rows.find(row => row.id === 'legacy-lazy-vault-a');
    const b = rows.rows.find(row => row.id === 'legacy-lazy-vault-b');
    assert.equal(a.transport_bot_id, first.transportBotId);
    assert.equal(a.transport_membership_state, 'pending');
    assert.equal(b.transport_bot_id, null, 'unaccessed legacy vault must remain NULL in real PostgreSQL');
    assert.equal(b.transport_membership_state, 'pending');

    const repeated = await store.assignIfMissing({ chatId: '-1008800000001' });
    assert.equal(repeated.transportBotId, first.transportBotId, 'repeat access must keep the same persistent bot');
    const untouchedAgain = await store.getAssignment({ chatId: '-1008800000002' });
    assert.equal(untouchedAgain.transportBotId, null);

    console.log('PASS PostgreSQL legacy lazy rollout: one NULL vault assigns on first access while unrelated legacy vault stays NULL');
  } finally {
    for (const userId of ['legacy-lazy-user-a', 'legacy-lazy-user-b']) {
      try { await pool.query('DELETE FROM users WHERE id=$1', [userId]); } catch (_) {}
    }
    await pool.end();
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
