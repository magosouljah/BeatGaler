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

const DEFAULT_PORT = 4011;
const DEFAULT_WAIT_MS = 15 * 60 * 1000;
const POLL_MS = 1_000;
const RENEWAL_ACCELERATION_MS = 90_000;
const PROVIDER = 'polar';
const ENVIRONMENT = 'sandbox';

const SUCCESS_CARD = '4242 4242 4242 4242';
const FIRST_PAYMENT_DECLINE_CARD = '4000 0000 0000 0002';
const FUTURE_CHARGE_DECLINE_CARD = '4000 0000 0000 0341';

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    const error = new Error(`${name} is required.`);
    error.code = 'BILLING_E2E_ENV_REQUIRED';
    throw error;
  }
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    const error = new Error(`${name} must be a positive integer.`);
    error.code = 'BILLING_E2E_ENV_INVALID';
    throw error;
  }
  return value;
}

function safeErrorCode(error, fallback = 'BILLING_E2E_FAILED') {
  const code = String(error?.code || fallback).trim().toUpperCase();
  return /^[A-Z0-9_:-]{1,128}$/.test(code) ? code : fallback;
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function currentHead() {
  return git(['rev-parse', 'HEAD']);
}

function currentBranch() {
  return git(['branch', '--show-current']);
}

function runKey() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(4).toString('hex')}`;
}

function databaseName(key) {
  return `beatgaler_billing_e2e_${key.toLowerCase()}`.replace(/[^a-z0-9_]/g, '_').slice(0, 63);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function databaseUrl(adminUrl, name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function iso(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function userEmail(baseEmail, suffix) {
  const at = baseEmail.lastIndexOf('@');
  if (at <= 0) return baseEmail;
  const local = baseEmail.slice(0, at).replace(/\+.*/, '');
  return `${local}+${suffix}@${baseEmail.slice(at + 1)}`;
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

function assertNoSecrets(value, config) {
  const text = JSON.stringify(value);
  const forbiddenValues = [
    config.accessToken,
    config.webhookSecret,
    SUCCESS_CARD.replaceAll(' ', ''),
    FIRST_PAYMENT_DECLINE_CARD.replaceAll(' ', ''),
    FUTURE_CHARGE_DECLINE_CARD.replaceAll(' ', ''),
  ].filter(Boolean);
  for (const secret of forbiddenValues) {
    assert.equal(text.includes(secret), false, 'sanitized evidence contains a forbidden secret/value');
  }
  assert.equal(/polar_oat_[A-Za-z0-9_-]+/.test(text), false, 'sanitized evidence contains a Polar token');
  assert.equal(/(?:whsec_|polar_whs_)[A-Za-z0-9_-]+/.test(text), false, 'sanitized evidence contains a webhook secret');
}

async function defaultEvidencePath(key) {
  const gitPath = git(['rev-parse', '--git-path', 'beatgaler-billing-e2e']);
  const directory = path.isAbsolute(gitPath) ? gitPath : path.resolve(repoRoot(), gitPath);
  await fs.mkdir(directory, { recursive: true });
  return path.join(directory, `${key}.json`);
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

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function createIsolatedDatabase(adminUrl, name) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`);
  } finally {
    await admin.end();
  }
}

async function dropIsolatedDatabase(adminUrl, name) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',
      [name],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
  } finally {
    await admin.end();
  }
}

async function insertUser(pool, user) {
  await pool.query(
    'INSERT INTO users(id,email,created_at,updated_at) VALUES($1,$2,now(),now())',
    [user.id, user.email],
  );
}

async function insertIndependentGrant(pool, userId, key) {
  const startsAt = new Date(Date.now() - 60_000);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pool.query(`
    INSERT INTO entitlements(
      id,user_id,plan_id,source,starts_at,expires_at,source_key,issued_by_actor,created_at
    ) VALUES($1,$2,'paid_entry','e2e_independent_grant',$3,$4,$5,'task11-e2e',now())
  `, [`e2e_grant_${key}`, userId, startsAt, expiresAt, `task11:${key}`]);
}

