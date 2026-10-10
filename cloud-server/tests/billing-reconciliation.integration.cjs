'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { applyMigrations, listMigrations } = require('../postgres-migrations');
const { createCommercialCatalog } = require('../billing-commercial-catalog');
const { createBillingSafeLogger } = require('../billing-safe-log');
const { createBillingReconciliationService, BillingReconciliationError } = require('../billing-reconciliation');
const { createAccessRuntime } = require('../access-runtime');
const { createBillingLifecycle } = require('../billing-lifecycle');
const { createDurableWebhookInbox } = require('../billing-webhook-durable');
const { createReconciliationRuntime } = require('../billing-reconciliation-runtime');
const { reconcileManualUser } = require('../scripts/billing-reconcile-user.cjs');

const ADMIN_URL = process.env.BILLING_RECONCILIATION_TEST_ADMIN_URL || '';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function databaseUrl(adminUrl, databaseName) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function catalog() {
  return createCommercialCatalog({
    provider: 'polar',
    environment: 'sandbox',
    providerMappings: {
      paid_entry_monthly_v1: { productId: 'prod_paid', priceId: 'price_paid' },
      highest_paid_monthly_v1: { productId: 'prod_high', priceId: 'price_high' },
    },
  });
}

function subFixture({
  id,
  customerId,
  plan = 'paid_entry',
  status = 'active',
  start = '2026-09-01T00:00:00.000Z',
  end = '2026-10-01T00:00:00.000Z',
  cancelAtPeriodEnd = false,
}) {
  const high = plan === 'highest_paid';
  return {
    id,
    customer_id: customerId,
    product_id: high ? 'prod_high' : 'prod_paid',
    price_id: high ? 'price_high' : 'price_paid',
    prices: [{ id: high ? 'price_high' : 'price_paid' }],
    status,
    current_period_start: start,
    current_period_end: end,
    cancel_at_period_end: cancelAtPeriodEnd,
  };
}

function orderFixture({
  id,
  customerId,
  subscriptionId,
  checkoutId = null,
  plan = 'paid_entry',
  start = '2026-09-01T00:00:00.000Z',
  end = '2026-10-01T00:00:00.000Z',
  status = 'paid',
  paid = true,
  refundedAmount = 0,
}) {
  const high = plan === 'highest_paid';
  const amount = high ? 1199 : 699;
  return {
    id,
    customer_id: customerId,
    subscription_id: subscriptionId,
    checkout_id: checkoutId,
    product_id: high ? 'prod_high' : 'prod_paid',
    product_price_id: high ? 'price_high' : 'price_paid',
    status,
    paid,
    net_amount: amount,
    subtotal_amount: amount,
    total_amount: amount,
    refunded_amount: refundedAmount,
    currency: 'usd',
    invoice_number: `INV-${id}`,
    created_at: `${start.slice(0, 10)}T00:00:01.000Z`,
    items: [{
      id: `item_${id}`,
      amount,
      product_price_id: high ? 'price_high' : 'price_paid',
      start_timestamp: start,
      end_timestamp: end,
      proration: false,
    }],
  };
}

function makeProviderHarness() {
  const subscriptionsByUser = new Map();
  const ordersByUser = new Map();
  const failures = new Map();
  const providerCatalog = catalog();

  const adapter = {
    provider: 'polar',
    environment: 'sandbox',
    catalog: providerCatalog,
    async verifyWebhook({ rawBody }) { return JSON.parse(Buffer.from(rawBody).toString('utf8')); },
    async listSubscriptionsForUser({ userId }) {
      const failure = failures.get(userId);
      if (failure) throw failure;
      return clone(subscriptionsByUser.get(userId) || []);
    },
    async listOrdersForUser({ userId }) {
      const failure = failures.get(userId);
      if (failure) throw failure;
      return clone(ordersByUser.get(userId) || []);
    },
    async getSubscription(id) {
      for (const items of subscriptionsByUser.values()) {
        const found = items.find(item => item.id === id);
        if (found) return clone(found);
      }
      throw Object.assign(new Error('subscription missing'), { code: 'FIXTURE_SUBSCRIPTION_MISSING' });
    },
    async getOrder(id) {
      for (const items of ordersByUser.values()) {
        const found = items.find(item => item.id === id);
        if (found) return clone(found);
      }
      throw Object.assign(new Error('order missing'), { code: 'FIXTURE_ORDER_MISSING' });
    },
  };

  return { subscriptionsByUser, ordersByUser, failures, adapter };
}

async function insertCheckout(pool, { userId, checkoutId, requestId = 'req_1', offerId = 'paid_entry_monthly_v1' }) {
  await pool.query(`
    INSERT INTO billing_checkout_requests(
      user_id,request_id,offer_id,request_hash_sha256,provider,provider_environment,state,
      provider_checkout_id,checkout_url,expires_at
    ) VALUES($1,$2,$3,$4,'polar','sandbox','OPEN',$5,$6,now()+interval '1 day')
  `, [userId, requestId, offerId, 'a'.repeat(64), checkoutId, `https://sandbox.polar.sh/checkout/${checkoutId}`]);
}

