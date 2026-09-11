'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { applyMigrations, listMigrations } = require('../postgres-migrations');
const {
  PersistentCheckoutError,
  checkoutRequestHash,
  createPersistentCheckoutService,
} = require('../billing-checkout-persistent');

const ADMIN_URL = process.env.BILLING_CHECKOUT_TEST_ADMIN_URL || '';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function databaseUrl(adminUrl, databaseName) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function adapterHarness({
  createDelayMs = 0,
  createError = null,
  offerError = null,
} = {}) {
  const calls = [];
  return {
    calls,
    adapter: {
      provider: 'polar',
      environment: 'sandbox',
      getCheckoutOffer(offerId) {
        if (offerError) throw offerError;
        if (!['paid_entry_monthly_v1', 'highest_paid_monthly_v1'].includes(offerId)) {
          const error = new Error('unknown offer');
          error.code = offerId.endsWith('_annual_v1') ? 'BILLING_OFFER_DISABLED' : 'BILLING_OFFER_UNKNOWN';
          throw error;
        }
        return Object.freeze({
          id: offerId,
          planId: offerId.startsWith('highest') ? 'highest_paid' : 'paid_entry',
        });
      },
      async createCheckout(input) {
        calls.push(input);
        if (createDelayMs) await delay(createDelayMs);
        if (createError) throw createError;
        return {
          id: `polar_checkout_${calls.length}`,
          url: `https://sandbox.polar.test/checkout/${calls.length}`,
        };
      },
      async getCustomerByExternalId(userId) {
        return { id: `polar_customer_${userId}` };
      },
    },
  };
}

function makeService(pool, adapter, options = {}) {
  return createPersistentCheckoutService({
    pool,
    adapter,
    allowedCallbackOrigins: ['https://app.beatgaler.test'],
    providerCallTimeoutMs: options.providerCallTimeoutMs || 500,
  });
}

const callbacks = Object.freeze({
  successUrl: 'https://app.beatgaler.test/billing/success',
  returnUrl: 'https://app.beatgaler.test/settings/billing',
});