async function sanitizedSnapshot(pool, lifecycle, userId, now = new Date()) {
  const [customerResult, checkoutResult, subscriptionResult, paymentsResult, eventsResult, actionsResult, grantsResult] = await Promise.all([
    pool.query(`
      SELECT provider_customer_id,external_id,created_at,updated_at
      FROM billing_customers WHERE user_id=$1 AND provider=$2 AND provider_environment=$3
      ORDER BY updated_at DESC
    `, [userId, PROVIDER, ENVIRONMENT]),
    pool.query(`
      SELECT request_id,offer_id,state,provider_checkout_id,expires_at,completed_at,last_error_code,created_at,updated_at
      FROM billing_checkout_requests WHERE user_id=$1 ORDER BY created_at,request_id
    `, [userId]),
    pool.query(`
      SELECT provider_customer_id,provider_subscription_id,offer_id,provider_product_id,provider_price_id,
             plan_id,status,cancel_at_period_end,current_period_start,current_period_end,paid_through,
             past_due_at,grace_until,ended_at,next_plan_id,next_interval,next_plan_effective_at,
             access_invalidated_at,invalidation_reason,last_synced_at,local_version,updated_at
      FROM billing_subscription_state WHERE user_id=$1
    `, [userId]),
    pool.query(`
      SELECT provider_payment_id,provider_order_id,provider_invoice_id,provider_subscription_id,offer_id,
             period_start,period_end,amount_minor,currency,status,refunded_amount_minor,
             invalidated_at,invalidation_reason,created_at,updated_at
      FROM billing_payments WHERE user_id=$1 ORDER BY created_at,provider_order_id
    `, [userId]),
    pool.query(`
      SELECT event_id,event_type,subject_id,state,attempt_count,provider_customer_id,provider_subscription_id,
             provider_checkout_id,received_at,processed_at,next_attempt_at,last_error_code
      FROM billing_webhook_events
      WHERE resolved_user_id=$1 OR provider_checkout_id IN (
        SELECT provider_checkout_id FROM billing_checkout_requests
        WHERE user_id=$1 AND provider_checkout_id IS NOT NULL
      )
      ORDER BY received_at,event_id
    `, [userId]),
    pool.query(`
      SELECT action_type,provider_subscription_id,state,attempt_count,next_attempt_at,last_error_code,succeeded_at,created_at,updated_at
      FROM billing_provider_actions WHERE user_id=$1 ORDER BY created_at,id
    `, [userId]),
    pool.query(`
      SELECT id,plan_id,source,source_key,starts_at,expires_at,revoked_at,revocation_reason
      FROM entitlements WHERE user_id=$1 ORDER BY starts_at,id
    `, [userId]),
  ]);
  const access = await lifecycle.resolveUserAccess(pool, userId, now);
  const convertDates = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ]));
  return {
    userId,
    at: now.toISOString(),
    customer: customerResult.rows.map(convertDates),
    checkouts: checkoutResult.rows.map(convertDates),
    subscription: subscriptionResult.rows[0] ? convertDates(subscriptionResult.rows[0]) : null,
    payments: paymentsResult.rows.map(convertDates),
    webhooks: eventsResult.rows.map(convertDates),
    providerActions: actionsResult.rows.map(convertDates),
    grants: grantsResult.rows.map(convertDates),
    resolver: evidenceAccess(access),
  };
}

async function latestPayment(pool, userId) {
  return (await pool.query(`
    SELECT * FROM billing_payments WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1
  `, [userId])).rows[0] || null;
}

async function subscriptionRow(pool, userId) {
  return (await pool.query('SELECT * FROM billing_subscription_state WHERE user_id=$1', [userId])).rows[0] || null;
}

async function paymentCount(pool, userId) {
  return Number((await pool.query('SELECT count(*)::int AS count FROM billing_payments WHERE user_id=$1', [userId])).rows[0]?.count || 0);
}

