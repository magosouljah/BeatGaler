'use strict';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { applyMigrations, listMigrations } = require('../postgres-migrations');
const {
  DurableWebhookError,
  DurableWebhookSignatureError,
  DurableWebhookIdentityError,
  DurableWebhookBindingError,
  createDurableWebhookInbox,
} = require('../billing-webhook-durable');

const ADMIN_URL = process.env.BILLING_WEBHOOK_TEST_ADMIN_URL || '';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function databaseUrl(adminUrl, databaseName) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function rawEvent({
  type = 'subscription.active',
  timestamp = '2026-09-11T22:30:00.000Z',
  data = {},
} = {}) {
  return Buffer.from(JSON.stringify({
    type,
    timestamp,
    data: {
      id: 'polar_sub_default',
      customer_id: 'polar_customer_default',
      status: 'active',
      ...data,
    },
  }));
}

function webhookHeaders(eventId, overrides = {}) {
  return {
    'webhook-id': eventId,
    'webhook-timestamp': '1789165800',
    'webhook-signature': 'v1,fixture-signature',
    ...overrides,
  };
}

function adapterHarness() {
  let verifyCalls = 0;
  return {
    get verifyCalls() { return verifyCalls; },
    adapter: {
      provider: 'polar',
      environment: 'sandbox',
      async verifyWebhook({ rawBody, headers }) {
        verifyCalls += 1;
        assert.equal(Buffer.isBuffer(rawBody), true);
        const normalized = Object.fromEntries(
          Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
        );
        if (normalized['webhook-signature'] !== 'v1,fixture-signature') {
          const error = new Error('fixture signature rejected');
          error.code = 'POLAR_SANDBOX_WEBHOOK_INVALID';
          throw error;
        }
        return JSON.parse(rawBody.toString('utf8'));
      },
    },
  };
}

function makeService(pool, adapter, options = {}) {
  return createDurableWebhookInbox({
    pool,
    adapter,
    leaseMs: options.leaseMs || 2_000,
    lockTimeoutMs: options.lockTimeoutMs || 200,
    retryBaseMs: options.retryBaseMs || 10,
    retryMaxMs: options.retryMaxMs || 10,
    maxAttempts: options.maxAttempts || 4,
  });
}

async function expectCode(promise, ErrorClass, code) {
  await assert.rejects(promise, error => {
    assert.equal(error instanceof ErrorClass, true);
    assert.equal(error.code, code);
    return true;
  });
}

