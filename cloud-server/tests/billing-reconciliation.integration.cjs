'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { applyMigrations, listMigrations } = require('../postgres-migrations');
const { createCommercialCatalog } = require('../billing-commercial-catalog');
const { createBillingSafeLogger } = require('../billing-safe-log');
const { createBillingReconciliationService, BillingReconciliationError } = require('../billing-reconciliation');

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
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)} WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