async function insertPaidLocal(pool, {
  userId,
  customerId,
  subscriptionId,
  orderId,
  plan = 'paid_entry',
  start = '2026-09-01T00:00:00.000Z',
  end = '2026-10-01T00:00:00.000Z',
}) {
  const high = plan === 'highest_paid';
  const offerId = high ? 'highest_paid_monthly_v1' : 'paid_entry_monthly_v1';
  const amount = high ? 1199 : 699;
  await pool.query(`
    INSERT INTO billing_customers(id,user_id,provider,provider_environment,provider_customer_id,external_id)
    VALUES($1,$2,'polar','sandbox',$3,$2)
  `, [`cust_${userId}`, userId, customerId]);
  await pool.query(`
    INSERT INTO billing_subscription_state(
      user_id,provider,provider_environment,provider_customer_id,provider_subscription_id,
      offer_id,provider_product_id,provider_price_id,plan_id,status,current_period_start,current_period_end,paid_through
    ) VALUES($1,'polar','sandbox',$2,$3,$4,$5,$6,$7,'active',$8,$9,$9)
  `, [
    userId, customerId, subscriptionId, offerId,
    high ? 'prod_high' : 'prod_paid', high ? 'price_high' : 'price_paid', plan, start, end,
  ]);
  await pool.query(`
    INSERT INTO billing_payments(
      id,provider,provider_environment,provider_order_id,user_id,provider_subscription_id,
      offer_id,period_start,period_end,amount_minor,currency,status,refunded_amount_minor
    ) VALUES($1,'polar','sandbox',$2,$3,$4,$5,$6,$7,$8,'usd','succeeded',0)
  `, [`payment_${userId}`, orderId, userId, subscriptionId, offerId, start, end, amount]);
}

async function subscriptionState(pool, userId) {
  return (await pool.query('SELECT * FROM billing_subscription_state WHERE user_id=$1', [userId])).rows[0] || null;
}

async function exceptionRows(pool, userId) {
  return (await pool.query(`
    SELECT exception_key,reason,state,attempt_count,last_error,provider_snapshot
    FROM billing_reconciliation_exceptions WHERE user_id=$1 ORDER BY exception_key
  `, [userId])).rows;
}

async function auditRows(pool, userId) {
  return (await pool.query(`
    SELECT event_type,details FROM audit_events
    WHERE subject_type='billing_user' AND subject_id=$1
    ORDER BY created_at,id
  `, [userId])).rows;
}