test('Billing V1 webhook inbox persists first, deduplicates, retries and recovers leases in PostgreSQL', { skip: !ADMIN_URL }, async t => {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const dbName = `beatgaler_webhook_v1_${suffix}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const admin = new Client({ connectionString: ADMIN_URL });
  let pool = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
    pool = new Pool({ connectionString: databaseUrl(ADMIN_URL, dbName), max: 8 });
    await applyMigrations(pool, listMigrations());

    await pool.query(`
      INSERT INTO users(id,email) VALUES
        ('webhook_user_1','webhook1@example.invalid'),
        ('webhook_user_2','webhook2@example.invalid')
    `);
    await pool.query(`
      INSERT INTO billing_customers(
        id,user_id,provider,provider_environment,provider_customer_id,external_id
      ) VALUES
        ('webhook_customer_row_1','webhook_user_1','polar','sandbox','polar_customer_1','webhook_user_1'),
        ('webhook_customer_row_2','webhook_user_2','polar','sandbox','polar_customer_2','webhook_user_2')
    `);

    async function resetInbox() {
      await pool.query('TRUNCATE billing_webhook_events');
    }

    await t.test('invalid signature fails before durable persistence', async () => {
      await resetInbox();
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      await expectCode(
        service.receive({
          rawBody: rawEvent({ data: { id: 'polar_sub_sig' } }),
          headers: webhookHeaders('msg_signature_bad', { 'webhook-signature': 'v1,bad' }),
        }),
        DurableWebhookSignatureError,
        'WEBHOOK_INVALID_SIGNATURE',
      );
      const count = await pool.query('SELECT count(*)::int AS count FROM billing_webhook_events');
      assert.equal(count.rows[0].count, 0);
    });

    await t.test('valid raw body is committed as RECEIVED before receive returns', async () => {
      await resetInbox();
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      const raw = Buffer.from('{"type":"subscription.active","timestamp":"2026-09-11T22:30:00.000Z","data":{"id":"polar_sub_receive","customer_id":"polar_customer_1","status":"active","secret":"must-not-persist","card_number":"4242424242424242"}}');
      const result = await service.receive({ rawBody: raw, headers: webhookHeaders('msg_receive_1') });

      assert.deepEqual(result, {
        accepted: true,
        persisted: true,
        duplicate: false,
        eventId: 'msg_receive_1',
        state: 'RECEIVED',
        entitlementGranted: false,
      });

      const row = (await pool.query(`
        SELECT provider,provider_environment,state,raw_body_sha256,validated_payload,
               resolved_user_id,received_at,processing_lease_owner
        FROM billing_webhook_events WHERE event_id='msg_receive_1'
      `)).rows[0];
      assert.equal(row.provider, 'polar');
      assert.equal(row.provider_environment, 'sandbox');
      assert.equal(row.state, 'RECEIVED');
      assert.equal(row.raw_body_sha256, crypto.createHash('sha256').update(raw).digest('hex'));
      assert.equal(row.resolved_user_id, null);
      assert.equal(row.processing_lease_owner, null);
      assert.ok(row.received_at);
      const payloadText = JSON.stringify(row.validated_payload);
      assert.equal(payloadText.includes('must-not-persist'), false);
      assert.equal(payloadText.includes('4242424242424242'), false);
      assert.equal(row.validated_payload.data.id, 'polar_sub_receive');
    });

    await t.test('same webhook-id and exact verified bytes deduplicate without resetting state', async () => {
      await resetInbox();
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      const raw = rawEvent({ data: { id: 'polar_sub_duplicate', customer_id: 'polar_customer_1' } });
      const input = { rawBody: raw, headers: webhookHeaders('msg_duplicate_1') };
      const first = await service.receive(input);
      const second = await service.receive(input);
      assert.equal(first.duplicate, false);
      assert.equal(second.duplicate, true);
      assert.equal(second.state, 'RECEIVED');
      const count = await pool.query("SELECT count(*)::int AS count FROM billing_webhook_events WHERE event_id='msg_duplicate_1'");
      assert.equal(count.rows[0].count, 1);
    });

    await t.test('reused webhook-id with altered signed content is an identity collision', async () => {
      await resetInbox();
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      await service.receive({
        rawBody: rawEvent({ data: { id: 'polar_sub_collision', customer_id: 'polar_customer_1', status: 'active' } }),
        headers: webhookHeaders('msg_collision_1'),
      });
      await expectCode(
        service.receive({
          rawBody: rawEvent({ data: { id: 'polar_sub_collision', customer_id: 'polar_customer_1', status: 'canceled' } }),
          headers: webhookHeaders('msg_collision_1'),
        }),
        DurableWebhookIdentityError,
        'WEBHOOK_IDENTITY_COLLISION',
      );
      const row = (await pool.query("SELECT state,validated_payload FROM billing_webhook_events WHERE event_id='msg_collision_1'")).rows[0];
      assert.equal(row.state, 'RECEIVED');
      assert.equal(row.validated_payload.data.status, 'active');
    });

    await t.test('missing Standard Webhooks identity never reaches the inbox', async () => {
      await resetInbox();
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      await expectCode(
        service.receive({
          rawBody: rawEvent({ data: { id: 'polar_sub_no_id' } }),
          headers: {
            'webhook-timestamp': '1789165800',
            'webhook-signature': 'v1,fixture-signature',
          },
        }),
        DurableWebhookError,
        'WEBHOOK_INVALID_EVENT',
      );
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM billing_webhook_events')).rows[0].count, 0);
    });

    await t.test('unsupported verified event is persisted first and then becomes IGNORED', async () => {
      await resetInbox();
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      await service.receive({
        rawBody: rawEvent({ type: 'benefit.created', data: { id: 'polar_benefit_1', customer_id: 'polar_customer_1' } }),
        headers: webhookHeaders('msg_unsupported_1'),
      });
      const processed = await service.processNext({ workerId: 'worker-ignore', handlers: {} });
      assert.equal(processed.eventId, 'msg_unsupported_1');
      assert.equal(processed.state, 'IGNORED');
      assert.equal(processed.lastErrorCode, 'WEBHOOK_EVENT_UNSUPPORTED');
      assert.ok(processed.processedAt);
    });

    await t.test('processing resolves only trusted bindings and commits handler mutation with PROCESSED', async () => {
      await resetInbox();
      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      await service.receive({
        rawBody: rawEvent({ data: { id: 'polar_sub_bound', customer_id: 'polar_customer_1' } }),
        headers: webhookHeaders('msg_bound_1'),
      });

      const processed = await service.processNext({
        workerId: 'worker-bound',
        handlers: {
          'subscription.active': async (client, context) => {
            assert.equal(context.resolvedUserId, 'webhook_user_1');
            await client.query(`
              INSERT INTO audit_events(id,actor_user_id,event_type,subject_type,subject_id,details)
              VALUES ('audit_webhook_bound','webhook_user_1','billing_webhook_test','subscription',$1,'{}'::jsonb)
            `, [context.event.subjectId]);
          },
        },
      });

      assert.equal(processed.state, 'PROCESSED');
      assert.equal(processed.resolvedUserId, 'webhook_user_1');
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE id='audit_webhook_bound'")).rows[0].count, 1);
    });

    await t.test('prepare runs before SQL apply transaction and retry succeeds without raw error persistence', async () => {
      await resetInbox();
      await pool.query("DELETE FROM audit_events WHERE id='audit_webhook_retry'");
      const h = adapterHarness();
      const service = makeService(pool, h.adapter, { retryBaseMs: 5, retryMaxMs: 5 });
      await service.receive({
        rawBody: rawEvent({ data: { id: 'polar_sub_retry', customer_id: 'polar_customer_1' } }),
        headers: webhookHeaders('msg_retry_1'),
      });

      let prepares = 0;
      const handler = {
        async prepare(context) {
          prepares += 1;
          assert.equal(context.resolvedUserId, 'webhook_user_1');
          if (prepares === 1) {
            const error = new Error('SECRET_PROVIDER_RESPONSE_should_never_be_persisted');
            error.code = 'TEMP_PROVIDER_UNAVAILABLE';
            throw error;
          }
          return { providerState: 'active' };
        },
        async apply(client, context, prepared) {
          assert.equal(prepared.providerState, 'active');
          await client.query(`
            INSERT INTO audit_events(id,actor_user_id,event_type,subject_type,subject_id,details)
            VALUES ('audit_webhook_retry',$1,'billing_webhook_retry','subscription',$2,'{}'::jsonb)
          `, [context.resolvedUserId, context.event.subjectId]);
        },
      };

      await assert.rejects(
        service.processNext({ workerId: 'worker-retry-a', handlers: { 'subscription.active': handler } }),
        error => error.code === 'TEMP_PROVIDER_UNAVAILABLE',
      );
      const failed = await service.getEvent('msg_retry_1');
      assert.equal(failed.state, 'FAILED');
      assert.equal(failed.lastErrorCode, 'TEMP_PROVIDER_UNAVAILABLE');
      const persistedError = (await pool.query("SELECT last_error_redacted FROM billing_webhook_events WHERE event_id='msg_retry_1'")).rows[0].last_error_redacted;
      assert.equal(persistedError.includes('SECRET_PROVIDER_RESPONSE'), false);

      await pool.query("UPDATE billing_webhook_events SET next_attempt_at=now()-interval '1 second' WHERE event_id='msg_retry_1'");
      const retried = await service.processNext({ workerId: 'worker-retry-b', handlers: { 'subscription.active': handler } });
      assert.equal(retried.state, 'PROCESSED');
      assert.equal(retried.attemptCount, 2);
      assert.equal(prepares, 2);
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM audit_events WHERE id='audit_webhook_retry'")).rows[0].count, 1);
    });

    await t.test('PROCESSING lease survives process loss and can be reclaimed only after expiry', async () => {
      await resetInbox();
      const h = adapterHarness();
      const service = makeService(pool, h.adapter, { leaseMs: 60_000 });
      await service.receive({
        rawBody: rawEvent({ data: { id: 'polar_sub_crash', customer_id: 'polar_customer_1' } }),
        headers: webhookHeaders('msg_crash_1'),
      });

      const first = await service.claimNext('worker-crashed');
      assert.equal(first.state, 'PROCESSING');
      assert.equal(first.attemptCount, 1);
      assert.equal(first.leaseOwner, 'worker-crashed');
      assert.equal(await service.claimNext('worker-too-early'), null);

      await pool.query("UPDATE billing_webhook_events SET processing_lease_until=now()-interval '1 second' WHERE event_id='msg_crash_1'");
      const recovered = await service.claimNext('worker-after-restart');
      assert.equal(recovered.eventId, 'msg_crash_1');
      assert.equal(recovered.state, 'PROCESSING');
      assert.equal(recovered.attemptCount, 2);
      assert.equal(recovered.leaseOwner, 'worker-after-restart');
    });

    await t.test('new receipts do not wait for an unrelated in-flight processing lease', async () => {
      await resetInbox();
      const h = adapterHarness();
      const service = makeService(pool, h.adapter, { leaseMs: 60_000 });
      await service.receive({
        rawBody: rawEvent({ data: { id: 'polar_sub_inflight', customer_id: 'polar_customer_1' } }),
        headers: webhookHeaders('msg_inflight_1'),
      });
      await service.claimNext('worker-inflight');

      const second = await service.receive({
        rawBody: rawEvent({ data: { id: 'polar_sub_second', customer_id: 'polar_customer_1' } }),
        headers: webhookHeaders('msg_inflight_2'),
      });
      assert.equal(second.state, 'RECEIVED');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM billing_webhook_events')).rows[0].count, 2);
    });

    await t.test('contradictory trusted customer/subscription bindings fail closed and remain retryable', async () => {
      await resetInbox();
      await pool.query(`
        INSERT INTO billing_subscription_state(
          user_id,provider,provider_environment,provider_subscription_id,offer_id,
          plan_id,status,current_period_start,current_period_end,paid_through
        ) VALUES (
          'webhook_user_2','polar','sandbox','polar_sub_conflict','paid_entry_monthly_v1',
          'paid_entry','active',now(),now()+interval '30 days',now()+interval '30 days'
        )
        ON CONFLICT(user_id) DO UPDATE SET
          provider='polar', provider_environment='sandbox', provider_subscription_id='polar_sub_conflict',
          offer_id='paid_entry_monthly_v1', plan_id='paid_entry', status='active',
          current_period_start=now(), current_period_end=now()+interval '30 days', paid_through=now()+interval '30 days'
      `);

      const h = adapterHarness();
      const service = makeService(pool, h.adapter);
      await service.receive({
        rawBody: rawEvent({ data: { id: 'polar_sub_conflict', customer_id: 'polar_customer_1' } }),
        headers: webhookHeaders('msg_binding_conflict_1'),
      });

      await expectCode(
        service.processNext({
          workerId: 'worker-conflict',
          handlers: { 'subscription.active': async () => assert.fail('handler must not run') },
        }),
        DurableWebhookBindingError,
        'WEBHOOK_BINDING_CONFLICT',
      );
      const row = await service.getEvent('msg_binding_conflict_1');
      assert.equal(row.state, 'FAILED');
      assert.equal(row.lastErrorCode, 'WEBHOOK_BINDING_CONFLICT');
      assert.ok(row.nextAttemptAt);
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
