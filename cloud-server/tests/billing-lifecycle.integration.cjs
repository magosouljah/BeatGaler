'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { applyMigrations, listMigrations } = require('../postgres-migrations');
const { createCommercialCatalog } = require('../billing-commercial-catalog');
const { resolveBillingAccess } = require('../billing-access-resolver');
const { createDurableWebhookInbox, DurableWebhookBindingError } = require('../billing-webhook-durable');
const {
  DEFAULT_GRACE_MS,
  createBillingLifecycle,
  createBillingProviderActionWorker,
} = require('../billing-lifecycle');

const ADMIN_URL = process.env.BILLING_LIFECYCLE_TEST_ADMIN_URL || '';

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

function headers(eventId) {
  return {
    'webhook-id': eventId,
    'webhook-timestamp': '1789165800',
    'webhook-signature': 'v1,fixture-signature',
  };
}

function rawEvent({ type, timestamp, data }) {
  return Buffer.from(JSON.stringify({ type, timestamp, data }));
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

function makeProviderHarness() {
  const orders = new Map();
  const subscriptions = new Map();
  const calls = {
    getOrder: [],
    getSubscription: [],
    revoke: [],
    revokeFailures: 0,
  };
  const providerCatalog = catalog();

  return {
    orders,
    subscriptions,
    calls,
    adapter: {
      provider: 'polar',
      environment: 'sandbox',
      catalog: providerCatalog,
      async verifyWebhook({ rawBody }) {
        return JSON.parse(Buffer.from(rawBody).toString('utf8'));
      },
      async getOrder(id) {
        calls.getOrder.push(id);
        if (!orders.has(id)) throw Object.assign(new Error('order missing'), { code: 'FIXTURE_ORDER_MISSING' });
        return clone(orders.get(id));
      },
      async getSubscription(id) {
        calls.getSubscription.push(id);
        if (!subscriptions.has(id)) throw Object.assign(new Error('subscription missing'), { code: 'FIXTURE_SUBSCRIPTION_MISSING' });
        return clone(subscriptions.get(id));
      },
      async revokeSubscription({ subscriptionId }) {
        calls.revoke.push(subscriptionId);
        if (calls.revokeFailures > 0) {
          calls.revokeFailures -= 1;
          throw Object.assign(new Error('temporary provider outage SECRET'), { code: 'POLAR_TEMPORARY_UNAVAILABLE' });
        }
        const current = subscriptions.get(subscriptionId);
        if (current) {
          subscriptions.set(subscriptionId, {
            ...current,
            status: 'canceled',
            cancel_at_period_end: false,
            ended_at: current.ended_at || '2026-12-01T00:00:00.000Z',
          });
        }
        return current ? clone(subscriptions.get(subscriptionId)) : { id: subscriptionId, status: 'canceled' };
      },
    },
  };
}

function subFixture({
  id,
  customerId,
  checkoutId = null,
  plan = 'paid_entry',
  status = 'active',
  start,
  end,
  pastDueAt = null,
  cancelAtPeriodEnd = false,
  endedAt = null,
  pendingPlan = null,
  pendingAt = null,
}) {
  const high = plan === 'highest_paid';
  const pendingHigh = pendingPlan === 'highest_paid';
  const pendingPaid = pendingPlan === 'paid_entry';
  return {
    id,
    customer_id: customerId,
    checkout_id: checkoutId,
    product_id: high ? 'prod_high' : 'prod_paid',
    price_id: high ? 'price_high' : 'price_paid',
    prices: [{ id: high ? 'price_high' : 'price_paid' }],
    amount: high ? 1199 : 699,
    currency: 'usd',
    recurring_interval: 'month',
    recurring_interval_count: 1,
    status,
    current_period_start: start,
    current_period_end: end,
    past_due_at: pastDueAt,
    cancel_at_period_end: cancelAtPeriodEnd,
    ended_at: endedAt,
    ends_at: endedAt,
    pending_update: pendingPlan ? {
      id: `pending_${id}`,
      applies_at: pendingAt,
      product_id: pendingHigh ? 'prod_high' : (pendingPaid ? 'prod_paid' : null),
    } : null,
  };
}

function orderFixture({
  id,
  customerId,
  subscriptionId,
  checkoutId = null,
  plan = 'paid_entry',
  start,
  end,
  billingReason = 'subscription_create',
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
    billing_reason: billingReason,
    invoice_number: `INV-${id}`,
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

async function insertCheckout(pool, {
  userId,
  requestId,
  offerId,
  checkoutId,
}) {
  await pool.query(`
    INSERT INTO billing_checkout_requests(
      user_id,request_id,offer_id,request_hash_sha256,provider,provider_environment,state,
      provider_checkout_id,checkout_url,expires_at
    ) VALUES ($1,$2,$3,$4,'polar','sandbox','OPEN',$5,$6,now()+interval '1 day')
  `, [
    userId,
    requestId,
    offerId,
    'a'.repeat(64),
    checkoutId,
    `https://sandbox.polar.sh/checkout/${checkoutId}`,
  ]);
}

async function state(pool, userId) {
  return (await pool.query(
    'SELECT * FROM billing_subscription_state WHERE user_id=$1',
    [userId],
  )).rows[0] || null;
}

async function access(pool, userId, now) {
  const subscription = await state(pool, userId);
  const grants = (await pool.query('SELECT * FROM entitlements WHERE user_id=$1', [userId])).rows;
  return resolveBillingAccess({ subscription, grants, now });
}

test('Billing V1 durable lifecycle projects paid coverage, grace, plan changes and refunds in PostgreSQL', { skip: !ADMIN_URL }, async t => {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const dbName = `beatgaler_lifecycle_v1_${suffix}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const admin = new Client({ connectionString: ADMIN_URL });
  let pool = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
    pool = new Pool({ connectionString: databaseUrl(ADMIN_URL, dbName), max: 8 });
    await applyMigrations(pool, listMigrations());

    await pool.query(`
      INSERT INTO users(id,email) VALUES
        ('life_u1','life1@example.invalid'),
        ('life_u2','life2@example.invalid'),
        ('life_u3','life3@example.invalid'),
        ('life_u4','life4@example.invalid'),
        ('life_u5','life5@example.invalid')
    `);

    const provider = makeProviderHarness();
    const inbox = createDurableWebhookInbox({
      pool,
      adapter: provider.adapter,
      leaseMs: 2_000,
      lockTimeoutMs: 200,
      retryBaseMs: 5,
      retryMaxMs: 5,
      maxAttempts: 5,
    });
    const lifecycle = createBillingLifecycle({ adapter: provider.adapter });

    async function receiveOnly({ eventId, type, timestamp, data }) {
      return inbox.receive({
        rawBody: rawEvent({ type, timestamp, data }),
        headers: headers(eventId),
      });
    }

    async function deliver({ eventId, type, timestamp, data, handlers = lifecycle.handlers }) {
      await receiveOnly({ eventId, type, timestamp, data });
      return inbox.processNext({ workerId: `worker_${eventId}`, handlers });
    }

    const S0 = '2026-09-11T00:00:00.000Z';
    const S1 = '2026-10-11T00:00:00.000Z';
    const S2 = '2026-11-11T00:00:00.000Z';
    const S3 = '2026-12-11T00:00:00.000Z';

    await t.test('confirmed initial Paid Entry order is the first event that grants commercial access', async () => {
      await insertCheckout(pool, {
        userId: 'life_u1',
        requestId: 'req_life_u1',
        offerId: 'paid_entry_monthly_v1',
        checkoutId: 'co_life_u1',
      });
      provider.subscriptions.set('sub_life_u1', subFixture({
        id: 'sub_life_u1',
        customerId: 'cus_life_u1',
        checkoutId: 'co_life_u1',
        plan: 'paid_entry',
        start: S0,
        end: S1,
      }));
      provider.orders.set('order_life_u1_1', orderFixture({
        id: 'order_life_u1_1',
        customerId: 'cus_life_u1',
        subscriptionId: 'sub_life_u1',
        checkoutId: 'co_life_u1',
        plan: 'paid_entry',
        start: S0,
        end: S1,
      }));

      const received = await receiveOnly({
        eventId: 'evt_life_u1_paid_1',
        type: 'order.paid',
        timestamp: '2026-09-11T00:00:05.000Z',
        data: {
          id: 'order_life_u1_1',
          customer_id: 'cus_life_u1',
          subscription_id: 'sub_life_u1',
          checkout_id: 'co_life_u1',
          status: 'paid',
        },
      });
      assert.equal(received.entitlementGranted, false);
      assert.equal((await access(pool, 'life_u1', '2026-09-11T00:00:06.000Z')).effectivePlanId, 'free');

      const processed = await inbox.processNext({ workerId: 'worker_life_initial', handlers: lifecycle.handlers });
      assert.equal(processed.state, 'PROCESSED');
      assert.equal((await access(pool, 'life_u1', '2026-09-12T00:00:00.000Z')).effectivePlanId, 'paid_entry');

      const projected = await state(pool, 'life_u1');
      assert.equal(projected.plan_id, 'paid_entry');
      assert.equal(new Date(projected.paid_through).toISOString(), S1);
      assert.equal(projected.past_due_at, null);
      assert.equal(projected.grace_until, null);
      const checkout = (await pool.query(
        "SELECT state FROM billing_checkout_requests WHERE user_id='life_u1' AND request_id='req_life_u1'",
      )).rows[0];
      assert.equal(checkout.state, 'COMPLETED');
    });

    await t.test('duplicate delivery is idempotent and cannot extend coverage twice', async () => {
      const raw = rawEvent({
        type: 'order.paid',
        timestamp: '2026-09-11T00:00:05.000Z',
        data: {
          id: 'order_life_u1_1',
          customer_id: 'cus_life_u1',
          subscription_id: 'sub_life_u1',
          checkout_id: 'co_life_u1',
          status: 'paid',
        },
      });
      const duplicate = await inbox.receive({ rawBody: raw, headers: headers('evt_life_u1_paid_1') });
      assert.equal(duplicate.duplicate, true);
      assert.equal(duplicate.state, 'PROCESSED');
      assert.equal(await inbox.processNext({ workerId: 'worker_no_duplicate', handlers: lifecycle.handlers }), null);
      assert.equal(new Date((await state(pool, 'life_u1')).paid_through).toISOString(), S1);
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM billing_payments WHERE user_id='life_u1'",
      )).rows[0].count, 1);
    });

    await t.test('normal cancellation keeps access through paid_through and uncancel restores renewal intent', async () => {
      provider.subscriptions.set('sub_life_u1', subFixture({
        id: 'sub_life_u1',
        customerId: 'cus_life_u1',
        plan: 'paid_entry',
        status: 'active',
        start: S0,
        end: S1,
        cancelAtPeriodEnd: true,
      }));
      await deliver({
        eventId: 'evt_life_cancel',
        type: 'subscription.canceled',
        timestamp: '2026-09-20T00:00:00.000Z',
        data: { id: 'sub_life_u1', customer_id: 'cus_life_u1', status: 'active' },
      });
      assert.equal((await state(pool, 'life_u1')).cancel_at_period_end, true);
      assert.equal((await access(pool, 'life_u1', '2026-10-10T23:59:59.000Z')).effectivePlanId, 'paid_entry');
      assert.equal((await access(pool, 'life_u1', S1)).effectivePlanId, 'free');

      provider.subscriptions.set('sub_life_u1', {
        ...provider.subscriptions.get('sub_life_u1'),
        cancel_at_period_end: false,
      });
      await deliver({
        eventId: 'evt_life_uncancel',
        type: 'subscription.uncanceled',
        timestamp: '2026-09-21T00:00:00.000Z',
        data: { id: 'sub_life_u1', customer_id: 'cus_life_u1', status: 'active' },
      });
      assert.equal((await state(pool, 'life_u1')).cancel_at_period_end, false);
    });

    await t.test('pending upgrade is next-period metadata only; failed renewal gives seven-day grace on old tier', async () => {
      provider.subscriptions.set('sub_life_u1', subFixture({
        id: 'sub_life_u1',
        customerId: 'cus_life_u1',
        plan: 'paid_entry',
        status: 'active',
        start: S0,
        end: S1,
        pendingPlan: 'highest_paid',
        pendingAt: S1,
      }));
      await deliver({
        eventId: 'evt_life_upgrade_pending',
        type: 'subscription.updated',
        timestamp: '2026-09-22T00:00:00.000Z',
        data: { id: 'sub_life_u1', customer_id: 'cus_life_u1', status: 'active' },
      });
      let projected = await state(pool, 'life_u1');
      assert.equal(projected.plan_id, 'paid_entry');
      assert.equal(projected.next_plan_id, 'highest_paid');
      assert.equal(new Date(projected.next_plan_effective_at).toISOString(), S1);

      provider.subscriptions.set('sub_life_u1', subFixture({
        id: 'sub_life_u1',
        customerId: 'cus_life_u1',
        plan: 'highest_paid',
        status: 'past_due',
        start: S1,
        end: S2,
        pastDueAt: S1,
      }));
      await deliver({
        eventId: 'evt_life_renewal_failed',
        type: 'subscription.updated',
        timestamp: '2026-10-11T00:00:10.000Z',
        data: {
          id: 'sub_life_u1',
          customer_id: 'cus_life_u1',
          status: 'past_due',
        },
      });
      projected = await state(pool, 'life_u1');
      assert.equal(projected.plan_id, 'paid_entry', 'failed upgrade must not grant Highest');
      assert.equal(projected.next_plan_id, 'highest_paid');
      assert.equal(new Date(projected.past_due_at).toISOString(), S1);
      assert.equal(
        new Date(projected.grace_until).getTime() - new Date(projected.past_due_at).getTime(),
        DEFAULT_GRACE_MS,
      );
      const inGrace = await access(pool, 'life_u1', '2026-10-12T00:00:00.000Z');
      assert.equal(inGrace.effectivePlanId, 'paid_entry');
      assert.equal(inGrace.commercialAccessState, 'grace');
      assert.equal((await access(pool, 'life_u1', '2026-10-18T00:00:00.001Z')).effectivePlanId, 'free');

      await deliver({
        eventId: 'evt_life_renewal_retry',
        type: 'subscription.updated',
        timestamp: '2026-10-13T00:00:00.000Z',
        data: {
          id: 'sub_life_u1',
          customer_id: 'cus_life_u1',
          status: 'past_due',
        },
      });
      const retryState = await state(pool, 'life_u1');
      assert.equal(new Date(retryState.past_due_at).toISOString(), S1);
      assert.equal(new Date(retryState.grace_until).toISOString(), new Date(new Date(S1).getTime() + DEFAULT_GRACE_MS).toISOString());
    });

    await t.test('confirmed recovery payment activates Highest and clears grace only after financial confirmation', async () => {
      provider.orders.set('order_life_u1_2', orderFixture({
        id: 'order_life_u1_2',
        customerId: 'cus_life_u1',
        subscriptionId: 'sub_life_u1',
        plan: 'highest_paid',
        start: S1,
        end: S2,
        billingReason: 'subscription_cycle',
      }));
      await deliver({
        eventId: 'evt_life_recovery_paid',
        type: 'order.paid',
        timestamp: '2026-10-13T01:00:00.000Z',
        data: {
          id: 'order_life_u1_2',
          customer_id: 'cus_life_u1',
          subscription_id: 'sub_life_u1',
          status: 'paid',
        },
      });
      const projected = await state(pool, 'life_u1');
      assert.equal(projected.plan_id, 'highest_paid');
      assert.equal(new Date(projected.paid_through).toISOString(), S2);
      assert.equal(projected.past_due_at, null);
      assert.equal(projected.grace_until, null);
      assert.equal(projected.next_plan_id, null);
      assert.equal((await access(pool, 'life_u1', '2026-10-14T00:00:00.000Z')).effectivePlanId, 'highest_paid');
    });

    await t.test('downgrade is projected for next period and activates only on the next paid order', async () => {
      provider.subscriptions.set('sub_life_u1', subFixture({
        id: 'sub_life_u1',
        customerId: 'cus_life_u1',
        plan: 'highest_paid',
        status: 'active',
        start: S1,
        end: S2,
        pendingPlan: 'paid_entry',
        pendingAt: S2,
      }));
      await deliver({
        eventId: 'evt_life_downgrade_pending',
        type: 'subscription.updated',
        timestamp: '2026-10-20T00:00:00.000Z',
        data: { id: 'sub_life_u1', customer_id: 'cus_life_u1', status: 'active' },
      });
      assert.equal((await state(pool, 'life_u1')).next_plan_id, 'paid_entry');
      assert.equal((await access(pool, 'life_u1', '2026-11-10T00:00:00.000Z')).effectivePlanId, 'highest_paid');

      provider.subscriptions.set('sub_life_u1', subFixture({
        id: 'sub_life_u1',
        customerId: 'cus_life_u1',
        plan: 'paid_entry',
        status: 'active',
        start: S2,
        end: S3,
      }));
      provider.orders.set('order_life_u1_3', orderFixture({
        id: 'order_life_u1_3',
        customerId: 'cus_life_u1',
        subscriptionId: 'sub_life_u1',
        plan: 'paid_entry',
        start: S2,
        end: S3,
        billingReason: 'subscription_cycle',
      }));
      await deliver({
        eventId: 'evt_life_downgrade_paid',
        type: 'order.paid',
        timestamp: '2026-11-11T00:00:05.000Z',
        data: {
          id: 'order_life_u1_3',
          customer_id: 'cus_life_u1',
          subscription_id: 'sub_life_u1',
          status: 'paid',
        },
      });
      const projected = await state(pool, 'life_u1');
      assert.equal(projected.plan_id, 'paid_entry');
      assert.equal(new Date(projected.paid_through).toISOString(), S3);
      assert.equal(projected.next_plan_id, null);
    });

    await t.test('partial refund keeps access, historical full refund stays historical, current full refund invalidates and queues durable revoke', async () => {
      provider.orders.set('order_life_u1_3', {
        ...provider.orders.get('order_life_u1_3'),
        refunded_amount: 300,
        status: 'paid',
        paid: true,
      });
      await deliver({
        eventId: 'evt_life_partial_refund',
        type: 'order.refunded',
        timestamp: '2026-11-20T00:00:00.000Z',
        data: {
          id: 'order_life_u1_3',
          customer_id: 'cus_life_u1',
          subscription_id: 'sub_life_u1',
          status: 'paid',
          refunded_amount: 300,
        },
      });
      assert.equal((await access(pool, 'life_u1', '2026-11-21T00:00:00.000Z')).effectivePlanId, 'paid_entry');
      let payment = (await pool.query(
        "SELECT status,refunded_amount_minor FROM billing_payments WHERE provider_order_id='order_life_u1_3'",
      )).rows[0];
      assert.equal(payment.status, 'partially_refunded');
      assert.equal(Number(payment.refunded_amount_minor), 300);

      provider.orders.set('order_life_u1_2', {
        ...provider.orders.get('order_life_u1_2'),
        refunded_amount: 1199,
        status: 'refunded',
        paid: true,
      });
      await deliver({
        eventId: 'evt_life_historical_full_refund',
        type: 'order.refunded',
        timestamp: '2026-11-22T00:00:00.000Z',
        data: {
          id: 'order_life_u1_2',
          customer_id: 'cus_life_u1',
          subscription_id: 'sub_life_u1',
          status: 'refunded',
          refunded_amount: 1199,
        },
      });
      assert.equal((await state(pool, 'life_u1')).access_invalidated_at, null);
      assert.equal((await access(pool, 'life_u1', '2026-11-23T00:00:00.000Z')).effectivePlanId, 'paid_entry');

      provider.orders.set('order_life_u1_3', {
        ...provider.orders.get('order_life_u1_3'),
        refunded_amount: 699,
        status: 'refunded',
        paid: true,
      });
      await deliver({
        eventId: 'evt_life_current_full_refund',
        type: 'order.refunded',
        timestamp: '2026-11-24T00:00:00.000Z',
        data: {
          id: 'order_life_u1_3',
          customer_id: 'cus_life_u1',
          subscription_id: 'sub_life_u1',
          status: 'refunded',
          refunded_amount: 699,
        },
      });
      const invalidated = await state(pool, 'life_u1');
      assert.ok(invalidated.access_invalidated_at);
      assert.equal(invalidated.invalidation_reason, 'FULL_REFUND_CURRENT_PERIOD');
      assert.equal((await access(pool, 'life_u1', '2026-11-24T00:00:01.000Z')).effectivePlanId, 'free');
      const action = (await pool.query(
        "SELECT * FROM billing_provider_actions WHERE user_id='life_u1' AND action_type='REVOKE_SUBSCRIPTION'",
      )).rows[0];
      assert.equal(action.state, 'PENDING');
      assert.equal(action.provider_subscription_id, 'sub_life_u1');

      payment = (await pool.query(
        "SELECT status,invalidated_at FROM billing_payments WHERE provider_order_id='order_life_u1_3'",
      )).rows[0];
      assert.equal(payment.status, 'refunded');
      assert.ok(payment.invalidated_at);
    });

    await t.test('old paid event after refund cannot reactivate an invalidated period', async () => {
      await deliver({
        eventId: 'evt_life_old_paid_after_refund',
        type: 'order.paid',
        timestamp: '2026-11-11T00:00:06.000Z',
        data: {
          id: 'order_life_u1_3',
          customer_id: 'cus_life_u1',
          subscription_id: 'sub_life_u1',
          status: 'paid',
        },
      });
      const projected = await state(pool, 'life_u1');
      assert.ok(projected.access_invalidated_at);
      assert.equal((await access(pool, 'life_u1', '2026-11-25T00:00:00.000Z')).effectivePlanId, 'free');
      assert.equal((await pool.query(
        "SELECT count(*)::int AS count FROM billing_provider_actions WHERE user_id='life_u1'",
      )).rows[0].count, 1);
    });

    await t.test('durable revoke action retries without losing the local refund decision', async () => {
      provider.calls.revokeFailures = 1;
      const worker = createBillingProviderActionWorker({
        pool,
        adapter: provider.adapter,
        retryBaseMs: 5,
        retryMaxMs: 5,
        maxAttempts: 3,
      });
      await assert.rejects(
        worker.processNext({ workerId: 'action_worker_a' }),
        error => error.code === 'POLAR_TEMPORARY_UNAVAILABLE',
      );
      let action = (await pool.query(
        "SELECT state,last_error_code FROM billing_provider_actions WHERE user_id='life_u1'",
      )).rows[0];
      assert.equal(action.state, 'FAILED');
      assert.equal(action.last_error_code, 'POLAR_TEMPORARY_UNAVAILABLE');
      assert.ok((await state(pool, 'life_u1')).access_invalidated_at);

      await pool.query(
        "UPDATE billing_provider_actions SET next_attempt_at=now()-interval '1 second' WHERE user_id='life_u1'",
      );
      action = await worker.processNext({ workerId: 'action_worker_b' });
      assert.equal(action.state, 'SUCCEEDED');
      assert.equal(provider.calls.revoke.filter(id => id === 'sub_life_u1').length, 2);
    });

    await t.test('initial Highest purchase is confirmed independently', async () => {
      await insertCheckout(pool, {
        userId: 'life_u2',
        requestId: 'req_life_u2',
        offerId: 'highest_paid_monthly_v1',
        checkoutId: 'co_life_u2',
      });
      provider.subscriptions.set('sub_life_u2', subFixture({
        id: 'sub_life_u2',
        customerId: 'cus_life_u2',
        checkoutId: 'co_life_u2',
        plan: 'highest_paid',
        start: S0,
        end: S1,
      }));
      provider.orders.set('order_life_u2_1', orderFixture({
        id: 'order_life_u2_1',
        customerId: 'cus_life_u2',
        subscriptionId: 'sub_life_u2',
        checkoutId: 'co_life_u2',
        plan: 'highest_paid',
        start: S0,
        end: S1,
      }));
      await deliver({
        eventId: 'evt_life_u2_paid',
        type: 'order.paid',
        timestamp: '2026-09-11T02:00:00.000Z',
        data: {
          id: 'order_life_u2_1',
          customer_id: 'cus_life_u2',
          subscription_id: 'sub_life_u2',
          checkout_id: 'co_life_u2',
          status: 'paid',
        },
      });
      assert.equal((await access(pool, 'life_u2', '2026-09-12T00:00:00.000Z')).effectivePlanId, 'highest_paid');
    });

    await t.test('first purchase failure remains Free and receives no renewal grace', async () => {
      await insertCheckout(pool, {
        userId: 'life_u3',
        requestId: 'req_life_u3',
        offerId: 'paid_entry_monthly_v1',
        checkoutId: 'co_life_u3',
      });
      provider.subscriptions.set('sub_life_u3', subFixture({
        id: 'sub_life_u3',
        customerId: 'cus_life_u3',
        checkoutId: 'co_life_u3',
        plan: 'paid_entry',
        status: 'past_due',
        start: S0,
        end: S1,
        pastDueAt: S0,
      }));
      await deliver({
        eventId: 'evt_life_u3_failed_first',
        type: 'subscription.updated',
        timestamp: '2026-09-11T03:00:00.000Z',
        data: {
          id: 'sub_life_u3',
          customer_id: 'cus_life_u3',
          checkout_id: 'co_life_u3',
          status: 'past_due',
        },
      });
      const projected = await state(pool, 'life_u3');
      assert.equal(projected.plan_id, 'paid_entry');
      assert.equal(projected.paid_through, null);
      assert.equal(projected.grace_until, null);
      const resolved = await access(pool, 'life_u3', '2026-09-12T00:00:00.000Z');
      assert.equal(resolved.effectivePlanId, 'free');
      assert.equal(resolved.commercialAccessState, 'unverified');
      assert.equal((await pool.query(
        "SELECT state FROM billing_checkout_requests WHERE user_id='life_u3'",
      )).rows[0].state, 'OPEN');
    });

    await t.test('failure after prepare rolls back local projection and restart/retry re-prepares safely', async () => {
      provider.subscriptions.set('sub_life_u2', {
        ...provider.subscriptions.get('sub_life_u2'),
        cancel_at_period_end: true,
      });
      const baseHandler = lifecycle.handlers['subscription.updated'];
      let failApply = true;
      const faultingHandler = {
        prepare: baseHandler.prepare,
        async apply(client, context, prepared) {
          if (failApply) {
            failApply = false;
            throw Object.assign(new Error('local apply crash'), { code: 'FIXTURE_LOCAL_APPLY_CRASH' });
          }
          return baseHandler.apply(client, context, prepared);
        },
      };
      await receiveOnly({
        eventId: 'evt_life_apply_crash',
        type: 'subscription.updated',
        timestamp: '2026-09-25T00:00:00.000Z',
        data: { id: 'sub_life_u2', customer_id: 'cus_life_u2', status: 'active' },
      });
      await assert.rejects(
        inbox.processNext({
          workerId: 'worker_apply_crash',
          handlers: { ...lifecycle.handlers, 'subscription.updated': faultingHandler },
        }),
        error => error.code === 'FIXTURE_LOCAL_APPLY_CRASH',
      );
      assert.equal((await state(pool, 'life_u2')).cancel_at_period_end, false);
      assert.equal((await inbox.getEvent('evt_life_apply_crash')).state, 'FAILED');

      await inbox.requeueFailed('evt_life_apply_crash');
      const recovered = await inbox.processNext({
        workerId: 'worker_apply_recovered',
        handlers: lifecycle.handlers,
      });
      assert.equal(recovered.state, 'PROCESSED');
      assert.equal((await state(pool, 'life_u2')).cancel_at_period_end, true);
    });

    await t.test('trusted binding conflict still fails closed before lifecycle mutation', async () => {
      await pool.query(`
        INSERT INTO billing_customers(
          id,user_id,provider,provider_environment,provider_customer_id,external_id
        ) VALUES ('conflict_customer','life_u4','polar','sandbox','cus_conflict','life_u4')
      `);
      await pool.query(`
        INSERT INTO billing_subscription_state(
          user_id,provider,provider_environment,provider_subscription_id,plan_id,status
        ) VALUES ('life_u5','polar','sandbox','sub_conflict','free','inactive')
      `);
      provider.subscriptions.set('sub_conflict', subFixture({
        id: 'sub_conflict',
        customerId: 'cus_conflict',
        plan: 'paid_entry',
        status: 'active',
        start: S0,
        end: S1,
      }));
      await receiveOnly({
        eventId: 'evt_life_binding_conflict',
        type: 'subscription.updated',
        timestamp: '2026-09-26T00:00:00.000Z',
        data: {
          id: 'sub_conflict',
          customer_id: 'cus_conflict',
          status: 'active',
        },
      });
      await assert.rejects(
        inbox.processNext({ workerId: 'worker_binding_conflict', handlers: lifecycle.handlers }),
        error => error instanceof DurableWebhookBindingError && error.code === 'WEBHOOK_BINDING_CONFLICT',
      );
      assert.equal((await inbox.getEvent('evt_life_binding_conflict')).state, 'FAILED');
    });
  } finally {
    if (pool) await pool.end().catch(() => {});
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()',
      [dbName],
    ).catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(dbName)}`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
