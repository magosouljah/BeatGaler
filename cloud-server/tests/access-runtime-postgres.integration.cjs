'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { Client, Pool } = require('pg');
const { applyMigrations } = require('../postgres-migrations');
const { createAccessRuntime } = require('../access-runtime');
const { createPlanMeHandler, createAccountHandler } = require('../access-consumer-handlers');

const ADMIN_URL = process.env.BEATGALER_STEP2_TEST_ADMIN_URL || '';
const NOW = Date.parse('2026-10-08T12:00:00Z');

test('PostgreSQL Access reads billing and grants without trusting Auth planState', { skip: !ADMIN_URL }, async () => {
  const dbName = `beatgaler_f3s2_${crypto.randomBytes(6).toString('hex')}`;
  assert.match(dbName, /^beatgaler_f3s2_[0-9a-f]{12}$/);
  const admin = new Client({ connectionString: ADMIN_URL });
  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${dbName}`;
  let pool;
  let server;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    pool = new Pool({ connectionString: dbUrl.toString(), max: 4 });
    await applyMigrations(pool);
    await pool.query("INSERT INTO users(id,email) VALUES('u1','step2@example.com')");
    await pool.query(`INSERT INTO entitlements(id,user_id,plan_id,source,starts_at,expires_at)
      VALUES('legacy-base-u1','u1','highest_paid','base_plan',$1,NULL)`, [new Date(NOW - 30 * 86400_000)]);
    const user = { id: 'u1', username: 'step2#0001', email: 'step2@example.com', providers: {}, planState: { basePlanId: 'highest_paid', grants: [] } };
    const runtime = createAccessRuntime({ pool, now: () => NOW });
    const app = express();
    const bearerToken = () => 'session';
    const getUser = () => user;
    app.get('/plans/me', createPlanMeHandler({ getUser, bearerToken, resolveUserPlan: runtime.resolveUserPlan }));
    app.post('/auth/account', createAccountHandler({ getUser, bearerToken, resolveUserPlan: runtime.resolveUserPlan, userProvider: () => null }));
    server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    const free = await runtime.resolveUserPlan(user);
    assert.equal(free.effective_plan_id, 'free');
    assert.equal(free.quotas.max_beats, 20);

    await pool.query(`INSERT INTO entitlements(id,user_id,plan_id,source,starts_at,expires_at)
      VALUES('welcome-u1','u1','paid_entry','welcome',$1,$2)`, [new Date(NOW - 86400_000), new Date(NOW + 6 * 86400_000)]);
    const welcome = await runtime.resolveUserPlan(user);
    assert.equal(welcome.effective_plan_id, 'paid_entry');
    assert.equal(welcome.entitlements.upload_project, true);

    await pool.query(`INSERT INTO billing_subscription_state(user_id,plan_id,status,paid_through,cancel_at_period_end)
      VALUES('u1','highest_paid','canceled',$1,true)`, [new Date(NOW + 86400_000)]);
    const paid = await runtime.resolveUserPlan(user);
    assert.equal(paid.effective_plan_id, 'highest_paid');
    assert.equal(paid.access.billing.cancelAtPeriodEnd, true);
    const [planResponse, accountResponse] = await Promise.all([
      fetch(`${base}/plans/me`),
      fetch(`${base}/auth/account`, { method: 'POST' }),
    ]);
    assert.equal(planResponse.status, 200);
    assert.equal(accountResponse.status, 200);
    assert.deepEqual((await planResponse.json()).plan, paid);
    assert.deepEqual((await accountResponse.json()).user.plan, paid);

    await pool.query("UPDATE entitlements SET revoked_at=$1,revocation_reason='support' WHERE id='welcome-u1'", [new Date(NOW)]);
    await pool.query("UPDATE billing_subscription_state SET paid_through=$1 WHERE user_id='u1'", [new Date(NOW)]);
    const ended = await runtime.resolveUserPlan(user);
    assert.equal(ended.effective_plan_id, 'free');
    assert.equal(ended.access.accessSources.length, 1);
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
});