test('Billing V1 reconciliation repairs only authoritative provider facts and logs safely', { skip: !ADMIN_URL }, async t => {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const dbName = `beatgaler_reconcile_v1_${suffix}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const admin = new Client({ connectionString: ADMIN_URL });
  let pool = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
    pool = new Pool({ connectionString: databaseUrl(ADMIN_URL, dbName), max: 8 });
    await applyMigrations(pool, listMigrations());
    await pool.query(`
      INSERT INTO users(id,email) VALUES
        ('recon_lost','lost@example.invalid'),
        ('recon_outage','outage@example.invalid'),
        ('recon_multi','multi@example.invalid'),
        ('recon_refund','refund@example.invalid'),
        ('recon_sweep','sweep@example.invalid')
    `);

    const provider = makeProviderHarness();
    const emitted = [];
    const logger = createBillingSafeLogger({ sink: entry => emitted.push(entry) });
    const service = createBillingReconciliationService({ pool, adapter: provider.adapter, logger });
    const NOW = '2026-09-15T00:00:00.000Z';
    const access = (userId, at = NOW) => createAccessRuntime({ pool, now: () => new Date(at).getTime() }).resolveUserAccess({ id: userId });
    async function fixture(name, { local = true, plan = 'paid_entry' } = {}) {
      const userId = `recon_${name}`;
      const customerId = `cust_${name}`;
      const subscriptionId = `sub_${name}`;
      const orderId = `order_${name}`;
      await pool.query('INSERT INTO users(id,email) VALUES ($1,$2)', [userId, `${name}@example.invalid`]);
      if (local) await insertPaidLocal(pool, { userId, customerId, subscriptionId, orderId, plan });
      provider.subscriptionsByUser.set(userId, [subFixture({ id: subscriptionId, customerId, plan })]);
      provider.ordersByUser.set(userId, [orderFixture({ id: orderId, customerId, subscriptionId, plan })]);
      return { userId, customerId, subscriptionId, orderId,
        sub: provider.subscriptionsByUser.get(userId)[0], order: provider.ordersByUser.get(userId)[0],
        run: (id = name) => service.reconcileUser({ userId, reconciliationId: `test:${id}`, now: new Date(NOW) }),
      };
    }
    async function financial(userId) {
      return { subscription: await subscriptionState(pool, userId),
        payments: (await pool.query('SELECT * FROM billing_payments WHERE user_id=$1 ORDER BY id', [userId])).rows,
      };
    }

    await t.test('lost initial webhook is recovered from external-customer discovery and a confirmed paid order', async () => {
      await insertCheckout(pool, { userId: 'recon_lost', checkoutId: 'co_lost' });
      provider.subscriptionsByUser.set('recon_lost', [subFixture({ id: 'sub_lost', customerId: 'cust_lost' })]);
      provider.ordersByUser.set('recon_lost', [orderFixture({
        id: 'order_lost', customerId: 'cust_lost', subscriptionId: 'sub_lost', checkoutId: 'co_lost',
      })]);

      const result = await service.reconcileUser({
        userId: 'recon_lost',
        reconciliationId: 'manual:lost',
        now: new Date('2026-09-15T00:00:00.000Z'),
      });
      assert.equal(result.repaired, true);
      assert.equal(result.effectivePlanBefore, 'free');
      assert.equal(result.effectivePlanAfter, 'paid_entry');
      assert.equal(result.entitlementGranted, true);
      assert.equal((await access('recon_lost')).effectivePlanId, 'paid_entry');

      const row = await subscriptionState(pool, 'recon_lost');
      assert.equal(row.provider_subscription_id, 'sub_lost');
      assert.equal(new Date(row.paid_through).toISOString(), '2026-10-01T00:00:00.000Z');
      const checkout = (await pool.query(`
        SELECT state FROM billing_checkout_requests WHERE user_id='recon_lost' AND request_id='req_1'
      `)).rows[0];
      assert.equal(checkout.state, 'COMPLETED');
      const audits = await auditRows(pool, 'recon_lost');
      assert.ok(audits.some(row => row.event_type === 'reconciliation_mismatch'));
      assert.ok(audits.some(row => row.event_type === 'reconciliation_repaired'));
    });

    await t.test('provider outage never downgrades paid local state and neither durable nor console logs contain provider secrets', async () => {
      await insertPaidLocal(pool, {
        userId: 'recon_outage', customerId: 'cust_outage', subscriptionId: 'sub_outage', orderId: 'order_outage',
      });
      provider.failures.set('recon_outage', Object.assign(
        new Error('polar_oat_super_secret https://signed.example.invalid/path?token=secret'),
        { code: 'POLAR_SANDBOX_SUBSCRIPTIONS_LIST_FAILED' },
      ));

      await assert.rejects(
        () => service.reconcileUser({ userId: 'recon_outage', reconciliationId: 'manual:outage' }),
        error => error instanceof BillingReconciliationError && error.code === 'BILLING_PROVIDER_UNAVAILABLE',
      );
      const row = await subscriptionState(pool, 'recon_outage');
      assert.equal(row.plan_id, 'paid_entry');
      assert.equal(new Date(row.paid_through).toISOString(), '2026-10-01T00:00:00.000Z');

      const serializedLogs = JSON.stringify(emitted);
      const serializedAudits = JSON.stringify(await auditRows(pool, 'recon_outage'));
      for (const forbidden of ['polar_oat_super_secret', 'signed.example.invalid', 'token=secret']) {
        assert.equal(serializedLogs.includes(forbidden), false);
        assert.equal(serializedAudits.includes(forbidden), false);
      }
      assert.match(serializedLogs, /POLAR_SANDBOX_SUBSCRIPTIONS_LIST_FAILED/);
    });

    await t.test('multiple live subscriptions remain an exception with one stable identity instead of an automatic repair', async () => {
      provider.subscriptionsByUser.set('recon_multi', [
        subFixture({ id: 'sub_multi_a', customerId: 'cust_multi' }),
        subFixture({ id: 'sub_multi_b', customerId: 'cust_multi', plan: 'highest_paid' }),
      ]);
      provider.ordersByUser.set('recon_multi', []);

      const first = await service.reconcileUser({ userId: 'recon_multi', reconciliationId: 'manual:multi:1' });
      const second = await service.reconcileUser({ userId: 'recon_multi', reconciliationId: 'manual:multi:2' });
      assert.equal(first.repaired, undefined);
      assert.equal(first.reason, 'MULTIPLE_SUBSCRIPTIONS_UNEXPECTED');
      assert.equal(second.exceptionKey, first.exceptionKey);
      const rows = await exceptionRows(pool, 'recon_multi');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].state, 'OPEN');
      assert.equal(rows[0].attempt_count, 2);
      assert.equal(rows[0].provider_snapshot.provider, 'polar');
      assert.equal(rows[0].provider_snapshot.environment, 'sandbox');
    });

    await t.test('missed full refund invalidates current commercial coverage, queues durable revoke, and preserves grants', async () => {
      await insertPaidLocal(pool, {
        userId: 'recon_refund', customerId: 'cust_refund', subscriptionId: 'sub_refund', orderId: 'order_refund',
      });
      await pool.query(`
        INSERT INTO entitlements(id,user_id,plan_id,source,source_key,starts_at,expires_at)
        VALUES('grant_refund','recon_refund','paid_entry','admin','admin:recon_refund','2026-09-01T00:00:00Z','2026-11-01T00:00:00Z')
      `);
      provider.subscriptionsByUser.set('recon_refund', [subFixture({ id: 'sub_refund', customerId: 'cust_refund' })]);
      provider.ordersByUser.set('recon_refund', [orderFixture({
        id: 'order_refund', customerId: 'cust_refund', subscriptionId: 'sub_refund',
        status: 'refunded', paid: true, refundedAmount: 699,
      })]);

      const result = await service.reconcileUser({
        userId: 'recon_refund',
        reconciliationId: 'manual:refund',
        now: new Date('2026-09-15T00:00:00.000Z'),
      });
      assert.equal(result.repaired, true);
      const row = await subscriptionState(pool, 'recon_refund');
      assert.equal(row.invalidation_reason, 'FULL_REFUND_CURRENT_PERIOD');
      const payment = (await pool.query(`SELECT status,refunded_amount_minor FROM billing_payments WHERE provider_order_id='order_refund'`)).rows[0];
      assert.equal(payment.status, 'refunded');
      assert.equal(Number(payment.refunded_amount_minor), 699);
      const action = (await pool.query(`SELECT state FROM billing_provider_actions WHERE user_id='recon_refund'`)).rows[0];
      assert.equal(action.state, 'PENDING');
      const grantCount = (await pool.query(`SELECT count(*)::int AS count FROM entitlements WHERE user_id='recon_refund'`)).rows[0].count;
      assert.equal(grantCount, 1);
    });

    await t.test('pending sweep includes a checkout user with no local subscription and repairs the lost purchase', async () => {
      await insertCheckout(pool, { userId: 'recon_sweep', checkoutId: 'co_sweep', requestId: 'req_sweep' });
      provider.subscriptionsByUser.set('recon_sweep', [subFixture({ id: 'sub_sweep', customerId: 'cust_sweep' })]);
      provider.ordersByUser.set('recon_sweep', [orderFixture({
        id: 'order_sweep', customerId: 'cust_sweep', subscriptionId: 'sub_sweep', checkoutId: 'co_sweep',
      })]);

      const summary = await service.runPendingSweep({ limit: 20, sweepId: 'pending:test' });
      assert.ok(summary.checkedCount >= 1);
      assert.ok(summary.repairedCount >= 1);
      const row = await subscriptionState(pool, 'recon_sweep');
      assert.equal(row.plan_id, 'paid_entry');
      assert.equal(new Date(row.paid_through).toISOString(), '2026-10-01T00:00:00.000Z');
    });

    await t.test('commercial sweep is bounded and exposes a cursor instead of requiring provider lookup on every request', async () => {
      const summary = await service.runCommercialSweep({ limit: 2, sweepId: 'daily:test' });
      assert.equal(summary.checkedCount, 2);
      assert.ok(summary.nextCursor);
    });

    await t.test('manual internal operation repairs initial Highest and is idempotent after restart', async () => {
      const f = await fixture('highest', { local: false, plan: 'highest_paid' });
      assert.equal((await access(f.userId)).effectivePlanId, 'free');
      const first = await reconcileManualUser({ pool, adapter: provider.adapter, userId: f.userId, logger });
      assert.equal(first.repaired, true);
      assert.equal((await access(f.userId)).effectivePlanId, 'highest_paid');
      const auditsBefore = await auditRows(pool, f.userId);
      const restarted = createBillingReconciliationService({ pool, adapter: provider.adapter, logger });
      const repeat = await restarted.reconcileUser({ userId: f.userId, reconciliationId: 'restart:highest', now: new Date(NOW) });
      assert.equal(repeat.repaired, false);
      assert.equal((await financial(f.userId)).payments.length, 1);
      assert.deepEqual(await auditRows(pool, f.userId), auditsBefore);
    });

    await t.test('missing renewal advances coverage; old refunded period and ended subscription cannot revoke the new period', async () => {
      const f = await fixture('renewal');
      const start = '2026-10-01T00:00:00.000Z', end = '2026-11-01T00:00:00.000Z';
      Object.assign(f.sub, { current_period_start: start, current_period_end: end });
      const renewal = orderFixture({ id: 'order_renewal_new', customerId: f.customerId, subscriptionId: f.subscriptionId, start, end });
      provider.ordersByUser.set(f.userId, [renewal, { ...f.order, status: 'refunded', refunded_amount: 699 }]);
      provider.subscriptionsByUser.get(f.userId).push(subFixture({
        id: 'old_ended', customerId: f.customerId, status: 'canceled', start: '2026-07-01T00:00:00Z', end: '2026-08-01T00:00:00Z',
      }));
      assert.equal((await f.run()).repaired, true);
      assert.equal(new Date((await subscriptionState(pool, f.userId)).paid_through).toISOString(), end);
      assert.equal((await access(f.userId, '2026-10-15T00:00:00Z')).effectivePlanId, 'paid_entry');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_provider_actions WHERE user_id=$1', [f.userId])).rows[0].n, 0);
      assert.equal((await f.run('renewal:repeat')).repaired, false);
    });

    await t.test('stale cancellation, uncancel and pending plan changes use lifecycle without immediate upgrade', async () => {
      const f = await fixture('cancel');
      f.sub.cancel_at_period_end = true;
      await f.run();
      assert.equal((await access(f.userId)).billing.cancelAtPeriodEnd, true);
      assert.equal((await access(f.userId)).effectivePlanId, 'paid_entry');
      assert.equal((await access(f.userId, '2026-10-01T00:00:00Z')).effectivePlanId, 'free');
      f.sub.cancel_at_period_end = false;
      f.sub.pending_update = { product_id: 'prod_high', applies_at: '2026-10-01T00:00:00Z' };
      await f.run('uncancel');
      let resolved = await access(f.userId);
      assert.equal(resolved.billing.cancelAtPeriodEnd, false);
      assert.equal(resolved.billing.nextPlanId, 'highest_paid');
      assert.equal(resolved.effectivePlanId, 'paid_entry');
      assert.equal((await f.run('pending:repeat')).repaired, false);
    });

    await t.test('past_due survives replay of the old paid Order and recovery consumes the paid pending plan', async () => {
      const f = await fixture('grace');
      Object.assign(f.sub, { status: 'past_due', past_due_at: '2026-10-01T00:00:00Z',
        current_period_start: '2026-10-01T00:00:00Z', current_period_end: '2026-11-01T00:00:00Z',
        product_id: 'prod_high', price_id: 'price_high', prices: [{ id: 'price_high' }] });
      await f.run();
      const resolved = await access(f.userId, '2026-10-03T00:00:00Z');
      assert.equal(resolved.effectivePlanId, 'paid_entry');
      assert.equal(resolved.billing.nextPlanId, 'highest_paid');
      const row = await subscriptionState(pool, f.userId);
      assert.equal(new Date(row.grace_until) - new Date(row.past_due_at), 7 * 86400000);
      assert.equal((await access(f.userId, '2026-10-08T00:00:00Z')).effectivePlanId, 'free');
      assert.equal((await f.run('grace:repeat')).repaired, false);
      f.sub.status = 'active';
      delete f.sub.past_due_at;
      provider.ordersByUser.get(f.userId).push(orderFixture({ id: 'order_grace_recovery', customerId: f.customerId,
        subscriptionId: f.subscriptionId, plan: 'highest_paid', start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' }));
      await f.run('grace:recovery');
      const recovered = await access(f.userId, '2026-10-03T00:00:00Z');
      assert.equal(recovered.effectivePlanId, 'highest_paid');
      assert.equal(recovered.billing.graceUntil, null);
      assert.equal(recovered.billing.nextPlanId, null);
    });

    await t.test('partial/full refunds preserve library data and enqueue exactly one durable provider action', async () => {
      const f = await fixture('refund_data');
      f.sub.access_token = 'polar_oat_super_secret';
      f.order.raw_payload = { card: 'SECRET', url: 'https://signed.example.invalid/?token=secret' };
      await pool.query('INSERT INTO library_quota_state(user_id,index_message_id,index_sha256) VALUES ($1,123,$2)', [f.userId, 'c'.repeat(64)]);
      await pool.query("INSERT INTO library_beats(user_id,beat_id,state) VALUES ($1,'kept','TRASH')", [f.userId]);
      await pool.query(`INSERT INTO library_project_uploads(user_id,beat_id,sha256,message_id,telegram_document_id,size_bytes)
        VALUES ($1,'kept',$2,98765,'kept_doc',100)`, [f.userId, 'b'.repeat(64)]);
      f.order.refunded_amount = 100;
      await f.run('partial');
      assert.equal((await access(f.userId)).effectivePlanId, 'paid_entry');
      assert.equal((await financial(f.userId)).payments[0].status, 'partially_refunded');
      Object.assign(f.order, { status: 'refunded', refunded_amount: 699 });
      await f.run('full');
      assert.equal((await access(f.userId)).effectivePlanId, 'free');
      assert.equal((await f.run('full:repeat')).repaired, false);
      assert.deepEqual((await pool.query('SELECT beat_id,state FROM library_beats WHERE user_id=$1', [f.userId])).rows, [{ beat_id: 'kept', state: 'TRASH' }]);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM library_project_uploads WHERE user_id=$1', [f.userId])).rows[0].n, 1);
      assert.equal((await pool.query('SELECT index_message_id FROM library_quota_state WHERE user_id=$1', [f.userId])).rows[0].index_message_id, '123');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM billing_provider_actions WHERE user_id=$1', [f.userId])).rows[0].n, 1);
    });

    await t.test('ambiguous mappings, refunds, periods and truncated discovery never mutate financial state', async () => {
      const cases = [
        ['unknown_product', f => { f.sub.product_id = 'unknown'; }, 'UNKNOWN_OR_AMBIGUOUS_OFFER'],
        ['unknown_price', f => { f.order.product_price_id = 'unknown'; }, 'UNKNOWN_OR_AMBIGUOUS_OFFER'],
        ['ambiguous_refund', f => { Object.assign(f.order, { status: 'refunded', refunded_amount: 100 }); }, 'REFUND_INTERPRETATION_AMBIGUOUS'],
        ['ambiguous_period', f => { f.order.items = []; }, 'PROVIDER_STATE_AMBIGUOUS'],
        ['truncated', f => { provider.ordersByUser.set(f.userId, { items: [f.order], truncated: true }); }, 'PROVIDER_RESULT_TRUNCATED'],
      ];
      for (const [name, change, reason] of cases) {
        const f = await fixture(name);
        const before = await financial(f.userId);
        change(f);
        const result = await f.run();
        assert.equal(result.reason, reason, name);
        assert.equal(result.entitlementGranted, false);
        assert.deepEqual(await financial(f.userId), before, name);
        assert.equal((await access(f.userId)).effectivePlanId, 'paid_entry');
      }
    });

    await t.test('missing provider subscription and cross-user customer/checkout bindings fail closed', async () => {
      for (const name of ['missing', 'binding', 'checkout_binding', 'external_binding', 'environment_binding']) {
        const f = await fixture(name);
        if (name === 'environment_binding') await pool.query("UPDATE billing_subscription_state SET provider_environment='production' WHERE user_id=$1", [f.userId]);
        const before = await financial(f.userId);
        if (name === 'missing') provider.subscriptionsByUser.set(f.userId, []);
        if (name === 'binding') { f.sub.customer_id = 'cust_other'; f.order.customer_id = 'cust_other'; }
        if (name === 'external_binding') f.sub.customer = { external_id: 'another_user' };
        if (name === 'checkout_binding') {
          await insertCheckout(pool, { userId: 'recon_lost', checkoutId: 'co_wrong_owner', requestId: 'req_wrong_owner' });
          f.order.checkout_id = 'co_wrong_owner';
        }
        const result = await f.run();
        assert.equal(result.reason, name === 'missing' ? 'PROVIDER_SUBSCRIPTION_MISSING' : 'BINDING_CONTRADICTION');
        assert.deepEqual(await financial(f.userId), before);
      }
    });

    await t.test('exception persists through restart, deduplicates, then resolves after unequivocal evidence', async () => {
      const f = await fixture('exception', { local: false });
      provider.subscriptionsByUser.get(f.userId).push(subFixture({ id: 'sub_exception_extra', customerId: f.customerId }));
      const first = await f.run();
      const restarted = createBillingReconciliationService({ pool, adapter: provider.adapter, logger });
      const again = await restarted.reconcileUser({ userId: f.userId, reconciliationId: 'exception:restart', now: new Date(NOW) });
      assert.equal(again.exceptionKey, first.exceptionKey);
      assert.equal((await exceptionRows(pool, f.userId))[0].attempt_count, 2);
      assert.equal((await access(f.userId)).effectivePlanId, 'free');
      provider.subscriptionsByUser.set(f.userId, [f.sub]);
      await f.run('exception:resolved');
      assert.equal((await exceptionRows(pool, f.userId))[0].state, 'RESOLVED');
      assert.equal((await access(f.userId)).effectivePlanId, 'paid_entry');
    });

    await t.test('AMBIGUOUS checkout requires provider evidence and completes only with its bound paid Order', async () => {
      const f = await fixture('ambiguous_checkout', { local: false });
      await insertCheckout(pool, { userId: f.userId, checkoutId: 'co_ambiguous' });
      await pool.query("UPDATE billing_checkout_requests SET state='AMBIGUOUS' WHERE user_id=$1", [f.userId]);
      provider.subscriptionsByUser.set(f.userId, []); provider.ordersByUser.set(f.userId, []);
      assert.equal((await f.run()).reconciled, false);
      assert.equal((await access(f.userId)).effectivePlanId, 'free');
      provider.subscriptionsByUser.set(f.userId, [f.sub]);
      f.order.checkout_id = 'co_ambiguous';
      provider.ordersByUser.set(f.userId, [f.order]);
      await f.run('ambiguous:paid');
      assert.equal((await pool.query('SELECT state FROM billing_checkout_requests WHERE user_id=$1', [f.userId])).rows[0].state, 'COMPLETED');
      assert.equal((await access(f.userId)).effectivePlanId, 'paid_entry');
    });

    await t.test('two reconcile calls serialize provider reads, while a different tenant proceeds independently', async () => {
      const f = await fixture('concurrent', { local: false });
      const other = await fixture('concurrent_other', { local: false, plan: 'highest_paid' });
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { entered = resolve; });
      let reads = 0;
      const adapter = { ...provider.adapter, async listSubscriptionsForUser(input) {
        if (input.userId === f.userId && ++reads === 1) { entered(); await gate; }
        return provider.adapter.listSubscriptionsForUser(input);
      } };
      const concurrent = createBillingReconciliationService({ pool, adapter, logger });
      const first = concurrent.reconcileUser({ userId: f.userId, reconciliationId: 'concurrent:1', now: new Date(NOW) });
      await ready;
      const second = concurrent.reconcileUser({ userId: f.userId, reconciliationId: 'concurrent:2', now: new Date(NOW) });
      try {
        await other.run();
        assert.equal(reads, 1);
        assert.equal((await access(other.userId)).effectivePlanId, 'highest_paid');
      } finally { release(); }
      const results = await Promise.all([first, second]);
      assert.deepEqual(results.map(r => r.repaired), [true, false]);
      assert.equal((await financial(f.userId)).payments.length, 1);
    });

    await t.test('reconciliation and durable webhook share a user lock and converge on the same projection', async () => {
      const f = await fixture('webhook_race');
      f.sub.cancel_at_period_end = true;
      let release, entered;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { entered = resolve; });
      let webhookLookups = 0;
      const adapter = { ...provider.adapter, async listSubscriptionsForUser(input) {
        if (input.userId === f.userId) { entered(); await gate; }
        return provider.adapter.listSubscriptionsForUser(input);
      }, async getSubscription(id) { webhookLookups += 1; return provider.adapter.getSubscription(id); } };
      const racing = createBillingReconciliationService({ pool, adapter, logger });
      const inbox = createDurableWebhookInbox({ pool, adapter, lockTimeoutMs: 2000 });
      await inbox.receive({ rawBody: Buffer.from(JSON.stringify({ type: 'subscription.updated', timestamp: NOW,
        data: { id: f.subscriptionId, customer_id: f.customerId } })),
      headers: { 'webhook-id': 'recon_webhook_race', 'webhook-timestamp': '1789165800', 'webhook-signature': 'v1,fixture' } });
      const reconciliation = racing.reconcileUser({ userId: f.userId, reconciliationId: 'webhook:race', now: new Date(NOW) });
      await ready;
      const event = inbox.processNext({ workerId: 'recon_race_worker', handlers: createBillingLifecycle({ adapter }).handlers });
      try {
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(webhookLookups, 0, 'webhook prepare must wait for the reconciliation lock');
      } finally { release(); }
      await Promise.all([reconciliation, event]);
      assert.equal((await inbox.getEvent('recon_webhook_race')).state, 'PROCESSED');
      assert.equal((await access(f.userId)).billing.cancelAtPeriodEnd, true);
      assert.equal((await access(f.userId)).effectivePlanId, 'paid_entry');
    });

    await t.test('crash before repair commit rolls back all projections; provider failure midway also leaves no partial repair', async () => {
      const f = await fixture('crash', { local: false });
      const lifecycle = createBillingLifecycle({ adapter: provider.adapter });
      const faulty = { ...lifecycle, handlers: { ...lifecycle.handlers,
        'subscription.updated': { async apply(...args) {
          await lifecycle.handlers['subscription.updated'].apply(...args);
          throw Object.assign(new Error('crash fixture SECRET'), { code: 'FIXTURE_CRASH' });
        } },
      } };
      const crashing = createBillingReconciliationService({ pool, adapter: provider.adapter, lifecycle: faulty, logger });
      assert.equal((await crashing.reconcileUser({ userId: f.userId, reconciliationId: 'crash:before', now: new Date(NOW) })).reconciled, false);
      assert.equal((await financial(f.userId)).subscription, null);
      assert.equal((await financial(f.userId)).payments.length, 0);
      assert.equal((await access(f.userId)).effectivePlanId, 'free');
      const outage = createBillingReconciliationService({ pool, logger, adapter: { ...provider.adapter,
        async listOrdersForUser() { throw Object.assign(new Error('SECRET'), { code: 'FIXTURE_MIDWAY_OUTAGE' }); },
      } });
      await assert.rejects(outage.reconcileUser({ userId: f.userId, reconciliationId: 'crash:outage' }), { code: 'BILLING_PROVIDER_UNAVAILABLE' });
      assert.equal((await financial(f.userId)).payments.length, 0);
      await f.run('crash:restart');
      assert.equal((await f.run('crash:after_commit_restart')).repaired, false);
      assert.equal((await access(f.userId)).effectivePlanId, 'paid_entry');
      assert.ok((await exceptionRows(pool, f.userId)).every(row => row.state === 'RESOLVED'));
    });

    await t.test('pending/commercial pages select risk signals, honor cursor/limits and resume after interruption', async () => {
      const selections = [];
      const scanning = createBillingReconciliationService({ pool, logger, adapter: { ...provider.adapter,
        async listSubscriptionsForUser(input) { selections.push(input.userId); return provider.adapter.listSubscriptionsForUser(input); },
      } });
      const completed = await fixture('zz_completed');
      const risk = await fixture('zz_risk'); risk.sub.status = 'unpaid';
      await pool.query("UPDATE billing_subscription_state SET status='unpaid' WHERE user_id=$1", [risk.userId]);
      const failed = await fixture('zz_failed');
      const inbox = createDurableWebhookInbox({ pool, adapter: provider.adapter });
      await inbox.receive({ rawBody: Buffer.from(JSON.stringify({ type: 'subscription.updated', timestamp: NOW,
        data: { id: failed.subscriptionId, customer_id: failed.customerId } })),
      headers: { 'webhook-id': 'recon_sweep_failed', 'webhook-timestamp': '1789165800', 'webhook-signature': 'v1,fixture' } });
      await pool.query("UPDATE billing_webhook_events SET state='FAILED',resolved_user_id=$1 WHERE event_id='recon_sweep_failed'", [failed.userId]);
      const page = await scanning.runPendingSweep({ cursor: 'recon_zz', limit: 1 });
      assert.equal(page.checkedCount, 1);
      assert.equal(page.nextCursor, failed.userId);
      assert.deepEqual(selections, [failed.userId]);
      const next = await scanning.runPendingSweep({ cursor: page.nextCursor, limit: 1 });
      assert.equal(next.checkedCount, 1);
      assert.equal(selections.at(-1), risk.userId);
      assert.equal(selections.includes(completed.userId), false);
      selections.length = 0;
      const interrupted = await scanning.runCommercialSweep({ limit: 3, shouldContinue: () => selections.length < 1 });
      assert.equal(interrupted.checkedCount, 1);
      assert.equal(interrupted.nextCursor, selections[0]);
      const resumed = await scanning.runCommercialSweep({ cursor: interrupted.nextCursor, limit: 2 });
      assert.equal(resumed.checkedCount, 2);
      assert.equal(new Set(selections).size, 3);
      await assert.rejects(scanning.runPendingSweep({ limit: 501 }), { code: 'BILLING_RECONCILIATION_INVALID' });
    });

    await t.test('runtime sweeps repair an isolated PostgreSQL purchase and stop cleanly', async () => {
      const f = await fixture('zz_runtime', { local: false });
      await insertCheckout(pool, { userId: f.userId, checkoutId: 'co_runtime' });
      f.order.checkout_id = 'co_runtime';
      const runtime = createReconciliationRuntime({ pool, adapter: provider.adapter, authority: 'postgres', logger,
        pendingMs: 100, commercialMs: 150, pendingLimit: 50, commercialLimit: 2 });
      runtime.start();
      try {
        const deadline = Date.now() + 4000;
        while (!(await subscriptionState(pool, f.userId)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal((await access(f.userId)).effectivePlanId, 'paid_entry');
      } finally { await runtime.stop(); }
      assert.equal(runtime.status().running, false);
      assert.equal(runtime.status().active, false);
    });

    await t.test('exception snapshots and audit/log output contain only safe fields', async () => {
      const snapshots = (await pool.query('SELECT provider_snapshot,local_snapshot,last_error FROM billing_reconciliation_exceptions')).rows;
      const audits = (await pool.query("SELECT details FROM audit_events WHERE subject_type='billing_user'")).rows;
      const serialized = JSON.stringify({ snapshots, audits, emitted });
      for (const forbidden of ['polar_oat_super_secret','signed.example.invalid','token=secret','SECRET','checkout_url','invoice_number','rawBody']) {
        assert.equal(serialized.includes(forbidden), false, forbidden);
      }
      assert.ok(snapshots.length > 0);
      assert.ok(snapshots.every(row => !('payments' in row.local_snapshot) && !('orders' in row.provider_snapshot)));
      await assert.rejects(reconcileManualUser({ pool, adapter: provider.adapter, userId: 'not_a_beatgaler_user', logger }),
        { code: 'BILLING_RECONCILIATION_USER_UNKNOWN' });
    });
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