function checkoutInput(userId, requestId, offerId = 'paid_entry_monthly_v1') {
  return {
    user: { id: userId, email: `${userId}@example.invalid` },
    request: { requestId, offerId },
    ...callbacks,
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error instanceof PersistentCheckoutError, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('persistent checkout is cross-process idempotent and fail-closed in PostgreSQL', { skip: !ADMIN_URL }, async t => {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const dbName = `beatgaler_checkout_v1_${suffix}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const admin = new Client({ connectionString: ADMIN_URL });
  let pool = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
    pool = new Pool({ connectionString: databaseUrl(ADMIN_URL, dbName), max: 8 });
    await applyMigrations(pool, listMigrations());

    let userCounter = 0;
    async function newUser(prefix) {
      userCounter += 1;
      const id = `${prefix}_${userCounter}`;
      await pool.query('INSERT INTO users(id,email) VALUES ($1,$2)', [id, `${id}@example.invalid`]);
      return id;
    }

    await t.test('double-click with the same requestId creates one provider checkout', async () => {
      const userId = await newUser('double_click');
      const h = adapterHarness({ createDelayMs: 40 });
      const service = makeService(pool, h.adapter);
      const input = checkoutInput(userId, 'request_same_001');

      const [a, b] = await Promise.all([
        service.createSession(input),
        service.createSession(input),
      ]);

      assert.equal(h.calls.length, 1);
      assert.equal(a.checkoutId, b.checkoutId);
      assert.equal(a.url, b.url);
      assert.deepEqual(new Set([a.recovered, b.recovered]), new Set([false, true]));

      const rows = await pool.query(
        'SELECT state,provider_checkout_id,checkout_url FROM billing_checkout_requests WHERE user_id=$1',
        [userId],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].state, 'OPEN');
      assert.equal(rows.rows[0].provider_checkout_id, a.checkoutId);
    });

    await t.test('two tabs with different requestIds cannot expose two unresolved checkouts', async () => {
      const userId = await newUser('two_tabs');
      const h = adapterHarness({ createDelayMs: 40 });
      const service = makeService(pool, h.adapter);

      const first = service.createSession(checkoutInput(userId, 'request_tab_001'));
      await delay(5);
      const second = service.createSession(checkoutInput(userId, 'request_tab_002'));

      const firstResult = await first;
      assert.equal(firstResult.state, 'OPEN');
      await expectCode(second, 'BILLING_CHECKOUT_UNRESOLVED_EXISTS');
      assert.equal(h.calls.length, 1);
    });

    await t.test('identical retry returns the durable OPEN result without a provider retry', async () => {
      const userId = await newUser('retry');
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      const input = checkoutInput(userId, 'request_retry_001');

      const first = await service.createSession(input);
      const second = await service.createSession(input);

      assert.equal(h.calls.length, 1);
      assert.equal(second.recovered, true);
      assert.equal(second.checkoutId, first.checkoutId);
      assert.equal(second.url, first.url);
      assert.equal(second.entitlementGranted, false);
    });

    await t.test('same requestId with altered offer is rejected', async () => {
      const userId = await newUser('altered');
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);

      await service.createSession(checkoutInput(userId, 'request_altered_001'));
      await expectCode(
        service.createSession(checkoutInput(userId, 'request_altered_001', 'highest_paid_monthly_v1')),
        'BILLING_CHECKOUT_REQUEST_CONFLICT',
      );
      assert.equal(h.calls.length, 1);
    });

    await t.test('timeout after provider call begins becomes AMBIGUOUS and blocks a second checkout', async () => {
      const userId = await newUser('timeout');
      const h = adapterHarness({ createDelayMs: 80 });
      const service = makeService(pool, h.adapter, { providerCallTimeoutMs: 10 });

      await expectCode(
        service.createSession(checkoutInput(userId, 'request_timeout_001')),
        'BILLING_CHECKOUT_AMBIGUOUS',
      );

      const row = await pool.query(
        'SELECT state,last_error_code FROM billing_checkout_requests WHERE user_id=$1 AND request_id=$2',
        [userId, 'request_timeout_001'],
      );
      assert.equal(row.rows[0].state, 'AMBIGUOUS');
      assert.equal(row.rows[0].last_error_code, 'BILLING_CHECKOUT_PROVIDER_TIMEOUT');

      await expectCode(
        service.createSession(checkoutInput(userId, 'request_timeout_002')),
        'BILLING_CHECKOUT_UNRESOLVED_EXISTS',
      );
      assert.equal(h.calls.length, 1);
      await delay(90);
    });

    await t.test('definitive pre-create provider failure becomes FAILED, not AMBIGUOUS', async () => {
      const userId = await newUser('precreate_failure');
      const error = new Error('product lookup unavailable');
      error.code = 'POLAR_SANDBOX_PRODUCT_GET_FAILED';
      const h = adapterHarness({ createError: error });
      const service = makeService(pool, h.adapter);

      await expectCode(
        service.createSession(checkoutInput(userId, 'request_precreate_001')),
        'BILLING_CHECKOUT_PROVIDER_REJECTED',
      );

      const row = await pool.query(
        'SELECT state,last_error_code FROM billing_checkout_requests WHERE user_id=$1 AND request_id=$2',
        [userId, 'request_precreate_001'],
      );
      assert.deepEqual(row.rows[0], {
        state: 'FAILED',
        last_error_code: 'POLAR_SANDBOX_PRODUCT_GET_FAILED',
      });
    });

    await t.test('restart recovers OPEN from PostgreSQL without calling provider again', async () => {
      const userId = await newUser('restart_open');
      const firstHarness = adapterHarness();
      const firstService = makeService(pool, firstHarness.adapter);
      const input = checkoutInput(userId, 'request_restart_001');
      const created = await firstService.createSession(input);
      assert.equal(firstHarness.calls.length, 1);

      const secondHarness = adapterHarness();
      const restartedService = makeService(pool, secondHarness.adapter);
      const recovered = await restartedService.createSession(input);

      assert.equal(secondHarness.calls.length, 0);
      assert.equal(recovered.recovered, true);
      assert.equal(recovered.checkoutId, created.checkoutId);
    });

    await t.test('restart from CREATING becomes AMBIGUOUS instead of blindly recreating', async () => {
      const userId = await newUser('restart_creating');
      const requestId = 'request_crash_001';
      const hash = checkoutRequestHash({
        offerId: 'paid_entry_monthly_v1',
        ...callbacks,
      });
      await pool.query(`
        INSERT INTO billing_checkout_requests(
          user_id,request_id,offer_id,request_hash_sha256,provider,provider_environment,state
        ) VALUES ($1,$2,'paid_entry_monthly_v1',$3,'polar','sandbox','CREATING')
      `, [userId, requestId, hash]);

      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      await expectCode(
        service.createSession(checkoutInput(userId, requestId)),
        'BILLING_CHECKOUT_AMBIGUOUS',
      );
      assert.equal(h.calls.length, 0);

      const row = await pool.query(
        'SELECT state,last_error_code FROM billing_checkout_requests WHERE user_id=$1 AND request_id=$2',
        [userId, requestId],
      );
      assert.deepEqual(row.rows[0], {
        state: 'AMBIGUOUS',
        last_error_code: 'BILLING_CHECKOUT_RECOVERED_CREATING',
      });
    });

    await t.test('customer row bound to another external identity is rejected before provider call', async () => {
      const userId = await newUser('customer_owner');
      await pool.query(`
        INSERT INTO billing_customers(
          id,user_id,provider,provider_environment,provider_customer_id,external_id
        ) VALUES ($1,$2,'polar','sandbox',$3,$4)
      `, [`row_${userId}`, userId, `polar_customer_${userId}`, 'different_beatgaler_user']);

      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      await expectCode(
        service.createSession(checkoutInput(userId, 'request_owner_001')),
        'BILLING_CHECKOUT_CUSTOMER_OWNERSHIP_MISMATCH',
      );
      assert.equal(h.calls.length, 0);
    });

    await t.test('disabled/unknown offer fails before persistence or provider call', async () => {
      const userId = await newUser('offer');
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);

      await expectCode(
        service.createSession(checkoutInput(userId, 'request_offer_001', 'paid_entry_annual_v1')),
        'BILLING_OFFER_DISABLED',
      );
      assert.equal(h.calls.length, 0);

      const count = await pool.query(
        'SELECT count(*)::int AS count FROM billing_checkout_requests WHERE user_id=$1',
        [userId],
      );
      assert.equal(count.rows[0].count, 0);
    });

    await t.test('existing live subscriber must use portal instead of another subscription checkout', async () => {
      const userId = await newUser('subscriber');
      await pool.query(`
        INSERT INTO billing_subscription_state(
          user_id,provider,provider_environment,provider_subscription_id,offer_id,
          plan_id,status,current_period_start,current_period_end,paid_through
        ) VALUES (
          $1,'polar','sandbox',$2,'paid_entry_monthly_v1',
          'paid_entry','active',now(),now()+interval '30 days',now()+interval '30 days'
        )
      `, [userId, `polar_sub_${userId}`]);

      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      await expectCode(
        service.createSession(checkoutInput(userId, 'request_subscriber_001', 'highest_paid_monthly_v1')),
        'BILLING_CHECKOUT_SUBSCRIBER_PORTAL_REQUIRED',
      );
      assert.equal(h.calls.length, 0);
    });

    await t.test('callback origin is allowlisted server-side', async () => {
      const userId = await newUser('origin');
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      const input = checkoutInput(userId, 'request_origin_001');
      input.successUrl = 'https://attacker.example/success';

      await expectCode(
        service.createSession(input),
        'BILLING_CHECKOUT_CALLBACK_NOT_ALLOWED',
      );
      assert.equal(h.calls.length, 0);
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
