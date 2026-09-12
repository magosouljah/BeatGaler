#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { Client, Pool } = require('pg');

const { listMigrations, applyMigrations } = require('../postgres-migrations');
const { readPolarSandboxConfig } = require('../billing-polar-sandbox');
const { createPolarSandboxLifecycleAdapter } = require('../billing-polar-lifecycle-adapter');
const { createPersistentCheckoutService } = require('../billing-checkout-persistent');
const { createDurableWebhookInbox } = require('../billing-webhook-durable');
const { createBillingLifecycle, createBillingProviderActionWorker } = require('../billing-lifecycle');
const { createBillingReconciliationService } = require('../billing-reconciliation');

const PROVIDER = 'polar';
const ENVIRONMENT = 'sandbox';
const DEFAULT_PORT = 4011;
const DEFAULT_WAIT_MS = 15 * 60 * 1000;
const RENEWAL_ACCELERATION_MS = 90_000;
const POLL_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw Object.assign(new Error(`${name} is required.`), { code: 'BILLING_E2E_ENV_REQUIRED' });
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw Object.assign(new Error(`${name} must be a positive integer.`), { code: 'BILLING_E2E_ENV_INVALID' });
  }
  return value;
}

function safeErrorCode(error, fallback = 'BILLING_E2E_FAILED') {
  const value = String(error?.code || fallback).trim().toUpperCase();
  return /^[A-Z0-9_:-]{1,128}$/.test(value) ? value : fallback;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function runKey() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function isolatedDatabaseName(key) {
  return `beatgaler_billing_e2e_${key.toLowerCase()}`.replace(/[^a-z0-9_]/g, '_').slice(0, 63);
}

function databaseUrl(adminUrl, name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function userEmail(base, suffix) {
  const at = base.lastIndexOf('@');
  if (at <= 0) return base;
  return `${base.slice(0, at).replace(/\+.*/, '')}+${suffix}@${base.slice(at + 1)}`;
}

function evidenceAccess(access) {
  return {
    commercialPlanId: access?.commercialPlanId || 'free',
    commercialAccessPlanId: access?.commercialAccessPlanId || null,
    commercialAccessState: access?.commercialAccessState || 'none',
    effectivePlanId: access?.effectivePlanId || 'free',
    nextRecalculationAt: access?.nextRecalculationAt ? new Date(access.nextRecalculationAt).toISOString() : null,
    billing: {
      providerStatus: access?.billing?.providerStatus || 'inactive',
      paidThrough: access?.billing?.paidThrough ? new Date(access.billing.paidThrough).toISOString() : null,
      pastDueAt: access?.billing?.pastDueAt ? new Date(access.billing.pastDueAt).toISOString() : null,
      graceUntil: access?.billing?.graceUntil ? new Date(access.billing.graceUntil).toISOString() : null,
      accessInvalidatedAt: access?.billing?.accessInvalidatedAt ? new Date(access.billing.accessInvalidatedAt).toISOString() : null,
      invalidationReason: access?.billing?.invalidationReason || null,
      cancelAtPeriodEnd: Boolean(access?.billing?.cancelAtPeriodEnd),
      nextPlanId: access?.billing?.nextPlanId || null,
      nextPlanEffectiveAt: access?.billing?.nextPlanEffectiveAt ? new Date(access.billing.nextPlanEffectiveAt).toISOString() : null,
    },
    sources: Array.isArray(access?.accessSources)
      ? access.accessSources.map(source => ({ type: source.type, mode: source.mode, planId: source.planId }))
      : [],
  };
}

function sanitizeReconciliation(result) {
  if (!result) return null;
  return {
    reconciled: Boolean(result.reconciled),
    divergent: Boolean(result.divergent),
    repaired: Boolean(result.repaired),
    repairable: result.repairable === undefined ? null : Boolean(result.repairable),
    reason: result.reason || null,
    accessChanged: result.accessChanged === undefined ? null : Boolean(result.accessChanged),
    effectivePlanBefore: result.effectivePlanBefore || null,
    effectivePlanAfter: result.effectivePlanAfter || null,
  };
}

function assertSanitized(value, config) {
  const text = JSON.stringify(value);
  for (const secret of [config.accessToken, config.webhookSecret].filter(Boolean)) {
    assert.equal(text.includes(secret), false, 'evidence contains a secret value');
  }
  assert.equal(/polar_oat_[A-Za-z0-9_-]+/.test(text), false, 'evidence contains a Polar access token');
  assert.equal(/(?:whsec_|polar_whs_)[A-Za-z0-9_-]+/.test(text), false, 'evidence contains a webhook secret');
  assert.equal(/checkout\.polar\.sh\//i.test(text), false, 'evidence contains a full checkout URL');
}

async function evidencePathFor(key) {
  const configured = String(process.env.BILLING_E2E_EVIDENCE_PATH || '').trim();
  if (configured) return configured;
  const gitPath = git(['rev-parse', '--git-path', 'beatgaler-billing-e2e']);
  const directory = path.isAbsolute(gitPath) ? gitPath : path.resolve(git(['rev-parse', '--show-toplevel']), gitPath);
  await fs.mkdir(directory, { recursive: true });
  return path.join(directory, `${key}.json`);
}

async function createDatabase(adminUrl, name) {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try { await client.query(`CREATE DATABASE ${quoteIdentifier(name)}`); }
  finally { await client.end(); }
}

async function dropDatabase(adminUrl, name) {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]);
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  } finally { await client.end(); }
}