async function main() {
  const expectedHead = requiredEnv('BILLING_E2E_EXPECTED_HEAD');
  const adminUrl = requiredEnv('BILLING_E2E_TEST_ADMIN_URL');
  const baseEmail = requiredEnv('POLAR_SANDBOX_E2E_EMAIL');
  const port = positiveIntegerEnv('POLAR_SANDBOX_E2E_PORT', DEFAULT_PORT);
  const waitMs = positiveIntegerEnv('POLAR_SANDBOX_E2E_WAIT_MS', DEFAULT_WAIT_MS);
  const actualHead = currentHead();
  const branch = currentBranch();
  assert.equal(actualHead, expectedHead, 'checkout HEAD does not match BILLING_E2E_EXPECTED_HEAD');
  assert.equal(branch, 'billing/v1-policy', 'Task 11 runner must execute from billing/v1-policy');

  const adminDatabase = decodeURIComponent(new URL(adminUrl).pathname.replace(/^\//, ''));
  assert.equal(adminDatabase, 'postgres', 'BILLING_E2E_TEST_ADMIN_URL must target the postgres admin database');

  const config = readPolarSandboxConfig(process.env);
  assert.equal(config.provider, PROVIDER);
  assert.equal(config.environment, ENVIRONMENT);

  const key = runKey();
  const dbName = databaseName(key);
  const dbUrl = databaseUrl(adminUrl, dbName);
  const evidencePath = String(process.env.BILLING_E2E_EVIDENCE_PATH || '').trim() || await defaultEvidencePath(key);
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
    expectedOffer: 'paid_entry_monthly_v1',
    expectedUpgradeOffer: 'highest_paid_monthly_v1',
    configuredMappings: config.providerMappings,
    runId: key,
    branch,
    commitSha: actualHead,
    databaseName: dbName,
    databaseIsolated: true,
    startedAt: new Date().toISOString(),
    migrationsApplied: [],
    webhookTransport: 'Polar real delivery via official polar listen relay or an equivalent real Sandbox endpoint',
    receiptProofs: {},
    scenarios: [],
    result: 'RUNNING',
  };

  async function saveEvidence() {
    assertNoSecrets(evidence, config);
    await fs.mkdir(path.dirname(evidencePath), { recursive: true });
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }

  async function record(name, status, details = {}) {
    evidence.scenarios.push({ name, status, timestamp: new Date().toISOString(), ...details });
    await saveEvidence();
  }

  let pool = null;
  let server = null;
  let rl = null;
  let inbox = null;
  let lifecycle = null;
  let actionWorker = null;
  let processingChain = Promise.resolve();
  const realDeliveries = new Map();

  async function pump() {
    let processed = 0;
    while (processed < 100) {
      let row;
      try {
        row = await inbox.processNext({ workerId, handlers: lifecycle.handlers });
      } catch (error) {
        console.log(`[billing-e2e] webhook processing retryable failure: ${safeErrorCode(error)}`);
        break;
      }
      if (!row) break;
      processed += 1;
    }
    while (true) {
      let action;
      try {
        action = await actionWorker.processNext({ workerId });
      } catch (error) {
        console.log(`[billing-e2e] provider action retryable failure: ${safeErrorCode(error)}`);
        break;
      }
      if (!action) break;
    }
  }

  function queuePump() {
    processingChain = processingChain.then(pump, pump);
    return processingChain;
  }

  async function waitUntil(label, predicate, timeoutMs = waitMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await queuePump();
      if (await predicate()) return;
      await sleep(POLL_MS);
    }
    const error = new Error(`${label} did not become true before the E2E wait limit.`);
    error.code = 'BILLING_E2E_WAIT_TIMEOUT';
    throw error;
  }

  async function prompt(message) {
    output.write(`\n${message}\n`);
    await rl.question('Press Enter only after that browser step is complete... ');
  }

  async function prepareCheckout(user, label) {
    const before = await sanitizedSnapshot(pool, lifecycle, user.id);
    assert.equal(before.resolver.effectivePlanId, 'free');
    const requestId = `task11_${label}_${key}`.slice(0, 120);
    const service = createPersistentCheckoutService({
      pool,
      adapter,
      allowedCallbackOrigins: [`http://127.0.0.1:${port}`],
    });
    const session = await service.createSession({
      user,
      request: { requestId, offerId: 'paid_entry_monthly_v1' },
      successUrl,
      returnUrl,
    });
    assert.equal(session.state, 'OPEN');
    assert.equal(session.entitlementGranted, false);

    const retry = await service.createSession({
      user,
      request: { requestId, offerId: 'paid_entry_monthly_v1' },
      successUrl,
      returnUrl,
    });
    assert.equal(retry.recovered, true);
    assert.equal(retry.checkoutId, session.checkoutId);

    let secondAttemptCode = null;
    try {
      await service.createSession({
        user,
        request: { requestId: `${requestId}_near`, offerId: 'paid_entry_monthly_v1' },
        successUrl,
        returnUrl,
      });
    } catch (error) {
      secondAttemptCode = safeErrorCode(error);
    }
    assert.equal(secondAttemptCode, 'BILLING_CHECKOUT_UNRESOLVED_EXISTS');

    assert.equal(await httpGet(successUrl), 200);
    const afterRedirectOnly = await sanitizedSnapshot(pool, lifecycle, user.id);
    assert.equal(afterRedirectOnly.resolver.effectivePlanId, 'free');

    await record(`${label}: checkout idempotency and redirect authority`, 'PASS', {
      userId: user.id,
      requestId,
      providerCheckoutId: session.checkoutId,
      sameRequestRecovered: true,
      nearSecondAttemptBlockedWith: secondAttemptCode,
      redirectWithoutFinancialEvidenceEffectivePlanId: afterRedirectOnly.resolver.effectivePlanId,
      before,
      after: afterRedirectOnly,
    });

    return { service, requestId, session };
  }

  async function waitForPaid(user, expectedPlan = 'paid_entry', minPayments = 1) {
    await waitUntil(`${user.id} access ${expectedPlan}`, async () => {
      const access = await lifecycle.resolveUserAccess(pool, user.id, new Date());
      return access.effectivePlanId === expectedPlan && await paymentCount(pool, user.id) >= minPayments;
    });
  }

  async function verifyCheckoutTerminalIdempotency(user, checkout) {
    const row = await checkout.service.getRequest({ userId: user.id, requestId: checkout.requestId });
    assert.equal(row.state, 'COMPLETED');
    let retryCode = null;
    try {
      await checkout.service.createSession({
        user,
        request: { requestId: checkout.requestId, offerId: 'paid_entry_monthly_v1' },
        successUrl,
        returnUrl,
      });
    } catch (error) {
      retryCode = safeErrorCode(error);
    }
    assert.equal(retryCode, 'BILLING_CHECKOUT_COMPLETED');
    const providerSubscriptions = await adapter.listSubscriptionsForUser({ userId: user.id, limit: 20 });
    assert.equal(providerSubscriptions.items.length, 1, 'retry journey created more than one commercial subscription');
    return { retryCode, providerSubscriptionCount: providerSubscriptions.items.length };
  }

  let adapter;
  try {
    await createIsolatedDatabase(adminUrl, dbName);
    pool = new Pool({ connectionString: dbUrl, max: 6 });
    evidence.migrationsApplied = listMigrations();
    await applyMigrations(pool, evidence.migrationsApplied);
    for (const user of Object.values(users)) await insertUser(pool, user);

    adapter = createPolarSandboxLifecycleAdapter({ config });
    const paidMapping = await adapter.validateOfferMapping('paid_entry_monthly_v1');
    const highMapping = await adapter.validateOfferMapping('highest_paid_monthly_v1');
    assert.equal(paidMapping.planId, 'paid_entry');
    assert.equal(highMapping.planId, 'highest_paid');

    lifecycle = createBillingLifecycle({ adapter });
    inbox = createDurableWebhookInbox({ pool, adapter, retryBaseMs: 1_000 });
    actionWorker = createBillingProviderActionWorker({ pool, adapter, retryBaseMs: 1_000 });

    server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
        if (req.method === 'POST' && requestUrl.pathname === '/webhooks/polar') {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 256 * 1024) throw Object.assign(new Error('body too large'), { code: 'WEBHOOK_BODY_TOO_LARGE' });
            chunks.push(chunk);
          }
          const rawBody = Buffer.concat(chunks);
          const headers = { ...req.headers };
          const receipt = await inbox.receive({ rawBody, headers });
          if (!receipt.duplicate) {
            const replay = await inbox.receive({ rawBody, headers });
            assert.equal(replay.duplicate, true);
            evidence.receiptProofs[receipt.eventId] = {
              persistedBeforeProcessing: receipt.state === 'RECEIVED',
              exactRealSignedReplayDeduplicated: true,
              firstReceivedAt: new Date().toISOString(),
            };
            realDeliveries.set(receipt.eventId, true);
            await saveEvidence();
          }
          res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('accepted');
          setImmediate(() => queuePump().catch(() => {}));
          return;
        }
        if (req.method === 'GET' && ['/billing/success', '/billing/return'].includes(requestUrl.pathname)) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('BeatGaler Billing Sandbox callback received. Access still comes from PostgreSQL billing facts.');
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      } catch (error) {
        res.writeHead(error?.code === 'WEBHOOK_INVALID_SIGNATURE' ? 403 : 500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('billing webhook rejected');
      }
    });
    await listen(server, port);
    rl = createInterface({ input, output });

    console.log(`[billing-e2e] provider=${adapter.provider} environment=${adapter.environment}`);
    console.log(`[billing-e2e] isolated database=${dbName}`);
    console.log(`[billing-e2e] HEAD=${actualHead}`);
    console.log(`[billing-e2e] webhook target=http://127.0.0.1:${port}/webhooks/polar`);
    console.log('[billing-e2e] The Polar access token and webhook secret are never printed or stored in evidence.');

    for (const [label, user] of Object.entries(users)) {
      const initial = await sanitizedSnapshot(pool, lifecycle, user.id);
      assert.equal(initial.resolver.effectivePlanId, 'free');
      await record(`${label}: initial Free`, 'PASS', { userId: user.id, after: initial });
    }

    // Scenario 1: main commercial journey + scheduled plan change + cancellation boundary.
    const mainCheckout = await prepareCheckout(users.main, 'main');
    await prompt(
      `MAIN SUCCESSFUL CHECKOUT\nOpen this Polar Sandbox checkout:\n${mainCheckout.session.url}\nUse the Sandbox success card ${SUCCESS_CARD}, any future expiry and any CVC.`,
    );
    await waitForPaid(users.main, 'paid_entry', 1);
    const mainPaid = await sanitizedSnapshot(pool, lifecycle, users.main.id);
    const mainIdempotency = await verifyCheckoutTerminalIdempotency(users.main, mainCheckout);
    assert.ok(mainPaid.subscription?.paid_through, 'paid_through was not projected from real financial evidence');
    assert.ok(mainPaid.payments.some(payment => payment.status === 'succeeded'));
    assert.ok(mainPaid.webhooks.some(event => event.event_type === 'order.paid' && event.state === 'PROCESSED'));
    await record('Free -> real checkout -> real webhook -> PostgreSQL -> Paid', 'PASS', {
      userId: users.main.id,
      requestId: mainCheckout.requestId,
      providerCheckoutId: mainCheckout.session.checkoutId,
      idempotency: mainIdempotency,
      after: mainPaid,
    });

    const mainSubscriptionId = mainPaid.subscription.provider_subscription_id;
    const paymentsBeforeUpgrade = mainPaid.payments.length;
    await adapter.scheduleSubscriptionChange({
      subscriptionId: mainSubscriptionId,
      offerId: 'highest_paid_monthly_v1',
    });
    await waitUntil('scheduled Highest plan reflected locally', async () => {
      const row = await subscriptionRow(pool, users.main.id);
      return row?.next_plan_id === 'highest_paid';
    });
    const scheduledUpgrade = await sanitizedSnapshot(pool, lifecycle, users.main.id);
    assert.equal(scheduledUpgrade.resolver.effectivePlanId, 'paid_entry');
    assert.equal(scheduledUpgrade.resolver.billing.nextPlanId, 'highest_paid');
    await record('Paid Entry -> Highest scheduled with next_period', 'PASS', {
      userId: users.main.id,
      providerSubscriptionId: mainSubscriptionId,
      prorationBehavior: 'next_period',
      higherTierGrantedBeforeNewPayment: false,
      after: scheduledUpgrade,
    });

    await adapter.rescheduleSubscriptionRenewal({
      subscriptionId: mainSubscriptionId,
      currentBillingPeriodEnd: new Date(Date.now() + RENEWAL_ACCELERATION_MS),
    });
    await waitForPaid(users.main, 'highest_paid', paymentsBeforeUpgrade + 1);
    const upgradedPaid = await sanitizedSnapshot(pool, lifecycle, users.main.id);
    assert.ok(upgradedPaid.payments.some(payment => payment.offer_id === 'highest_paid_monthly_v1' && payment.status === 'succeeded'));
    await record('scheduled plan change becomes Highest only after real renewal payment', 'PASS', {
      userId: users.main.id,
      providerSubscriptionId: mainSubscriptionId,
      acceleration: 'official Polar current_billing_period_end sandbox-compatible subscription update',
      after: upgradedPaid,
    });

    await adapter.cancelSubscriptionAtPeriodEnd({ subscriptionId: mainSubscriptionId });
    await waitUntil('cancel_at_period_end projected', async () => Boolean((await subscriptionRow(pool, users.main.id))?.cancel_at_period_end));
    const canceled = await sanitizedSnapshot(pool, lifecycle, users.main.id);
    assert.equal(canceled.resolver.effectivePlanId, 'highest_paid');
    assert.equal(canceled.resolver.billing.cancelAtPeriodEnd, true);
    const paidThrough = new Date(canceled.subscription.paid_through).getTime();
    const immediatelyBeforeEnd = evidenceAccess(await lifecycle.resolveUserAccess(pool, users.main.id, new Date(paidThrough - 1)));
    const immediatelyAfterEnd = evidenceAccess(await lifecycle.resolveUserAccess(pool, users.main.id, new Date(paidThrough + 1)));
    assert.equal(immediatelyBeforeEnd.effectivePlanId, 'highest_paid');
    assert.equal(immediatelyAfterEnd.effectivePlanId, 'free');
    await record('real cancellation keeps Paid until exact paid_through boundary', 'PASS', {
      userId: users.main.id,
      providerSubscriptionId: mainSubscriptionId,
      providerCancellation: 'REAL_SANDBOX',
      temporalBoundaryVerification: 'LOCAL_INJECTED_CLOCK_OVER_REAL_PAID_THROUGH',
      beforePaidThrough: immediatelyBeforeEnd,
      afterPaidThrough: immediatelyAfterEnd,
      afterRealCancellationEvent: canceled,
    });

    // Scenario 2: full refund + independent grant survival + durable external revoke.
    const refundCheckout = await prepareCheckout(users.refund, 'refund_full');
    await prompt(
      `FULL REFUND CHECKOUT\nOpen this Polar Sandbox checkout:\n${refundCheckout.session.url}\nUse ${SUCCESS_CARD}, any future expiry and any CVC.`,
    );
    await waitForPaid(users.refund, 'paid_entry', 1);
    await insertIndependentGrant(pool, users.refund.id, key);
    const beforeFullRefund = await sanitizedSnapshot(pool, lifecycle, users.refund.id);
    const paidForRefund = await latestPayment(pool, users.refund.id);
    assert.ok(paidForRefund?.provider_order_id);
    assert.ok(Number(paidForRefund.amount_minor) > 0);
    await adapter.createRefund({
      orderId: paidForRefund.provider_order_id,
      amountMinor: Number(paidForRefund.amount_minor),
      reason: 'customer_request',
    });
    await waitUntil('full refund invalidates commercial coverage and external revoke succeeds', async () => {
      const state = await sanitizedSnapshot(pool, lifecycle, users.refund.id);
      return state.payments.some(payment => payment.provider_order_id === paidForRefund.provider_order_id && payment.status === 'refunded')
        && state.resolver.commercialAccessState === 'invalidated'
        && state.providerActions.some(action => action.action_type === 'REVOKE_SUBSCRIPTION' && action.state === 'SUCCEEDED');
    });
    const afterFullRefund = await sanitizedSnapshot(pool, lifecycle, users.refund.id);
    assert.equal(afterFullRefund.resolver.commercialAccessState, 'invalidated');
    assert.equal(afterFullRefund.resolver.effectivePlanId, 'paid_entry', 'independent grant should survive full refund');
    assert.ok(afterFullRefund.grants.some(grant => grant.source === 'e2e_independent_grant' && grant.revoked_at == null));
    await record('full current-period refund invalidates commerce, revokes provider, preserves independent grant', 'PASS', {
      userId: users.refund.id,
      providerOrderId: paidForRefund.provider_order_id,
      providerSubscriptionId: paidForRefund.provider_subscription_id,
      before: beforeFullRefund,
      after: afterFullRefund,
    });

    // Scenario 3: failed initial payment -> same checkout recovery -> partial refund -> failed renewal grace -> recovery.
    const recoveryCheckout = await prepareCheckout(users.recovery, 'recovery');
    await prompt(
      `FIRST PURCHASE FAILURE\nOpen this Polar Sandbox checkout:\n${recoveryCheckout.session.url}\nFirst use the Stripe/Polar Sandbox generic decline card ${FIRST_PAYMENT_DECLINE_CARD}. Do not switch to the success card yet.`,
    );
    await queuePump();
    const failedCheckoutState = await adapter.getCheckout(recoveryCheckout.session.checkoutId);
    const afterFirstFailure = await sanitizedSnapshot(pool, lifecycle, users.recovery.id);
    assert.notEqual(String(failedCheckoutState.status || '').toLowerCase(), 'succeeded');
    assert.equal(afterFirstFailure.resolver.effectivePlanId, 'free');
    assert.equal(afterFirstFailure.payments.some(payment => payment.status === 'succeeded'), false);
    await record('first purchase failed remains Free', 'PASS', {
      userId: users.recovery.id,
      requestId: recoveryCheckout.requestId,
      providerCheckoutId: recoveryCheckout.session.checkoutId,
      providerCheckoutStatus: String(failedCheckoutState.status || '').toLowerCase(),
      after: afterFirstFailure,
    });

    await prompt(
      `RECOVER THE SAME CHECKOUT\nOn the SAME Polar checkout session, retry with ${SUCCESS_CARD}, any future expiry and any CVC. Do not create a second BeatGaler checkout.`,
    );
    await waitForPaid(users.recovery, 'paid_entry', 1);
    const afterInitialRecovery = await sanitizedSnapshot(pool, lifecycle, users.recovery.id);
    const recoveredIdempotency = await verifyCheckoutTerminalIdempotency(users.recovery, recoveryCheckout);
    await record('successful payment recovers the failed initial purchase without a second subscription', 'PASS', {
      userId: users.recovery.id,
      requestId: recoveryCheckout.requestId,
      providerCheckoutId: recoveryCheckout.session.checkoutId,
      idempotency: recoveredIdempotency,
      after: afterInitialRecovery,
    });

    const partialPayment = await latestPayment(pool, users.recovery.id);
    const partialAmount = Math.max(1, Math.floor(Number(partialPayment.amount_minor) / 2));
    assert.ok(partialAmount < Number(partialPayment.amount_minor));
    await adapter.createRefund({
      orderId: partialPayment.provider_order_id,
      amountMinor: partialAmount,
      reason: 'customer_request',
    });
    await waitUntil('partial refund projected', async () => {
      const payment = await latestPayment(pool, users.recovery.id);
      return payment?.provider_order_id === partialPayment.provider_order_id
        && payment?.status === 'partially_refunded'
        && Number(payment.refunded_amount_minor) === partialAmount;
    });
    const afterPartialRefund = await sanitizedSnapshot(pool, lifecycle, users.recovery.id);
    assert.equal(afterPartialRefund.resolver.effectivePlanId, 'paid_entry');
    assert.equal(afterPartialRefund.providerActions.some(action => action.action_type === 'REVOKE_SUBSCRIPTION'), false);
    await record('partial refund updates PostgreSQL without automatic access loss', 'PASS', {
      userId: users.recovery.id,
      providerOrderId: partialPayment.provider_order_id,
      refundedAmountMinor: partialAmount,
      after: afterPartialRefund,
    });

    const recoverySubscriptionId = afterPartialRefund.subscription.provider_subscription_id;
    const portal = await adapter.createCustomerPortal({ userId: users.recovery.id, returnUrl });
    await prompt(
      `PREPARE A REAL FAILED RENEWAL\nOpen the Polar Sandbox Customer Portal:\n${portal.url}\nUpdate the saved payment method to ${FUTURE_CHARGE_DECLINE_CARD}. This Stripe test card attaches successfully but future charges decline.`,
    );
    const paymentsBeforeFailedRenewal = await paymentCount(pool, users.recovery.id);
    await adapter.rescheduleSubscriptionRenewal({
      subscriptionId: recoverySubscriptionId,
      currentBillingPeriodEnd: new Date(Date.now() + RENEWAL_ACCELERATION_MS),
    });
    await waitUntil('real renewal becomes past_due', async () => {
      const row = await subscriptionRow(pool, users.recovery.id);
      return row?.status === 'past_due' && row?.past_due_at && row?.grace_until;
    });
    const pastDue = await sanitizedSnapshot(pool, lifecycle, users.recovery.id);
    assert.equal(pastDue.resolver.effectivePlanId, 'paid_entry');
    assert.equal(pastDue.resolver.billing.providerStatus, 'past_due');
    assert.ok(pastDue.resolver.billing.graceUntil);
    const graceDuration = new Date(pastDue.resolver.billing.graceUntil).getTime() - new Date(pastDue.resolver.billing.pastDueAt).getTime();
    assert.equal(graceDuration, 7 * 24 * 60 * 60 * 1000);
    await record('real failed renewal enters seven-day BeatGaler grace without granting a higher tier', 'PASS', {
      userId: users.recovery.id,
      providerSubscriptionId: recoverySubscriptionId,
      effectivePlanDuringGrace: pastDue.resolver.effectivePlanId,
      graceDurationMs: graceDuration,
      after: pastDue,
    });

    const recoveryPortal = await adapter.createCustomerPortal({ userId: users.recovery.id, returnUrl });
    await prompt(
      `RECOVER THE FAILED RENEWAL\nOpen the Polar Sandbox Customer Portal:\n${recoveryPortal.url}\nReplace the failed card with ${SUCCESS_CARD}. Polar should retry the failed charge; do not create another BeatGaler checkout.`,
    );
    await waitUntil('real renewal payment recovers', async () => {
      const row = await subscriptionRow(pool, users.recovery.id);
      return row?.status === 'active'
        && !row?.past_due_at
        && !row?.grace_until
        && await paymentCount(pool, users.recovery.id) > paymentsBeforeFailedRenewal;
    });
    const afterRenewalRecovery = await sanitizedSnapshot(pool, lifecycle, users.recovery.id);
    assert.equal(afterRenewalRecovery.resolver.effectivePlanId, 'paid_entry');
    await record('real failed renewal recovers after successful payment', 'PASS', {
      userId: users.recovery.id,
      providerSubscriptionId: recoverySubscriptionId,
      after: afterRenewalRecovery,
    });

    // Reconciliation against the real Sandbox objects.
    const reconciliation = createBillingReconciliationService({ pool, adapter, lifecycle });
    const cleanReconcile = await reconciliation.reconcileUser({
      userId: users.recovery.id,
      reconciliationId: `task11_clean_${key}`,
      mode: 'task11-e2e',
    });
    assert.equal(cleanReconcile.reconciled, true);

    await pool.query("UPDATE billing_subscription_state SET status='inactive',updated_at=now() WHERE user_id=$1", [users.recovery.id]);
    const repaired = await reconciliation.reconcileUser({
      userId: users.recovery.id,
      reconciliationId: `task11_repair_${key}`,
      mode: 'task11-e2e',
    });
    assert.equal(repaired.reconciled, true);
    assert.equal(repaired.repaired, true);

    const realCustomerId = (await pool.query(
      'SELECT provider_customer_id FROM billing_customers WHERE user_id=$1 AND provider=$2 AND provider_environment=$3',
      [users.recovery.id, PROVIDER, ENVIRONMENT],
    )).rows[0].provider_customer_id;
    await pool.query(
      'UPDATE billing_customers SET provider_customer_id=$2,updated_at=now() WHERE user_id=$1 AND provider=$3 AND provider_environment=$4',
      [users.recovery.id, `ambiguous_${key}`, PROVIDER, ENVIRONMENT],
    );
    const ambiguous = await reconciliation.reconcileUser({
      userId: users.recovery.id,
      reconciliationId: `task11_ambiguous_${key}`,
      mode: 'task11-e2e',
    });
    assert.equal(ambiguous.reconciled, false);
    assert.equal(ambiguous.repairable, false);
    assert.equal(ambiguous.reason, 'BINDING_CONTRADICTION');
    await pool.query(
      'UPDATE billing_customers SET provider_customer_id=$2,updated_at=now() WHERE user_id=$1 AND provider=$3 AND provider_environment=$4',
      [users.recovery.id, realCustomerId, PROVIDER, ENVIRONMENT],
    );
    await reconciliation.reconcileUser({
      userId: users.recovery.id,
      reconciliationId: `task11_restore_${key}`,
      mode: 'task11-e2e',
    });

    const accessBeforeOutage = evidenceAccess(await lifecycle.resolveUserAccess(pool, users.recovery.id, new Date()));
    const outageAdapter = Object.freeze({
      ...adapter,
      listSubscriptionsForUser: async () => { throw Object.assign(new Error('forced provider outage'), { code: 'POLAR_SANDBOX_FORCED_OUTAGE' }); },
      listOrdersForUser: async () => { throw Object.assign(new Error('forced provider outage'), { code: 'POLAR_SANDBOX_FORCED_OUTAGE' }); },
    });
    const outageReconciliation = createBillingReconciliationService({ pool, adapter: outageAdapter, lifecycle });
    let outageCode = null;
    try {
      await outageReconciliation.reconcileUser({
        userId: users.recovery.id,
        reconciliationId: `task11_outage_${key}`,
        mode: 'task11-e2e-fault-injection',
      });
    } catch (error) {
      outageCode = safeErrorCode(error);
    }
    assert.equal(outageCode, 'BILLING_PROVIDER_UNAVAILABLE');
    const accessAfterOutage = evidenceAccess(await lifecycle.resolveUserAccess(pool, users.recovery.id, new Date()));
    assert.equal(accessAfterOutage.effectivePlanId, accessBeforeOutage.effectivePlanId);

    await record('reconciliation converges real objects, repairs clear drift, refuses ambiguous drift, outage is not Free', 'PASS', {
      userId: users.recovery.id,
      cleanReconcile,
      unequivocalRepair: repaired,
      ambiguousResult: ambiguous,
      outageFaultInjectionCode: outageCode,
      accessBeforeOutage,
      accessAfterOutage,
      after: await sanitizedSnapshot(pool, lifecycle, users.recovery.id),
    });

    assert.ok(Object.keys(evidence.receiptProofs).length > 0, 'no real signed webhook receipts were recorded');
    assert.ok(realDeliveries.size > 0, 'no real webhook delivery passed signature verification');
    evidence.result = 'PASS';
    evidence.completedAt = new Date().toISOString();
    await saveEvidence();
    console.log(`[billing-e2e] PASS. Sanitized evidence: ${evidencePath}`);
  } catch (error) {
    evidence.result = 'FAIL';
    evidence.failedAt = new Date().toISOString();
    evidence.errorCode = safeErrorCode(error);
    await saveEvidence().catch(() => {});
    console.error(`[billing-e2e] FAIL ${evidence.errorCode}. Sanitized evidence: ${evidencePath}`);
    process.exitCode = 1;
  } finally {
    if (rl) rl.close();
    if (server) await closeServer(server).catch(() => {});
    await processingChain.catch(() => {});
    if (pool) await pool.end().catch(() => {});
    if (process.env.BILLING_E2E_KEEP_DATABASE !== '1') {
      await dropIsolatedDatabase(adminUrl, dbName).catch(error => {
        console.error(`[billing-e2e] isolated database cleanup failed: ${safeErrorCode(error, 'BILLING_E2E_CLEANUP_FAILED')}`);
      });
    }
  }
}

main().catch(error => {
  console.error(`[billing-e2e] bootstrap failure: ${safeErrorCode(error)}`);
  process.exitCode = 1;
});
