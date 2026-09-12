#!/usr/bin/env node
'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const { isDeepStrictEqual } = require('node:util');
const { execFileSync } = require('node:child_process');
const { Client, Pool } = require('pg');
const { applyMigrations, listMigrations } = require('../postgres-migrations');
const { createPersistentCheckoutService } = require('../billing-checkout-persistent');
const { createDurableWebhookInbox } = require('../billing-webhook-durable');
const { createBillingLifecycle, createBillingProviderActionWorker } = require('../billing-lifecycle');
const { createBillingReconciliationService } = require('../billing-reconciliation');
const { MODE, ENTRY, HIGHEST, check, text, readConfig, createAdapter } = require('./polar-sandbox-daily-config.cjs');
const { databaseName, identity, writeState, readState, orderEvidence, assertPaidOrder, assertBefore, proveRenewal } = require('./polar-sandbox-daily-state.cjs');
const ROOT = path.resolve(__dirname, '../..');
const delay = ms => new Promise(r => setTimeout(r, ms));
const code = error => /^[A-Z0-9_:-]{1,160}$/.test(error?.code || '') ? error.code : 'DAILY_OPERATION_FAILED';
const iso = value => value ? new Date(value).toISOString() : null;
function git(args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim(); }
function dbUrl(adminUrl, name) {
  const url = new URL(adminUrl);
  check(['127.0.0.1','localhost','[::1]'].includes(url.hostname) && url.pathname === '/postgres', 'DAILY_LOCAL_ADMIN_DATABASE_REQUIRED');
  url.pathname = `/${name}`; return url.toString();
}
async function verifyMarker(pool, state) {
  const actual = (await pool.query('SELECT current_database() AS name')).rows[0].name;
  check(actual === state.databaseName, 'DAILY_DATABASE_CONNECTION_MISMATCH');
  const marker = (await pool.query('SELECT identity FROM task11_daily_run WHERE singleton=true')).rows[0]?.identity;
  check(isDeepStrictEqual(marker, identity(state)), 'DAILY_DATABASE_RUN_MISMATCH');
}
async function initializeDatabase(adminUrl, state) {
  check(state.databaseName === databaseName(state.runId), 'DAILY_DATABASE_NAME_INVALID');
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  let exists;
  try {
    exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [state.databaseName])).rowCount > 0;
    if (!exists) await admin.query(`CREATE DATABASE "${state.databaseName}"`);
  } finally { await admin.end(); }
  const pool = new Pool({ connectionString: dbUrl(adminUrl, state.databaseName), max: 6 });
  try {
    if (exists) { await verifyMarker(pool, state); return pool; }
    await applyMigrations(pool, listMigrations());
    // Harness-only tables, created exclusively inside this run's isolated database.
    await pool.query(`CREATE TABLE task11_daily_run(singleton boolean PRIMARY KEY CHECK(singleton), identity jsonb NOT NULL);
      CREATE TABLE task11_daily_receipts(event_id text PRIMARY KEY, signature_verified boolean NOT NULL, replay_deduplicated boolean NOT NULL, received_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE task11_daily_observations(id bigserial PRIMARY KEY, observed_at timestamptz NOT NULL DEFAULT now(), snapshot jsonb NOT NULL);`);
    await pool.query('INSERT INTO task11_daily_run VALUES(true,$1::jsonb)', [JSON.stringify(identity(state))]);
    return pool;
  } catch (e) { await pool.end(); throw e; }
}
async function snapshot(pool, lifecycle, state) {
  const sub = (await pool.query('SELECT provider_subscription_id,provider_customer_id,paid_through,next_plan_id,current_period_end,status FROM billing_subscription_state WHERE user_id=$1', [state.userId])).rows[0];
  const payments = (await pool.query('SELECT provider_order_id,status,period_start,period_end,amount_minor,offer_id FROM billing_payments WHERE user_id=$1 ORDER BY created_at,provider_order_id', [state.userId])).rows;
  const access = await lifecycle.resolveUserAccess(pool, state.userId, new Date());
  return { at: new Date().toISOString(), effectivePlanId: access.effectivePlanId, nextPlanId: sub?.next_plan_id || null,
    subscriptionId: sub?.provider_subscription_id || null, customerId: sub?.provider_customer_id || null,
    providerStatus: sub?.status || null, paidThrough: iso(sub?.paid_through), periodEnd: iso(sub?.current_period_end),
    payments: payments.map(p => ({ orderId: p.provider_order_id, status: p.status, periodStart: iso(p.period_start), periodEnd: iso(p.period_end), amountMinor: p.amount_minor, offerId: p.offer_id })) };
}
async function receiptProofs(pool, state) {
  return (await pool.query(`SELECT e.event_id AS "eventId",e.event_type AS "eventType",e.subject_id AS "subjectId",e.state,
    r.signature_verified AS "signatureVerified",r.replay_deduplicated AS "replayDeduplicated",r.received_at AS "receivedAt"
    FROM billing_webhook_events e JOIN task11_daily_receipts r ON r.event_id=e.event_id
    WHERE e.resolved_user_id=$1 ORDER BY r.received_at`, [state.userId])).rows;
}
async function openRuntime({ pool, adapter, state, port, env }) {
  const lifecycle = createBillingLifecycle({ adapter });
  const inbox = createDurableWebhookInbox({ pool, adapter, retryBaseMs: 1000 });
  const actions = createBillingProviderActionWorker({ pool, adapter, retryBaseMs: 1000 });
  const workerId = `daily_${state.runId}`;
  let chain = Promise.resolve(); let stopping = false;
  async function observe() {
    const s = await snapshot(pool, lifecycle, state);
    await pool.query('INSERT INTO task11_daily_observations(snapshot) VALUES($1::jsonb)', [JSON.stringify(s)]);
    if (s.effectivePlanId === 'highest_paid') {
      check(s.payments.filter(p => p.status === 'succeeded').length >= 2, 'DAILY_HIGHEST_GRANTED_EARLY');
    }
    return s;
  }
  function processPending() {
    chain = chain.catch(() => {}).then(async () => {
      if (stopping) return;
      for (let i = 0; i < 100; i++) { const event = await inbox.processNext({ workerId, handlers: lifecycle.handlers }); if (!event) break; await observe(); }
      for (let i = 0; i < 20; i++) if (!await actions.processNext({ workerId })) break;
    });
    return chain;
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/webhooks/polar') {
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; check(size <= 262144, 'DAILY_WEBHOOK_TOO_LARGE'); chunks.push(chunk); }
        const rawBody = Buffer.concat(chunks), headers = { ...req.headers };
        // Verify and persist first; replay the exact received bytes/signature, never construct a provider event.
        const receipt = await inbox.receive({ rawBody, headers });
        const replay = await inbox.receive({ rawBody, headers });
        check(replay.duplicate === true, 'DAILY_REPLAY_NOT_DEDUPLICATED');
        await pool.query('INSERT INTO task11_daily_receipts(event_id,signature_verified,replay_deduplicated) VALUES($1,true,true) ON CONFLICT(event_id) DO NOTHING', [receipt.eventId]);
        res.writeHead(202).end('accepted');
        processPending().catch(e => console.error(`[daily] worker ${code(e)}`)); return;
      }
      if (req.method === 'GET' && ['/billing/success','/billing/return'].includes(req.url?.split('?')[0])) {
        res.writeHead(200, { 'content-type':'text/plain' }).end('Sandbox callback. Access depends on verified financial evidence.'); return;
      }
      if (req.method === 'GET' && req.url === '/checkout') {
        const row = (await pool.query('SELECT checkout_url FROM billing_checkout_requests WHERE user_id=$1 AND request_id=$2 AND state=\'OPEN\'', [state.userId,state.requestId])).rows[0];
        if (!row) { res.writeHead(409).end('Checkout unavailable or already completed.'); return; }
        res.writeHead(303, { Location: row.checkout_url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end(); return;
      }
      if (req.method === 'GET' && req.url === '/health') { res.writeHead(200).end('daily-sandbox'); return; }
      res.writeHead(404).end();
    } catch (e) { console.error(`[daily] endpoint ${code(e)}`); if (!res.headersSent) res.writeHead(400); res.end('rejected'); }
  });
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve); });
  const timer = setInterval(() => processPending().catch(e => console.error(`[daily] worker ${code(e)}`)), 2000);
  return { lifecycle, observe, processPending, async close() { stopping=true; clearInterval(timer); await chain.catch(()=>{}); await new Promise(r=>server.close(r)); } };
}
async function main(argv = process.argv.slice(2), env = process.env) {
  const phase = argv[0]; check(['start','resume','listen'].includes(phase), 'DAILY_PHASE_REQUIRED');
  const config = readConfig(env);
  const expectedHead = text(env,'BILLING_E2E_EXPECTED_HEAD');
  check(git(['rev-parse','HEAD']) === expectedHead && git(['branch','--show-current']) === 'billing/v1-policy', 'DAILY_HEAD_OR_BRANCH_MISMATCH');
  check(git(['diff','--ignore-cr-at-eol','--stat','HEAD','--','cloud-server', '.github/workflows']).length === 0, 'DAILY_COMMITTED_CODE_REQUIRED');
  check(env.POLAR_SANDBOX_E2E_WEBHOOK_TRANSPORT === 'polar-cli-listen', 'DAILY_REAL_RELAY_REQUIRED');
  const adminUrl = text(env,'BILLING_E2E_TEST_ADMIN_URL');
  dbUrl(adminUrl, 'postgres');
  const port = Number(env.POLAR_SANDBOX_E2E_PORT || 4011);
  check(Number.isInteger(port) && port > 1024 && port < 65536, 'DAILY_PORT_INVALID');
  const adapter = createAdapter(config);
  // These API reads must finish before CREATE DATABASE or checkout mutations.
  const products = [await adapter.validateOfferMapping(ENTRY), await adapter.validateOfferMapping(HIGHEST)];
  let state, file = argv[1];
  if (phase === 'start') {
    check(!file, 'DAILY_START_TAKES_NO_STATE_FILE');
    const runId = new Date().toISOString().replace(/\D/g,'').slice(0,14) + '_' + crypto.randomBytes(4).toString('hex');
    state = { schemaVersion:1, mode:MODE, provider:'polar', environment:'sandbox',runId,commitSha:expectedHead,
      databaseName:databaseName(runId),organizationId:config.organizationId,products,userId:`daily_${runId}`,
      requestId:`daily_${runId}`, startedAt:new Date().toISOString(), result:'RUNNING',checkpoint:'INITIALIZING',scenarios:[] };
    file = path.join(ROOT,'.billing-e2e',`${runId}.json`);
    await writeState(file,state,[config.accessToken,config.webhookSecret,adminUrl]);
  } else {
    check(file, 'DAILY_STATE_FILE_REQUIRED');
    state = await readState(file, { commitSha:expectedHead,runId:text(env,'BILLING_E2E_RUN_ID'),databaseName:text(env,'BILLING_E2E_DATABASE_NAME') });
    check(JSON.stringify(products) === JSON.stringify(state.products) && state.organizationId === config.organizationId, 'DAILY_RESUME_PRODUCTS_MISMATCH');
  }
  console.log(`[daily] databaseName=${state.databaseName} runId=${state.runId} state=${file}`);
  const save = async () => { state.updatedAt = new Date().toISOString(); await writeState(file,state,[config.accessToken,config.webhookSecret,adminUrl]); };
  let pool, runtime, lock;
  try {
    pool = phase === 'start' ? await initializeDatabase(adminUrl,state) : new Pool({ connectionString:dbUrl(adminUrl,state.databaseName),max:6 });
    await verifyMarker(pool,state);
    lock = await pool.connect();
    // One runtime per run prevents competing snapshots and mutations. Released with the pool on exit.
    check((await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[`daily-runtime:${state.runId}`])).rows[0].acquired,'DAILY_RUN_ALREADY_ACTIVE');
    runtime = await openRuntime({ pool,adapter,state,port,env });
    if (phase === 'listen') {
      console.log('[daily] LISTENING; keep this runtime and the official relay active for real renewal webhook delivery.');
      await new Promise(resolve => { process.once('SIGINT',resolve); process.once('SIGTERM',resolve); }); return;
    }
    const waitMs = Number(env.POLAR_SANDBOX_E2E_WAIT_MS || 1800000);
    check(Number.isSafeInteger(waitMs) && waitMs > 0 && waitMs <= 3600000,'DAILY_WAIT_INVALID');
    async function waitFor(predicate) {
      const deadline = Date.now()+waitMs;
      while (Date.now()<deadline) {
        await runtime.processPending();
        const observed = await snapshot(pool,runtime.lifecycle,state);
        check(observed.effectivePlanId!=='highest_paid' || observed.payments.filter(p=>p.status==='succeeded').length>=2,'DAILY_HIGHEST_GRANTED_EARLY');
        if (await predicate()) return; await delay(2000);
      }
      check(false,'DAILY_WAIT_TIMEOUT');
    }
    if (!state.initialOrder) {
      const email = text(env,'POLAR_SANDBOX_E2E_EMAIL');
      await pool.query('INSERT INTO users(id,email,created_at,updated_at) VALUES($1,$2,now(),now()) ON CONFLICT(id) DO NOTHING',[state.userId,email.replace('@',`+${state.runId}@`)]);
      const initial = await snapshot(pool,runtime.lifecycle,state);
      const service = createPersistentCheckoutService({ pool,adapter,allowedCallbackOrigins:[`http://127.0.0.1:${port}`] });
      if (!state.checkoutId) {
        check(initial.effectivePlanId === 'free','DAILY_INITIAL_FREE_REQUIRED');
        const args = { user:{id:state.userId,email:email.replace('@',`+${state.runId}@`)},request:{requestId:state.requestId,offerId:ENTRY},successUrl:`http://127.0.0.1:${port}/billing/success`,returnUrl:`http://127.0.0.1:${port}/billing/return` };
        const session = await service.createSession(args);
        state.checkoutId = session.checkoutId; state.checkpoint='CHECKOUT_OPEN'; await save();
        const retry = await service.createSession(args); check(retry.checkoutId===session.checkoutId && retry.recovered,'DAILY_CHECKOUT_RETRY_FAILED');
        let nearCode; try { await service.createSession({...args,request:{...args.request,requestId:`${state.requestId}_near`}}); } catch(e) { nearCode=e.code; }
        check(nearCode==='BILLING_CHECKOUT_UNRESOLVED_EXISTS','DAILY_NEAR_RETRY_NOT_BLOCKED');
        await fetch(`http://127.0.0.1:${port}/billing/success`);
        check((await snapshot(pool,runtime.lifecycle,state)).effectivePlanId==='free','DAILY_REDIRECT_GRANTED_ACCESS');
        state.scenarios.push({name:'checkout_retry_redirect',result:'PASS',checkoutId:state.checkoutId,nearRetryCode:nearCode}); await save();
      }
      console.log(`[daily] HUMAN_CHECKOUT http://127.0.0.1:${port}/checkout`);
      await waitFor(async()=> {
        const s=await snapshot(pool,runtime.lifecycle,state), receipts=await receiptProofs(pool,state);
        return s.effectivePlanId==='paid_entry' && s.payments.length===1 && receipts.some(p=>p.eventType==='order.paid'&&p.state==='PROCESSED');
      });
      const paid = await snapshot(pool,runtime.lifecycle,state);
      const first = orderEvidence(await adapter.getFinancialOrder(paid.payments[0].orderId)); assertPaidOrder(first);
      check(first.billingReason==='subscription_create' && first.productId===products[0].productId && first.priceId===products[0].priceId
        && first.amountMinor===products[0].amountMinor && first.subscriptionId===paid.subscriptionId,'DAILY_INITIAL_ORDER_MISMATCH');
      const subscriptions=await adapter.listSubscriptionsForUser({userId:state.userId});
      check(!subscriptions.truncated && subscriptions.items.length===1 && subscriptions.items[0].id===paid.subscriptionId,'DAILY_SINGLE_SUBSCRIPTION_REQUIRED');
      state.initialOrder=first;state.subscriptionId=paid.subscriptionId;state.customerId=paid.customerId;state.initialPaymentCount=paid.payments.length;
      state.expectedRenewalAt=iso((await adapter.getSubscription(state.subscriptionId)).current_period_end);
      check(state.expectedRenewalAt===first.periodEnd,'DAILY_INITIAL_COVERAGE_MISMATCH');
      state.checkpoint='INITIAL_PAID';state.scenarios.push({name:'initial_paid_real_webhook',result:'PASS',after:paid,receipts:await receiptProofs(pool,state)});await save();
    }
    if (!state.preRenewal) {
      check(Date.now()<Date.parse(state.expectedRenewalAt),'DAILY_MISSED_UPGRADE_WINDOW');
      if (state.codeTransitions?.length) {
        const beforeRepair=await snapshot(pool,runtime.lifecycle,state);
        const reconciler=createBillingReconciliationService({pool,adapter,lifecycle:runtime.lifecycle});
        const repaired=await reconciler.reconcileUser({userId:state.userId,reconciliationId:`daily-code-repair:${state.runId}:${Date.now()}`});
        check(repaired.reconciled,'DAILY_REPAIR_RECONCILIATION_FAILED');
        const afterRepair=await snapshot(pool,runtime.lifecycle,state);
        assertBefore(afterRepair,state.initialOrder.id);
        state.scenarios.push({name:'real_provider_reconciliation_after_code_repair',result:'PASS',before:beforeRepair,after:afterRepair});
        await save();
      }
      const sub=await adapter.getSubscription(state.subscriptionId);
      if (!sub.pending_update) await adapter.scheduleSubscriptionChange({subscriptionId:state.subscriptionId,offerId:HIGHEST});
      else check(sub.pending_update.product_id===products[1].productId,'DAILY_UNEXPECTED_PENDING_CHANGE');
      await waitFor(async()=> (await snapshot(pool,runtime.lifecycle,state)).nextPlanId==='highest_paid');
      const before=await snapshot(pool,runtime.lifecycle,state);assertBefore(before,state.initialOrder.id);
      const scheduled=await adapter.getSubscription(state.subscriptionId);
      check(iso(scheduled.current_period_end)===state.expectedRenewalAt && scheduled.pending_update?.product_id===products[1].productId,'DAILY_PERIOD_OR_PENDING_CHANGE_MISMATCH');
      state.preRenewal=before;state.checkpoint='UPGRADE_SCHEDULED';state.result='WAITING_FOR_NATURAL_RENEWAL';await save();
    }
    await runtime.processPending();
    const rawOrders=await adapter.listOrdersForUser({userId:state.userId});check(!rawOrders.truncated,'DAILY_ORDER_LIST_TRUNCATED');
    const candidates=rawOrders.items.filter(o=>o.subscription_id===state.subscriptionId&&o.id!==state.initialOrder.id&&o.billing_reason==='subscription_cycle'&&o.paid===true)
      .sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
    if (!candidates.length) {
      const s=await snapshot(pool,runtime.lifecycle,state);check(s.effectivePlanId!=='highest_paid','DAILY_HIGHEST_GRANTED_EARLY');
      if (Date.now()>Date.parse(state.expectedRenewalAt)+1800000) check(false,'DAILY_NO_SECOND_PAID_ORDER');
      state.result='WAITING_FOR_NATURAL_RENEWAL';await save();
      console.log(`[daily] WAITING_FOR_NATURAL_RENEWAL UTC=${state.expectedRenewalAt} Mexico=${new Date(state.expectedRenewalAt).toLocaleString('es-MX',{timeZone:'America/Mexico_City',timeZoneName:'short'})}`);return;
    }
    const renewal=orderEvidence(await adapter.getFinancialOrder(candidates[0].id));state.renewalOrder=renewal;await save();
    const observations=(await pool.query('SELECT snapshot FROM task11_daily_observations ORDER BY id')).rows.map(r=>r.snapshot);
    check(!observations.some(s=>s.effectivePlanId==='highest_paid'&&!s.payments.some(p=>p.orderId===renewal.id&&p.status==='succeeded')),'DAILY_HIGHEST_GRANTED_EARLY');
    const beforeReconciliation=await snapshot(pool,runtime.lifecycle,state);
    const reconciliation=createBillingReconciliationService({pool,adapter,lifecycle:runtime.lifecycle});
    const reconciled=await reconciliation.reconcileUser({userId:state.userId,reconciliationId:`daily:${state.runId}:${Date.now()}`});
    check(reconciled.reconciled,'DAILY_RECONCILIATION_FAILED');
    const repeated=await reconciliation.reconcileUser({userId:state.userId,reconciliationId:`daily-repeat:${state.runId}:${Date.now()}`});
    check(repeated.reconciled && !repeated.repaired,'DAILY_RECONCILIATION_NOT_STABLE');
    const after=await snapshot(pool,runtime.lifecycle,state), receipts=await receiptProofs(pool,state);
    const subscription=await adapter.getSubscription(state.subscriptionId);
    state.verification={beforeReconciliation,after,receipts,reconciliation:{reconciled:reconciled.reconciled,repaired:reconciled.repaired,repeatRepaired:repeated.repaired},observations};
    // Persist financial/reconciliation evidence even if the relay missed the renewal webhook.
    await save();
    try { proveRenewal({state,order:renewal,subscription,after,webhookProofs:receipts}); }
    catch(e) { if(e.code==='DAILY_REAL_RENEWAL_WEBHOOK_REQUIRED'){state.result='PARTIAL';state.lastErrorCode=e.code;await save();console.log('[daily] PARTIAL: real paid renewal reconciled; real renewal webhook receipt still missing.');return;}throw e; }
    state.result='PASS';state.checkpoint='RENEWAL_VERIFIED';
    state.scenarios.push({name:'natural_daily_paid_renewal',result:'PASS',initialOrderId:state.initialOrder.id,renewalOrderId:renewal.id});
    await save();console.log('[daily] RENOVACIÓN REAL DAILY: PASS. Task 11 overall remains PARTIAL; other scenarios are tracked separately.');
  } catch(e) {
    if (runtime || phase==='start') { state.result=e.code==='DAILY_WAIT_TIMEOUT'?'PARTIAL':'FAIL';state.lastErrorCode=code(e);await save(); }
    throw e;
  } finally {
    if(runtime) await runtime.close();
    if(lock) { await lock.query('SELECT pg_advisory_unlock(hashtext($1))',[`daily-runtime:${state.runId}`]).catch(()=>{});lock.release(); }
    if(pool) await pool.end();
    console.log(`[daily] databaseName=${state.databaseName} PRESERVED; evidence=${file}`);
  }
}
if(require.main===module) main().catch(e=>{console.error(`[daily] ${code(e)}`);process.exitCode=1;});
module.exports={main,dbUrl,initializeDatabase,verifyMarker,snapshot,receiptProofs,openRuntime};