async function httpGet(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

async function insertUser(pool, user) {
  await pool.query('INSERT INTO users(id,email,created_at,updated_at) VALUES($1,$2,now(),now())', [user.id, user.email]);
}

async function insertIndependentGrant(pool, userId, key) {
  await pool.query(`
    INSERT INTO entitlements(
      id,user_id,plan_id,source,starts_at,expires_at,source_key,issued_by_actor,created_at
    ) VALUES($1,$2,'paid_entry','e2e_independent_grant',$3,$4,$5,'task11-e2e',now())
  `, [
    `e2e_grant_${key}`,
    userId,
    new Date(Date.now() - 60_000),
    new Date(Date.now() + DAY_MS),
    `task11:${key}`,
  ]);
}

async function snapshot(pool, lifecycle, userId, now = new Date()) {
  const [customer, checkouts, subscription, payments, webhooks, actions, grants] = await Promise.all([
    pool.query(`SELECT provider_customer_id,external_id,created_at,updated_at FROM billing_customers WHERE user_id=$1 AND provider=$2 AND provider_environment=$3`, [userId, PROVIDER, ENVIRONMENT]),
    pool.query(`SELECT request_id,offer_id,state,provider_checkout_id,expires_at,completed_at,last_error_code,created_at,updated_at FROM billing_checkout_requests WHERE user_id=$1 ORDER BY created_at,request_id`, [userId]),
    pool.query(`SELECT provider_customer_id,provider_subscription_id,offer_id,provider_product_id,provider_price_id,plan_id,status,cancel_at_period_end,current_period_start,current_period_end,paid_through,past_due_at,grace_until,ended_at,next_plan_id,next_interval,next_plan_effective_at,access_invalidated_at,invalidation_reason,last_synced_at,local_version,updated_at FROM billing_subscription_state WHERE user_id=$1`, [userId]),
    pool.query(`SELECT provider_payment_id,provider_order_id,provider_invoice_id,provider_subscription_id,offer_id,period_start,period_end,amount_minor,currency,status,refunded_amount_minor,invalidated_at,invalidation_reason,created_at,updated_at FROM billing_payments WHERE user_id=$1 ORDER BY created_at,provider_order_id`, [userId]),
    pool.query(`SELECT event_id,event_type,subject_id,state,attempt_count,provider_customer_id,provider_subscription_id,provider_checkout_id,received_at,processed_at,next_attempt_at,last_error_code FROM billing_webhook_events WHERE resolved_user_id=$1 OR provider_checkout_id IN (SELECT provider_checkout_id FROM billing_checkout_requests WHERE user_id=$1 AND provider_checkout_id IS NOT NULL) ORDER BY received_at,event_id`, [userId]),
    pool.query(`SELECT action_type,provider_subscription_id,state,attempt_count,next_attempt_at,last_error_code,succeeded_at,created_at,updated_at FROM billing_provider_actions WHERE user_id=$1 ORDER BY created_at,id`, [userId]),
    pool.query(`SELECT id,plan_id,source,source_key,starts_at,expires_at,revoked_at,revocation_reason FROM entitlements WHERE user_id=$1 ORDER BY starts_at,id`, [userId]),
  ]);
  const normalize = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
  return {
    userId,
    at: now.toISOString(),
    customer: customer.rows.map(normalize),
    checkouts: checkouts.rows.map(normalize),
    subscription: subscription.rows[0] ? normalize(subscription.rows[0]) : null,
    payments: payments.rows.map(normalize),
    webhooks: webhooks.rows.map(normalize),
    providerActions: actions.rows.map(normalize),
    grants: grants.rows.map(normalize),
    resolver: evidenceAccess(await lifecycle.resolveUserAccess(pool, userId, now)),
  };
}

async function main() {
  const expectedHead = requiredEnv('BILLING_E2E_EXPECTED_HEAD');
  const adminUrl = requiredEnv('BILLING_E2E_TEST_ADMIN_URL');
  const baseEmail = requiredEnv('POLAR_SANDBOX_E2E_EMAIL');
  const webhookTransport = requiredEnv('POLAR_SANDBOX_E2E_WEBHOOK_TRANSPORT');
  assert.equal(webhookTransport, 'polar-cli-listen', 'Task 11 requires the official Polar CLI real webhook relay');
  assert.equal(git(['rev-parse', 'HEAD']), expectedHead, 'HEAD differs from BILLING_E2E_EXPECTED_HEAD');
  assert.equal(git(['branch', '--show-current']), 'billing/v1-policy', 'Task 11 must run from billing/v1-policy');
  const adminDatabase = decodeURIComponent(new URL(adminUrl).pathname.replace(/^\//, ''));
  assert.equal(adminDatabase, 'postgres', 'BILLING_E2E_TEST_ADMIN_URL must target the postgres admin database');

  const config = readPolarSandboxConfig(process.env);
  assert.equal(config.provider, PROVIDER);
  assert.equal(config.environment, ENVIRONMENT);
  const port = positiveIntegerEnv('POLAR_SANDBOX_E2E_PORT', DEFAULT_PORT);
  const waitMs = positiveIntegerEnv('POLAR_SANDBOX_E2E_WAIT_MS', DEFAULT_WAIT_MS);
  const key = runKey();
  const dbName = isolatedDatabaseName(key);
  const dbUrl = databaseUrl(adminUrl, dbName);
  const evidenceFile = await evidencePathFor(key);
  const successUrl = `http://127.0.0.1:${port}/billing/success`;
  const returnUrl = `http://127.0.0.1:${port}/billing/return`;
  const workerId = `task11_${key}`.slice(0, 120);
  const users = {
    main: { id: `e2e_${key}_main`, email: userEmail(baseEmail, `${key}-main`) },
    refund: { id: `e2e_${key}_refund`, email: userEmail(baseEmail, `${key}-refund`) },
    recovery: { id: `e2e_${key}_recovery`, email: userEmail(baseEmail, `${key}-recovery`) },
  };

  const evidence = {
    schemaVersion: 1,
    task: 11,
    provider: PROVIDER,
    environment: ENVIRONMENT,
    organizationId: config.organizationId || null,
    providerMappings: config.providerMappings,
    expectedOffer: 'paid_entry_monthly_v1',
    expectedUpgradeOffer: 'highest_paid_monthly_v1',
    runId: key,
    branch: 'billing/v1-policy',
    commitSha: expectedHead,
    databaseName: dbName,
    databaseIsolated: true,
    webhookTransport,
    expirationVerification: 'real Polar cancel-at-period-end + local injected clock at real paid_through; Polar Sandbox has no Stripe-style test clock',
    startedAt: new Date().toISOString(),
    migrationsApplied: [],
    receiptProofs: {},
    scenarios: [],
    result: 'RUNNING',
  };

  async function saveEvidence() {
    assertSanitized(evidence, config);
    await fs.mkdir(path.dirname(evidenceFile), { recursive: true });
    await fs.writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }

  async function record(name, details = {}) {
    evidence.scenarios.push({ name, status: 'PASS', timestamp: new Date().toISOString(), ...details });
    await saveEvidence();
  }

  let pool;
  let server;
  let rl;
  let adapter;
  let lifecycle;
  let inbox;
  let actionWorker;
  let processing = Promise.resolve();
  const realSignedDeliveries = new Set();

  function enqueueProcessing() {
    processing = processing.then(async () => {
      for (let i = 0; i < 100; i += 1) {
        try {
          const row = await inbox.processNext({ workerId, handlers: lifecycle.handlers });
          if (!row) break;
        } catch (error) {
          console.log(`[billing-e2e] webhook worker: ${safeErrorCode(error)}`);
          break;
        }
      }
      for (let i = 0; i < 20; i += 1) {
        try {
          const row = await actionWorker.processNext({ workerId });
          if (!row) break;
        } catch (error) {
          console.log(`[billing-e2e] provider action worker: ${safeErrorCode(error)}`);
          break;
        }
      }
    });
    return processing;
  }

  async function waitUntil(label, predicate) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await enqueueProcessing();
      if (await predicate()) return;
      await sleep(POLL_MS);
    }
    throw Object.assign(new Error(`${label} timed out.`), { code: 'BILLING_E2E_WAIT_TIMEOUT' });
  }

  async function promptBrowser(message) {
    output.write(`\n${message}\n`);
    await rl.question('Press Enter only after completing that Sandbox browser step... ');
  }

  async function paymentCount(userId) {
    return Number((await pool.query('SELECT count(*)::int AS count FROM billing_payments WHERE user_id=$1', [userId])).rows[0]?.count || 0);
  }

  async function subscriptionRow(userId) {
    return (await pool.query('SELECT * FROM billing_subscription_state WHERE user_id=$1', [userId])).rows[0] || null;
  }

  async function latestPayment(userId) {
    return (await pool.query('SELECT * FROM billing_payments WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [userId])).rows[0] || null;
  }

  async function prepareCheckout(user, label) {
    const before = await snapshot(pool, lifecycle, user.id);
    assert.equal(before.resolver.effectivePlanId, 'free');
    const requestId = `task11_${label}_${key}`.slice(0, 120);
    const service = createPersistentCheckoutService({ pool, adapter, allowedCallbackOrigins: [`http://127.0.0.1:${port}`] });
    const args = {
      user,
      request: { requestId, offerId: 'paid_entry_monthly_v1' },
      successUrl,
      returnUrl,
    };
    const session = await service.createSession(args);
    assert.equal(session.state, 'OPEN');
    assert.equal(session.entitlementGranted, false);
    const retry = await service.createSession(args);
    assert.equal(retry.recovered, true);
    assert.equal(retry.checkoutId, session.checkoutId);
    let nearRetryCode = null;
    try {
      await service.createSession({ ...args, request: { ...args.request, requestId: `${requestId}_near` } });
    } catch (error) { nearRetryCode = safeErrorCode(error); }
    assert.equal(nearRetryCode, 'BILLING_CHECKOUT_UNRESOLVED_EXISTS');
    assert.equal(await httpGet(successUrl), 200);
    const redirectOnly = await snapshot(pool, lifecycle, user.id);
    assert.equal(redirectOnly.resolver.effectivePlanId, 'free');
    await record(`${label}: checkout retry + redirect authority`, {
      userId: user.id,
      requestId,
      providerCheckoutId: session.checkoutId,
      sameRequestRecovered: true,
      nearSecondAttemptBlockedWith: nearRetryCode,
      redirectWithoutFinancialEvidenceEffectivePlanId: 'free',
      before,
      after: redirectOnly,
    });
    return { service, requestId, session };
  }

  async function waitForPlan(userId, planId, minimumPayments) {
    await waitUntil(`${userId} effective ${planId}`, async () => {
      const access = await lifecycle.resolveUserAccess(pool, userId, new Date());
      return access.effectivePlanId === planId && await paymentCount(userId) >= minimumPayments;
    });
  }

  async function assertSingleSubscriptionAfterCheckout(user, checkout) {
    const row = await checkout.service.getRequest({ userId: user.id, requestId: checkout.requestId });
    assert.equal(row.state, 'COMPLETED');
    let completedRetryCode = null;
    try {
      await checkout.service.createSession({
        user,
        request: { requestId: checkout.requestId, offerId: 'paid_entry_monthly_v1' },
        successUrl,
        returnUrl,
      });
    } catch (error) { completedRetryCode = safeErrorCode(error); }
    assert.equal(completedRetryCode, 'BILLING_CHECKOUT_COMPLETED');
    const providerSubscriptions = await adapter.listSubscriptionsForUser({ userId: user.id, limit: 20 });
    assert.equal(providerSubscriptions.items.length, 1, 'BeatGaler retry produced multiple provider subscriptions');
    return { completedRetryCode, providerSubscriptionCount: providerSubscriptions.items.length };
  }

  try {
    await createDatabase(adminUrl, dbName);
    pool = new Pool({ connectionString: dbUrl, max: 6 });
    const migrations = listMigrations();
    evidence.migrationsApplied = migrations.map(migration => migration.name);
    await applyMigrations(pool, migrations);
    for (const user of Object.values(users)) await insertUser(pool, user);

    adapter = createPolarSandboxLifecycleAdapter({ config });
    await adapter.validateOfferMapping('paid_entry_monthly_v1');
    await adapter.validateOfferMapping('highest_paid_monthly_v1');
    lifecycle = createBillingLifecycle({ adapter });
    inbox = createDurableWebhookInbox({ pool, adapter, retryBaseMs: 1_000 });
    actionWorker = createBillingProviderActionWorker({ pool, adapter, retryBaseMs: 1_000 });

    server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        if (req.method === 'POST' && requestUrl.pathname === '/webhooks/polar') {
          const chunks = [];
          let bytes = 0;
          for await (const chunk of req) {
            bytes += chunk.length;
            if (bytes > 256 * 1024) throw Object.assign(new Error('body too large'), { code: 'WEBHOOK_BODY_TOO_LARGE' });
            chunks.push(chunk);
          }
          const rawBody = Buffer.concat(chunks);
          const receipt = await inbox.receive({ rawBody, headers: { ...req.headers } });
          if (!receipt.duplicate) {
            const replay = await inbox.receive({ rawBody, headers: { ...req.headers } });
            assert.equal(replay.duplicate, true);
            evidence.receiptProofs[receipt.eventId] = {
              persistedBeforeProcessing: receipt.state === 'RECEIVED',
              exactSignedReplayDeduplicated: true,
              receivedAt: new Date().toISOString(),
            };
            realSignedDeliveries.add(receipt.eventId);
            await saveEvidence();
          }
          res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('accepted');
          setImmediate(() => enqueueProcessing().catch(() => {}));
          return;
        }
        if (req.method === 'GET' && ['/billing/success', '/billing/return'].includes(requestUrl.pathname)) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('BeatGaler Sandbox callback received. Redirect is not billing authority.');
          return;
        }
        res.writeHead(404).end();
      } catch (error) {
        res.writeHead(error?.code === 'WEBHOOK_INVALID_SIGNATURE' ? 403 : 500).end('billing webhook rejected');
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    rl = createInterface({ input, output });

    console.log(`[billing-e2e] provider=Polar environment=sandbox isolated_db=${dbName}`);
    console.log(`[billing-e2e] HEAD=${expectedHead}`);
    console.log(`[billing-e2e] Configure Polar CLI: polar listen http://127.0.0.1:${port}/webhooks/polar`);
    console.log('[billing-e2e] Use only the official Polar/Stripe Sandbox test payment methods from the runbook; no card numbers are stored by this runner.');

    for (const [label, user] of Object.entries(users)) {
      const initial = await snapshot(pool, lifecycle, user.id);
      assert.equal(initial.resolver.effectivePlanId, 'free');
      await record(`${label}: initial Free`, { userId: user.id, after: initial });
    }

    // Main: Free -> paid -> scheduled upgrade -> paid renewal -> cancel -> exact access boundary.
    const mainCheckout = await prepareCheckout(users.main, 'main');
    await promptBrowser(`MAIN SUCCESS\nOpen the Polar Sandbox checkout shown below and complete it with the documented successful Sandbox test payment method:\n${mainCheckout.session.url}`);
    await waitForPlan(users.main.id, 'paid_entry', 1);
    const mainPaid = await snapshot(pool, lifecycle, users.main.id);
    assert.ok(mainPaid.subscription?.paid_through);
    assert.ok(mainPaid.payments.some(payment => payment.status === 'succeeded'));
    assert.ok(mainPaid.webhooks.some(event => event.event_type === 'order.paid' && event.state === 'PROCESSED'));
    const checkoutIdempotency = await assertSingleSubscriptionAfterCheckout(users.main, mainCheckout);
    await record('Free -> real checkout -> real payment -> real webhook -> PostgreSQL -> Paid', {
      userId: users.main.id,
      requestId: mainCheckout.requestId,
      providerCheckoutId: mainCheckout.session.checkoutId,
      idempotency: checkoutIdempotency,
      after: mainPaid,
    });

    const mainSubscriptionId = mainPaid.subscription.provider_subscription_id;
    const paymentsBeforeUpgrade = await paymentCount(users.main.id);
    await adapter.scheduleSubscriptionChange({ subscriptionId: mainSubscriptionId, offerId: 'highest_paid_monthly_v1' });
    await waitUntil('scheduled Highest projection', async () => (await subscriptionRow(users.main.id))?.next_plan_id === 'highest_paid');
    const scheduled = await snapshot(pool, lifecycle, users.main.id);
    assert.equal(scheduled.resolver.effectivePlanId, 'paid_entry');
    assert.equal(scheduled.resolver.billing.nextPlanId, 'highest_paid');
    await record('Paid Entry -> Highest is scheduled with next_period and not granted early', {
      userId: users.main.id,
      providerSubscriptionId: mainSubscriptionId,
      prorationBehavior: 'next_period',
      after: scheduled,
    });

    await adapter.rescheduleSubscriptionRenewal({
      subscriptionId: mainSubscriptionId,
      currentBillingPeriodEnd: new Date(Date.now() + RENEWAL_ACCELERATION_MS),
    });
    await waitForPlan(users.main.id, 'highest_paid', paymentsBeforeUpgrade + 1);
    const upgraded = await snapshot(pool, lifecycle, users.main.id);
    assert.ok(upgraded.payments.some(payment => payment.offer_id === 'highest_paid_monthly_v1' && payment.status === 'succeeded'));
    await record('Highest is granted only after a real new-period payment', {
      userId: users.main.id,
      providerSubscriptionId: mainSubscriptionId,
      renewalAcceleration: 'official Polar current_billing_period_end update',
      after: upgraded,
    });

    await adapter.cancelSubscriptionAtPeriodEnd({ subscriptionId: mainSubscriptionId });
    await waitUntil('cancel_at_period_end projection', async () => Boolean((await subscriptionRow(users.main.id))?.cancel_at_period_end));
    const canceled = await snapshot(pool, lifecycle, users.main.id);
    assert.equal(canceled.resolver.effectivePlanId, 'highest_paid');
    const paidThroughMs = new Date(canceled.subscription.paid_through).getTime();
    const beforeEnd = evidenceAccess(await lifecycle.resolveUserAccess(pool, users.main.id, new Date(paidThroughMs - 1)));
    const afterEnd = evidenceAccess(await lifecycle.resolveUserAccess(pool, users.main.id, new Date(paidThroughMs + 1)));
    assert.equal(beforeEnd.effectivePlanId, 'highest_paid');
    assert.equal(afterEnd.effectivePlanId, 'free');
    await record('real cancellation preserves Paid; exact paid_through expiration uses explicit local clock complement', {
      userId: users.main.id,
      providerSubscriptionId: mainSubscriptionId,
      providerCancellation: 'REAL_POLAR_SANDBOX',
      expirationBoundary: 'LOCAL_INJECTED_CLOCK_OVER_REAL_FINANCIAL_PAID_THROUGH',
      beforePaidThrough: beforeEnd,
      afterPaidThrough: afterEnd,
      afterRealCancellation: canceled,
    });

    // Refund user: full current-period refund + durable external revoke + independent grant survival.
    const refundCheckout = await prepareCheckout(users.refund, 'full_refund');
    await promptBrowser(`FULL REFUND SETUP\nComplete this Polar Sandbox checkout with the documented successful Sandbox test payment method:\n${refundCheckout.session.url}`);
    await waitForPlan(users.refund.id, 'paid_entry', 1);
    await insertIndependentGrant(pool, users.refund.id, key);
    const refundPayment = await latestPayment(users.refund.id);
    assert.ok(refundPayment?.provider_order_id && Number(refundPayment.amount_minor) > 0);
    await adapter.createRefund({
      orderId: refundPayment.provider_order_id,
      amountMinor: Number(refundPayment.amount_minor),
      reason: 'customer_request',
    });
    await waitUntil('full refund lifecycle', async () => {
      const state = await snapshot(pool, lifecycle, users.refund.id);
      return state.payments.some(payment => payment.provider_order_id === refundPayment.provider_order_id && payment.status === 'refunded')
        && state.resolver.commercialAccessState === 'invalidated'
        && state.providerActions.some(action => action.action_type === 'REVOKE_SUBSCRIPTION' && action.state === 'SUCCEEDED');
    });
    const fullRefund = await snapshot(pool, lifecycle, users.refund.id);
    assert.equal(fullRefund.resolver.effectivePlanId, 'paid_entry', 'independent grant did not survive full refund');
    assert.ok(fullRefund.grants.some(grant => grant.source === 'e2e_independent_grant' && grant.revoked_at == null));
    await record('real full refund invalidates commercial coverage, revokes provider, preserves independent grant', {
      userId: users.refund.id,
      providerOrderId: refundPayment.provider_order_id,
      providerSubscriptionId: refundPayment.provider_subscription_id,
      after: fullRefund,
    });

    // Recovery user: first charge failure -> same checkout success -> partial refund -> failed renewal/grace -> recovery.
    const recoveryCheckout = await prepareCheckout(users.recovery, 'recovery');
    await promptBrowser(`FIRST PAYMENT FAILURE\nOpen this SAME Polar Sandbox checkout and submit the documented generic-decline Sandbox test payment method. Do not recover it yet:\n${recoveryCheckout.session.url}`);
    await enqueueProcessing();
    const failedCheckout = await adapter.getCheckout(recoveryCheckout.session.checkoutId);
    const firstFailure = await snapshot(pool, lifecycle, users.recovery.id);
    assert.notEqual(String(failedCheckout.status || '').toLowerCase(), 'succeeded');
    assert.equal(firstFailure.resolver.effectivePlanId, 'free');
    assert.equal(firstFailure.payments.some(payment => payment.status === 'succeeded'), false);
    await record('real first payment failure remains Free', {
      userId: users.recovery.id,
      requestId: recoveryCheckout.requestId,
      providerCheckoutId: recoveryCheckout.session.checkoutId,
      providerCheckoutStatus: String(failedCheckout.status || '').toLowerCase(),
      after: firstFailure,
    });

    await promptBrowser('FIRST PAYMENT RECOVERY\nRetry that SAME hosted checkout with the documented successful Sandbox test payment method. Do not create another BeatGaler checkout.');
    await waitForPlan(users.recovery.id, 'paid_entry', 1);
    const recoveredPurchase = await snapshot(pool, lifecycle, users.recovery.id);
    const recoveryIdempotency = await assertSingleSubscriptionAfterCheckout(users.recovery, recoveryCheckout);
    await record('real payment recovery succeeds without a second BeatGaler subscription', {
      userId: users.recovery.id,
      requestId: recoveryCheckout.requestId,
      providerCheckoutId: recoveryCheckout.session.checkoutId,
      idempotency: recoveryIdempotency,
      after: recoveredPurchase,
    });

    const partialBase = await latestPayment(users.recovery.id);
    const partialAmount = Math.max(1, Math.floor(Number(partialBase.amount_minor) / 2));
    assert.ok(partialAmount < Number(partialBase.amount_minor));
    await adapter.createRefund({ orderId: partialBase.provider_order_id, amountMinor: partialAmount, reason: 'customer_request' });
    await waitUntil('partial refund projection', async () => {
      const payment = await latestPayment(users.recovery.id);
      return payment?.provider_order_id === partialBase.provider_order_id
        && payment?.status === 'partially_refunded'
        && Number(payment.refunded_amount_minor) === partialAmount;
    });
    const partialRefund = await snapshot(pool, lifecycle, users.recovery.id);
    assert.equal(partialRefund.resolver.effectivePlanId, 'paid_entry');
    assert.equal(partialRefund.providerActions.some(action => action.action_type === 'REVOKE_SUBSCRIPTION'), false);
    await record('real partial refund projects refunded amount without automatic access loss', {
      userId: users.recovery.id,
      providerOrderId: partialBase.provider_order_id,
      refundedAmountMinor: partialAmount,
      after: partialRefund,
    });

    const recoverySubscriptionId = partialRefund.subscription.provider_subscription_id;
    const failurePortal = await adapter.createCustomerPortal({ userId: users.recovery.id, returnUrl });
    await promptBrowser(`FAILED RENEWAL SETUP\nOpen the Polar Sandbox Customer Portal and replace the saved method with the documented Sandbox method that attaches successfully but declines future off-session charges:\n${failurePortal.url}`);
    const paymentsBeforeFailedRenewal = await paymentCount(users.recovery.id);
    await adapter.rescheduleSubscriptionRenewal({
      subscriptionId: recoverySubscriptionId,
      currentBillingPeriodEnd: new Date(Date.now() + RENEWAL_ACCELERATION_MS),
    });
    await waitUntil('subscription.past_due + BeatGaler grace', async () => {
      const row = await subscriptionRow(users.recovery.id);
      return row?.status === 'past_due' && row?.past_due_at && row?.grace_until;
    });
    const pastDue = await snapshot(pool, lifecycle, users.recovery.id);
    assert.equal(pastDue.resolver.effectivePlanId, 'paid_entry');
    assert.equal(pastDue.resolver.billing.providerStatus, 'past_due');
    assert.equal(new Date(pastDue.resolver.billing.graceUntil).getTime() - new Date(pastDue.resolver.billing.pastDueAt).getTime(), 7 * DAY_MS);
    await record('real failed renewal enters seven-day grace and does not grant a pending higher tier', {
      userId: users.recovery.id,
      providerSubscriptionId: recoverySubscriptionId,
      after: pastDue,
    });

    const recoveryPortal = await adapter.createCustomerPortal({ userId: users.recovery.id, returnUrl });
    await promptBrowser(`FAILED RENEWAL RECOVERY\nOpen the Polar Sandbox Customer Portal and restore the documented successful Sandbox test payment method. Polar should retry the failed charge:\n${recoveryPortal.url}`);
    await waitUntil('renewal recovery', async () => {
      const row = await subscriptionRow(users.recovery.id);
      return row?.status === 'active' && !row?.past_due_at && !row?.grace_until && await paymentCount(users.recovery.id) > paymentsBeforeFailedRenewal;
    });
    const renewalRecovered = await snapshot(pool, lifecycle, users.recovery.id);
    assert.equal(renewalRecovered.resolver.effectivePlanId, 'paid_entry');
    await record('real failed renewal recovers after confirmed payment', {
      userId: users.recovery.id,
      providerSubscriptionId: recoverySubscriptionId,
      after: renewalRecovered,
    });

    // Reconciliation: real provider objects + deliberate local drift + ambiguity + outage fault injection.
    const reconciliation = createBillingReconciliationService({ pool, adapter, lifecycle });
    const clean = await reconciliation.reconcileUser({ userId: users.recovery.id, reconciliationId: `task11_clean_${key}`, mode: 'task11-e2e' });
    assert.equal(clean.reconciled, true);
    await pool.query("UPDATE billing_subscription_state SET status='inactive',updated_at=now() WHERE user_id=$1", [users.recovery.id]);
    const repaired = await reconciliation.reconcileUser({ userId: users.recovery.id, reconciliationId: `task11_repair_${key}`, mode: 'task11-e2e' });
    assert.equal(repaired.reconciled, true);
    assert.equal(repaired.repaired, true);

    const customerRow = (await pool.query('SELECT provider_customer_id FROM billing_customers WHERE user_id=$1 AND provider=$2 AND provider_environment=$3', [users.recovery.id, PROVIDER, ENVIRONMENT])).rows[0];
    await pool.query('UPDATE billing_customers SET provider_customer_id=$2,updated_at=now() WHERE user_id=$1 AND provider=$3 AND provider_environment=$4', [users.recovery.id, `ambiguous_${key}`, PROVIDER, ENVIRONMENT]);
    const ambiguous = await reconciliation.reconcileUser({ userId: users.recovery.id, reconciliationId: `task11_ambiguous_${key}`, mode: 'task11-e2e' });
    assert.equal(ambiguous.reconciled, false);
    assert.equal(ambiguous.repairable, false);
    assert.equal(ambiguous.reason, 'BINDING_CONTRADICTION');
    await pool.query('UPDATE billing_customers SET provider_customer_id=$2,updated_at=now() WHERE user_id=$1 AND provider=$3 AND provider_environment=$4', [users.recovery.id, customerRow.provider_customer_id, PROVIDER, ENVIRONMENT]);
    await reconciliation.reconcileUser({ userId: users.recovery.id, reconciliationId: `task11_restore_${key}`, mode: 'task11-e2e' });

    const accessBeforeOutage = evidenceAccess(await lifecycle.resolveUserAccess(pool, users.recovery.id, new Date()));
    const outageAdapter = Object.freeze({
      ...adapter,
      listSubscriptionsForUser: async () => { throw Object.assign(new Error('forced provider outage'), { code: 'POLAR_SANDBOX_FORCED_OUTAGE' }); },
      listOrdersForUser: async () => { throw Object.assign(new Error('forced provider outage'), { code: 'POLAR_SANDBOX_FORCED_OUTAGE' }); },
    });
    let outageCode = null;
    try {
      await createBillingReconciliationService({ pool, adapter: outageAdapter, lifecycle }).reconcileUser({
        userId: users.recovery.id,
        reconciliationId: `task11_outage_${key}`,
        mode: 'task11-e2e-fault-injection',
      });
    } catch (error) { outageCode = safeErrorCode(error); }
    assert.equal(outageCode, 'BILLING_PROVIDER_UNAVAILABLE');
    const accessAfterOutage = evidenceAccess(await lifecycle.resolveUserAccess(pool, users.recovery.id, new Date()));
    assert.equal(accessAfterOutage.effectivePlanId, accessBeforeOutage.effectivePlanId);
    await record('reconciliation converges real Sandbox objects, repairs clear drift, refuses ambiguity, outage is not Free', {
      userId: users.recovery.id,
      clean: sanitizeReconciliation(clean),
      repaired: sanitizeReconciliation(repaired),
      ambiguous: sanitizeReconciliation(ambiguous),
      outageCode,
      accessBeforeOutage,
      accessAfterOutage,
      after: await snapshot(pool, lifecycle, users.recovery.id),
    });

    assert.ok(realSignedDeliveries.size > 0, 'no real signed Polar webhook delivery was received');
    evidence.result = 'PASS';
    evidence.completedAt = new Date().toISOString();
    await saveEvidence();
    console.log(`[billing-e2e] PASS. Sanitized evidence: ${evidenceFile}`);
  } catch (error) {
    evidence.result = 'FAIL';
    evidence.failedAt = new Date().toISOString();
    evidence.errorCode = safeErrorCode(error);
    await saveEvidence().catch(() => {});
    console.error(`[billing-e2e] FAIL ${evidence.errorCode}. Sanitized evidence: ${evidenceFile}`);
    process.exitCode = 1;
  } finally {
    if (rl) rl.close();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await processing.catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (process.env.BILLING_E2E_KEEP_DATABASE !== '1') {
      await dropDatabase(adminUrl, dbName).catch(error => console.error(`[billing-e2e] cleanup failed: ${safeErrorCode(error, 'BILLING_E2E_CLEANUP_FAILED')}`));
    }
  }
}

main().catch(error => {
  console.error(`[billing-e2e] bootstrap failure: ${safeErrorCode(error)}`);
  process.exitCode = 1;
});
