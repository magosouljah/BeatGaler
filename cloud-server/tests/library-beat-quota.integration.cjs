'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client, Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations');
const { createLibraryBeatQuota } = require('../library-beat-quota');

const ADMIN_URL = process.env.BEATGALER_STEP3_TEST_ADMIN_URL || '';
const NOW = Date.parse('2026-10-08T12:00:00Z');
const beat = id => ({ id });
const manifest = (active, trash = []) => ({
  schema: 'beatgaler.telegram.library', version: 2,
  beats: active.map(beat), trash: trash.map(id => ({ beat: beat(id) })),
});
const ids = (prefix, count) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);

test('STEP 3: PostgreSQL beat registry, bootstrap and cross-process quota reservations', { skip: !ADMIN_URL }, async t => {
  const dbName = `beatgaler_f3s3_${crypto.randomBytes(6).toString('hex')}`;
  assert.match(dbName, /^beatgaler_f3s3_[0-9a-f]{12}$/);
  const admin = new Client({ connectionString: ADMIN_URL });
  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${dbName}`;
  let pool;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbUrl.toString(), max: 12 });
    await applyMigrations(pool);
    for (const id of ['free', 'paid', 'highest', 'other', 'uninit', 'over']) {
      await pool.query('INSERT INTO users(id,email) VALUES($1,$2)', [id, `${id}@example.com`]);
    }
    for (const [id, plan] of [['paid', 'paid_entry'], ['highest', 'highest_paid']]) {
      await pool.query(`INSERT INTO billing_subscription_state(user_id,plan_id,status,paid_through)
        VALUES($1,$2,'active',$3)`, [id, plan, new Date(NOW + 30 * 86400_000)]);
    }
    let now = NOW;
    const observations = new Map([
      ['free', manifest(ids('f', 18), ['f-trash'])],
      ['paid', manifest(ids('p', 99))],
      ['highest', manifest(ids('h', 100))],
      ['other', manifest([])],
      ['over', manifest(ids('over', 21))],
    ]);
    const readIndex = async userId => ({ messageId: 42, manifest: observations.get(userId), serverVerified: true });
    const quotaA = createLibraryBeatQuota({ pool, readIndex, now: () => now });
    const quotaB = createLibraryBeatQuota({ pool, readIndex, now: () => now });

    await t.test('I: no bootstrap means no new identity', async () => {
      await assert.rejects(quotaA.reserve({ userId: 'uninit', beatId: 'new', reservationId: 'uninit-op' }), { code: 'LIBRARY_QUOTA_UNINITIALIZED' });
      assert.equal((await quotaA.usage('uninit')).ready, false);
    });

    await t.test('F/J: bootstrap counts ACTIVE and Trash once and is idempotent', async () => {
      const first = await quotaA.bootstrap('free');
      const second = await quotaB.bootstrap('free');
      assert.equal(first.used, 19);
      assert.equal(first.active, 18);
      assert.equal(first.trash, 1);
      assert.deepEqual(second, first);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM library_beats WHERE user_id='free'")).rows[0].n, 19);
      observations.set('free', manifest(ids('f', 18), ['f-trash', 'external-new']));
      await assert.rejects(quotaA.bootstrap('free'), { code: 'LIBRARY_QUOTA_INDEX_CHANGED' });
      observations.set('free', manifest(ids('f', 18), ['f-trash']));
    });

    await t.test('B/C/G/L: 19/20 across processes admits one; Trash move and restart preserve 20/20', async () => {
      const settled = await Promise.allSettled([
        quotaA.reserve({ userId: 'free', beatId: 'new-a', reservationId: 'free-a' }),
        quotaB.reserve({ userId: 'free', beatId: 'new-b', reservationId: 'free-b' }),
      ]);
      assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(settled.filter(item => item.status === 'rejected' && item.reason.code === 'LIBRARY_QUOTA_EXCEEDED').length, 1);
      const winner = settled[0].status === 'fulfilled' ? 'free-a' : 'free-b';
      await quotaA.confirm({ userId: 'free', reservationId: winner });
      assert.equal((await quotaA.usage('free')).used, 20);
      await quotaB.moveToTrash({ userId: 'free', beatId: winner === 'free-a' ? 'new-a' : 'new-b' });
      const afterMove = await quotaA.usage('free');
      assert.equal(afterMove.used, 20);
      assert.equal(afterMove.trash, 2);
      await quotaB.restore({ userId: 'free', beatId: winner === 'free-a' ? 'new-a' : 'new-b' });
      assert.equal((await quotaA.usage('free')).used, 20);
      await quotaB.moveToTrash({ userId: 'free', beatId: winner === 'free-a' ? 'new-a' : 'new-b' });
      await assert.rejects(quotaB.reserve({ userId: 'free', beatId: 'next', reservationId: 'free-next' }), { code: 'LIBRARY_QUOTA_EXCEEDED' });
      const restarted = createLibraryBeatQuota({ pool, readIndex, now: () => now });
      assert.equal((await restarted.usage('free')).used, 20);
      assert.equal((await restarted.usage('free')).remaining, 0);
    });

    await t.test('D: 99/100 across processes admits only one', async () => {
      await quotaA.bootstrap('paid');
      const settled = await Promise.allSettled([
        quotaA.reserve({ userId: 'paid', beatId: 'paid-a', reservationId: 'paid-a' }),
        quotaB.reserve({ userId: 'paid', beatId: 'paid-b', reservationId: 'paid-b' }),
      ]);
      assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(settled.filter(item => item.status === 'rejected' && item.reason.code === 'LIBRARY_QUOTA_EXCEEDED').length, 1);
      await quotaB.confirm({ userId: 'paid', reservationId: settled[0].status === 'fulfilled' ? 'paid-a' : 'paid-b' });
      assert.equal((await quotaA.usage('paid')).used, 100);
    });

    await t.test('E/H: Highest has no cap; retries keep the same durable reservation', async () => {
      await quotaA.bootstrap('highest');
      const request = { userId: 'highest', beatId: 'h-new', reservationId: 'highest-op' };
      const first = await quotaA.reserve(request);
      const retry = await quotaB.reserve(request);
      assert.equal(first.reservationId, retry.reservationId);
      assert.equal(new Date(first.expiresAt).toISOString(), new Date(retry.expiresAt).toISOString());
      assert.equal((await quotaA.usage('highest')).pending, 1);
      await quotaB.confirm({ userId: 'highest', reservationId: 'highest-op' });
      const committedRetry = await quotaA.reserve(request);
      assert.equal(committedRetry.status, 'COMMITTED');
      assert.equal((await quotaA.usage('highest')).used, 101);
      assert.equal((await quotaA.usage('highest')).limit, null);
    });

    await t.test('A/K: Free 0/20 and two users have isolated capacity', async () => {
      const [firstBootstrap, concurrentBootstrap] = await Promise.all([quotaA.bootstrap('other'), quotaB.bootstrap('other')]);
      assert.deepEqual(firstBootstrap, concurrentBootstrap);
      const first = await quotaA.reserve({ userId: 'other', beatId: 'o-1', reservationId: 'other-op' });
      assert.equal(first.status, 'PENDING');
      assert.equal((await quotaA.usage('other')).occupied, 1);
      await quotaA.confirm({ userId: 'other', reservationId: 'other-op' });
      assert.equal((await quotaA.usage('other')).used, 1);
      assert.equal((await quotaA.usage('free')).used, 20);
      await quotaA.reserve({ userId: 'other', beatId: 'other-shared', reservationId: 'shared-op' });
      await quotaB.reserve({ userId: 'highest', beatId: 'highest-shared', reservationId: 'shared-op' });
      await quotaA.cancel({ userId: 'other', reservationId: 'shared-op' });
      await quotaB.cancel({ userId: 'highest', reservationId: 'shared-op' });
    });

    await t.test('crash leaves expiring pending state; downgrade keeps data and blocks new slots', async () => {
      await quotaA.reserve({ userId: 'highest', beatId: 'ghost', reservationId: 'ghost-op' });
      assert.equal((await quotaA.usage('highest')).pending, 1);
      now += 16 * 60_000;
      assert.equal((await quotaB.usage('highest')).pending, 0);
      assert.equal((await quotaB.usage('highest')).used, 101);
      assert.equal((await pool.query("SELECT state FROM library_beat_reservations WHERE id='ghost-op'")).rows[0].state, 'EXPIRED');
      await quotaA.bootstrap('over');
      const over = await quotaA.usage('over');
      assert.equal(over.used, 21);
      assert.equal(over.overQuota, true);
      await assert.rejects(quotaA.reserve({ userId: 'over', beatId: 'new', reservationId: 'over-op' }), { code: 'LIBRARY_QUOTA_EXCEEDED' });
      await pool.query(`INSERT INTO billing_subscription_state(user_id,plan_id,status,paid_through)
        VALUES('over','highest_paid','active',$1)`, [new Date(now + 86400_000)]);
      await assert.rejects(quotaB.reserve({ userId: 'over', beatId: 'new', reservationId: 'over-op' }), { code: 'LIBRARY_QUOTA_EXCEEDED' });
      await quotaB.reserve({ userId: 'over', beatId: 'pending-downgrade', reservationId: 'pending-downgrade' });
      await pool.query("UPDATE billing_subscription_state SET paid_through=$1 WHERE user_id='over'", [new Date(now)]);
      await assert.rejects(quotaA.confirm({ userId: 'over', reservationId: 'pending-downgrade' }), { code: 'LIBRARY_QUOTA_EXCEEDED' });
      assert.equal((await quotaA.usage('over')).pending, 0);
      assert.equal((await quotaA.usage('over')).used, 21);
    });
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
});
