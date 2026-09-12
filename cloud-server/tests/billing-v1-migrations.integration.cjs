'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { applyMigrations, listMigrations } = require('../postgres-migrations');

const ADMIN_URL = process.env.BILLING_MIGRATION_TEST_ADMIN_URL || '';

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function databaseUrl(adminUrl, databaseName) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function expectPgCode(fn, code) {
  await assert.rejects(fn, error => {
    assert.equal(error?.code, code);
    return true;
  });
}

test('Billing V1 migrations apply cleanly and enforce the isolated PostgreSQL schema', { skip: !ADMIN_URL }, async () => {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const dbName = `beatgaler_billing_v1_${suffix}`.replace(/[^a-zA-Z0-9_]/g, '_');
  const admin = new Client({ connectionString: ADMIN_URL });
  let pool = null;

  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(dbName)}`);
    pool = new Pool({ connectionString: databaseUrl(ADMIN_URL, dbName), max: 2 });

    const migrations = listMigrations();
    assert.equal(migrations.at(-1)?.version, '0013');
    assert.equal(migrations.at(-1)?.name, '0013_billing_lifecycle.sql');

    const first = await applyMigrations(pool, migrations);
    assert.deepEqual(first.applied, migrations.map(item => item.version));
    assert.deepEqual(first.skipped, []);

    const second = await applyMigrations(pool, migrations);
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, migrations.map(item => item.version));

    const ledger = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(ledger.rows.map(row => row.version), migrations.map(item => item.version));

    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema='public'
        AND table_name IN (
          'billing_customers','billing_checkout_requests','billing_payments',
          'billing_provider_actions','billing_webhook_events'
        )
      ORDER BY table_name
    `);
    assert.deepEqual(tables.rows.map(row => row.table_name), [
      'billing_checkout_requests',
      'billing_customers',
      'billing_payments',
      'billing_provider_actions',
      'billing_webhook_events',
    ]);

    const subscriptionColumns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='billing_subscription_state'
        AND column_name IN (
          'provider','provider_environment','offer_id','provider_product_id','provider_price_id',
          'current_period_start','paid_through','past_due_at','grace_until','ended_at',
          'next_plan_id','next_interval','next_plan_effective_at','access_invalidated_at',
          'invalidation_reason','last_synced_at','local_version'
        )
    `);
    assert.equal(subscriptionColumns.rowCount, 17);

    const entitlementColumns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='entitlements'
        AND column_name IN ('source_key','revoked_at','revocation_reason','issued_by_actor')
    `);
    assert.equal(entitlementColumns.rowCount, 4);

    const webhookColumns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='billing_webhook_events'
        AND column_name IN (
          'provider','provider_environment','raw_body_sha256','validated_payload','resolved_user_id',
          'provider_customer_id','provider_subscription_id','provider_checkout_id','received_at','processed_at',
          'next_attempt_at','processing_lease_owner','processing_lease_until','last_error_code','last_error_redacted'
        )
    `);
    assert.equal(webhookColumns.rowCount, 15);

    const providerActionColumns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='billing_provider_actions'
        AND column_name IN (
          'action_type','state','attempt_count','processing_lease_owner','processing_lease_until',
          'next_attempt_at','last_error_code','succeeded_at','idempotency_key'
        )
    `);
    assert.equal(providerActionColumns.rowCount, 9);

    await pool.query(`
      INSERT INTO users(id,email) VALUES
        ('billing_test_u1','u1@example.invalid'),
        ('billing_test_u2','u2@example.invalid')
    `);

    await pool.query(`
      INSERT INTO billing_customers(
        id,user_id,provider,provider_environment,provider_customer_id,external_id
      ) VALUES ('cust_row_1','billing_test_u1','polar','sandbox','polar_cust_1','beatgaler_u1')
    `);
    await expectPgCode(
      () => pool.query(`
        INSERT INTO billing_customers(
          id,user_id,provider,provider_environment,provider_customer_id,external_id
        ) VALUES ('cust_row_2','billing_test_u2','polar','sandbox','polar_cust_1','beatgaler_u2')
      `),
      '23505',
    );

    await pool.query(`
      INSERT INTO billing_subscription_state(
        user_id,provider,provider_environment,provider_subscription_id,offer_id,
        plan_id,status,current_period_start,current_period_end,paid_through
      ) VALUES (
        'billing_test_u1','polar','sandbox','polar_sub_1','paid_entry_monthly_v1',
        'paid_entry','active',now(),now()+interval '30 days',now()+interval '30 days'
      )
    `);
    await expectPgCode(
      () => pool.query(`
        INSERT INTO billing_subscription_state(
          user_id,provider,provider_environment,provider_subscription_id,offer_id,
          plan_id,status,current_period_start,current_period_end,paid_through
        ) VALUES (
          'billing_test_u2','polar','sandbox','polar_sub_1','highest_paid_monthly_v1',
          'highest_paid','active',now(),now()+interval '30 days',now()+interval '30 days'
        )
      `),
      '23505',
    );

    await pool.query(`
      INSERT INTO entitlements(
        id,user_id,plan_id,source,source_key,starts_at,expires_at
      ) VALUES (
        'welcome_1','billing_test_u1','paid_entry','welcome','welcome:v1',
        now(),now()+interval '7 days'
      )
    `);
    await expectPgCode(
      () => pool.query(`
        INSERT INTO entitlements(
          id,user_id,plan_id,source,source_key,starts_at,expires_at
        ) VALUES (
          'welcome_2','billing_test_u1','paid_entry','welcome','welcome:v2',
          now(),now()+interval '7 days'
        )
      `),
      '23505',
    );

    const requestHash1 = 'a'.repeat(64);
    const requestHash2 = 'b'.repeat(64);
    await pool.query(`
      INSERT INTO billing_checkout_requests(
        user_id,request_id,offer_id,request_hash_sha256,provider,provider_environment,state
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, ['billing_test_u1','req_1','paid_entry_monthly_v1',requestHash1,'polar','sandbox','OPEN']);
    await expectPgCode(
      () => pool.query(`
        INSERT INTO billing_checkout_requests(
          user_id,request_id,offer_id,request_hash_sha256,provider,provider_environment,state
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, ['billing_test_u1','req_2','highest_paid_monthly_v1',requestHash2,'polar','sandbox','OPEN']),
      '23505',
    );
    await pool.query("UPDATE billing_checkout_requests SET state='COMPLETED', completed_at=now() WHERE user_id='billing_test_u1' AND request_id='req_1'");
    await pool.query(`
      INSERT INTO billing_checkout_requests(
        user_id,request_id,offer_id,request_hash_sha256,provider,provider_environment,state
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, ['billing_test_u1','req_2','highest_paid_monthly_v1',requestHash2,'polar','sandbox','OPEN']);

    await pool.query(`
      INSERT INTO billing_payments(
        id,provider,provider_environment,provider_payment_id,user_id,provider_subscription_id,
        offer_id,period_start,period_end,amount_minor,currency,status,refunded_amount_minor
      ) VALUES (
        'payment_1','polar','sandbox','polar_payment_1','billing_test_u1','polar_sub_1',
        'paid_entry_monthly_v1',now(),now()+interval '30 days',699,'usd','succeeded',0
      )
    `);

    await pool.query(`
      INSERT INTO billing_payments(
        id,provider,provider_environment,provider_payment_id,provider_order_id,user_id,
        provider_subscription_id,offer_id,period_start,period_end,amount_minor,currency,status,refunded_amount_minor
      ) VALUES (
        'order_identity_payment','polar','sandbox',NULL,'polar_order_1','billing_test_u1',
        'polar_sub_1','paid_entry_monthly_v1',now(),now()+interval '30 days',699,'usd','succeeded',0
      )
    `);

    await expectPgCode(
      () => pool.query(`
        INSERT INTO billing_payments(
          id,provider,provider_environment,provider_payment_id,provider_order_id,user_id,offer_id,
          amount_minor,currency,status,refunded_amount_minor
        ) VALUES (
          'payment_no_identity','polar','sandbox',NULL,NULL,'billing_test_u1',
          'paid_entry_monthly_v1',699,'usd','succeeded',0
        )
      `),
      '23514',
    );

    await expectPgCode(
      () => pool.query(`
        INSERT INTO billing_payments(
          id,provider,provider_environment,provider_payment_id,user_id,offer_id,
          amount_minor,currency,status,refunded_amount_minor
        ) VALUES (
          'payment_bad_refund','polar','sandbox','polar_payment_bad','billing_test_u1',
          'paid_entry_monthly_v1',699,'usd','refunded',700
        )
      `),
      '23514',
    );

    await pool.query(`
      INSERT INTO billing_provider_actions(
        id,user_id,provider,provider_environment,action_type,provider_subscription_id,
        idempotency_key,state,attempt_count
      ) VALUES (
        'provider_action_1','billing_test_u1','polar','sandbox','REVOKE_SUBSCRIPTION','polar_sub_1',
        'refund-revoke:polar:sandbox:polar_sub_1','PENDING',0
      )
    `);

    await expectPgCode(
      () => pool.query(`
        INSERT INTO billing_provider_actions(
          id,user_id,provider,provider_environment,action_type,provider_subscription_id,
          idempotency_key,state,attempt_count
        ) VALUES (
          'provider_action_bad_lease','billing_test_u2','polar','sandbox','REVOKE_SUBSCRIPTION','polar_sub_bad',
          'refund-revoke:polar:sandbox:polar_sub_bad','PROCESSING',1
        )
      `),
      '23514',
    );

    await expectPgCode(
      () => pool.query(`
        INSERT INTO billing_checkout_requests(
          user_id,request_id,offer_id,request_hash_sha256,provider,provider_environment,state
        ) VALUES ('billing_test_u2','bad_hash','paid_entry_monthly_v1','not-a-hash','polar','sandbox','OPEN')
      `),
      '23514',
    );

    await pool.query(`
      INSERT INTO billing_webhook_events(
        event_id,event_type,subject_id,provider_created_at,state,provider,provider_environment,
        raw_body_sha256,validated_payload,resolved_user_id,received_at
      ) VALUES (
        'webhook_schema_1','subscription.active','polar_sub_1',1789165800000,'RECEIVED','polar','sandbox',
        $1,'{"type":"subscription.active"}'::jsonb,'billing_test_u1',now()
      )
    `, ['c'.repeat(64)]);

    await expectPgCode(
      () => pool.query(`
        INSERT INTO billing_webhook_events(
          event_id,event_type,subject_id,provider_created_at,state,provider,provider_environment,received_at
        ) VALUES ('webhook_bad_state','subscription.active','sub_bad',1,'IGNORED_OUT_OF_ORDER','polar','sandbox',now())
      `),
      '23514',
    );

    await expectPgCode(
      () => pool.query(`
        INSERT INTO billing_webhook_events(
          event_id,event_type,subject_id,provider_created_at,state,provider,provider_environment,received_at
        ) VALUES ('webhook_bad_lease','subscription.active','sub_bad_lease',1,'PROCESSING','polar','sandbox',now())
      `),
      '23514',
    );

    await pool.query("DELETE FROM users WHERE id='billing_test_u1'");
    for (const table of [
      'billing_customers',
      'billing_checkout_requests',
      'billing_payments',
      'billing_provider_actions',
      'billing_subscription_state',
      'entitlements',
    ]) {
      const count = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE user_id='billing_test_u1'`);
      assert.equal(count.rows[0].count, 0, `${table} should cascade user deletion`);
    }
    const webhookUser = await pool.query("SELECT resolved_user_id FROM billing_webhook_events WHERE event_id='webhook_schema_1'");
    assert.equal(webhookUser.rows[0].resolved_user_id, null, 'webhook inbox should retain financial history while clearing deleted user FK');
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
