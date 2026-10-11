'use strict';
// Isolated provider-real probe. Source hash and committed SHA are pinned per run.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '../..');
const r = createRequire(path.join(root, 'cloud-server/package.json'));
const { Client, Pool } = r('pg');
const express = r('express');
const { check } = r('./scripts/polar-sandbox-daily-config.cjs');
const { sanitize } = r('./scripts/polar-sandbox-daily-state.cjs');
const { snapshot } = r('./scripts/polar-sandbox-daily-e2e.cjs');
const { refreshFailureHeader } = require('./polar-sandbox-failure-progress.cjs');
const { readPolarSandboxConfig, createPinnedSandboxClient, POLAR_SDK_ENTRY } = r('./billing-polar-sandbox');
const { createPolarSandboxLifecycleAdapter } = r('./billing-polar-lifecycle-adapter');
const { createDurableWebhookInbox } = r('./billing-webhook-durable');
const { installPolarWebhookRoute } = r('./billing-webhook-route');
const { createLifecycleWorker } = r('./billing-lifecycle-runtime');
const { createPersistentCheckoutService } = r('./billing-checkout-persistent');
const { applyMigrations, listMigrations } = r('./postgres-migrations');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
const iso = value => value ? new Date(value).toISOString() : null;
const safeCode = e => /^[A-Z0-9_:-]{1,128}$/.test(e?.code || '') ? e.code : 'FAILURE_PROBE_FAILED';
async function main(argv, env = process.env) {
  const phase = argv[0]; check(['start','resume'].includes(phase), 'FAILURE_PHASE_REQUIRED');
  check(env.NODE_ENV !== 'production' && env.BILLING_PROVIDER_ENVIRONMENT === 'sandbox', 'FAILURE_SANDBOX_REQUIRED');
  check(git(['rev-parse','HEAD']) === env.BILLING_E2E_EXPECTED_HEAD && git(['branch','--show-current']) === 'integration-v0.9.0-alpha.4', 'FAILURE_HEAD_MISMATCH');
  check(!git(['diff','--ignore-cr-at-eol','--stat','HEAD','--','cloud-server']), 'FAILURE_COMMITTED_SOURCE_REQUIRED');
  const config = r('./scripts/polar-sandbox-daily-config.cjs').readConfig(env);
  const adapter = r('./scripts/polar-sandbox-daily-config.cjs').createAdapter(config);
  const client = createPinnedSandboxClient({ config, sdk: r(POLAR_SDK_ENTRY) });
  const products = await Promise.all(['e2e_daily_paid_entry_v1','e2e_daily_highest_paid_v1'].map(id => adapter.validateOfferMapping(id)));
  const adminUrl = new URL(env.BILLING_E2E_TEST_ADMIN_URL);
  check(['localhost','127.0.0.1'].includes(adminUrl.hostname) && adminUrl.pathname === '/postgres', 'FAILURE_LOCAL_ADMIN_REQUIRED');
  const toolSha256 = digest(fs.readFileSync(__filename));
  let file = argv[1], state;
  if (phase === 'start') {
    check(!file, 'FAILURE_START_NO_FILE');
    const runId = new Date().toISOString().replace(/\D/g,'').slice(0,14)+'_'+crypto.randomBytes(4).toString('hex');
    state = { schemaVersion:1, mode:'failure_sandbox', runId, databaseName:`beatgaler_billing_e2e_failure_${runId}`,
      userId:`failure_${runId}`, requestId:`failure_${runId}`, commitSha:env.BILLING_E2E_EXPECTED_HEAD, toolSha256,
      provider:'polar', environment:'sandbox', organizationId:config.organizationId, products,
      offerId:'e2e_daily_paid_entry_v1', startedAt:new Date().toISOString(), result:'PARTIAL', checkpoint:'INITIALIZING', observations:[] };
    file = path.join(root, '.billing-e2e', `${runId}.failure.json`);
  } else {
    check(file, 'FAILURE_STATE_REQUIRED');
    const envelope = JSON.parse(fs.readFileSync(file));
    check(envelope.sha256 === digest(JSON.stringify(envelope.state)), 'FAILURE_STATE_DIGEST_MISMATCH'); state = envelope.state;
    check(state.commitSha === env.BILLING_E2E_EXPECTED_HEAD && state.toolSha256 === toolSha256, 'FAILURE_CODE_MISMATCH');
    check(state.mode === 'failure_sandbox' && state.provider === 'polar' && state.environment === 'sandbox', 'FAILURE_STATE_INVALID');
    check(state.organizationId === config.organizationId && JSON.stringify(state.products) === JSON.stringify(products), 'FAILURE_PRODUCT_MISMATCH');
  }
  check(/^[0-9]{14}_[a-f0-9]{8}$/.test(state.runId) && state.databaseName === `beatgaler_billing_e2e_failure_${state.runId}` && state.userId === `failure_${state.runId}`, 'FAILURE_DATABASE_BINDING');
  const save = () => {
    state.updatedAt = new Date().toISOString(); sanitize(state, [config.accessToken,config.webhookSecret,env.BILLING_E2E_TEST_ADMIN_URL]);
    fs.writeFileSync(file+'.tmp', JSON.stringify({ sha256:digest(JSON.stringify(state)), state },null,2)+'\n', { mode:0o600 }); fs.renameSync(file+'.tmp',file);
  };
  const identity = {runId:state.runId,commitSha:state.commitSha,toolSha256,databaseName:state.databaseName,organizationId:state.organizationId,mode:state.mode};
  if (phase === 'start') {
    save(); const admin = new Client({ connectionString:adminUrl.toString() }); await admin.connect();
    try { await admin.query(`CREATE DATABASE "${state.databaseName}"`); } finally { await admin.end(); }
  }
  adminUrl.pathname = '/'+state.databaseName;
  const pool = new Pool({ connectionString:adminUrl.toString(), max:8 });
  if (phase === 'start') {
    await applyMigrations(pool,listMigrations());
    await pool.query(`CREATE TABLE step14_run(singleton boolean PRIMARY KEY CHECK(singleton),identity jsonb NOT NULL);
      CREATE TABLE step14_receipts(event_id text PRIMARY KEY,signature_verified boolean NOT NULL,replay_deduplicated boolean NOT NULL,received_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE step14_observations(id bigserial PRIMARY KEY,observed_at timestamptz NOT NULL DEFAULT now(),snapshot jsonb NOT NULL);`);
    await pool.query('INSERT INTO step14_run VALUES(true,$1::jsonb)',[JSON.stringify(identity)]);
  }
  const marker = (await pool.query('SELECT identity FROM step14_run WHERE singleton=true')).rows[0]?.identity;
  check(require('util').isDeepStrictEqual(marker,identity), 'FAILURE_RUN_MARKER_MISMATCH');
  check((await pool.query('SELECT current_database() AS name')).rows[0].name === state.databaseName, 'FAILURE_CONNECTED_DB_MISMATCH');
  const lock = await pool.connect();
  check((await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked',[state.runId])).rows[0].locked, 'FAILURE_ALREADY_RUNNING');
  const inbox = createDurableWebhookInbox({pool,adapter});
  const worker = createLifecycleWorker({pool,adapter,inbox,onError:(area,code)=>console.log('[failure] worker',area,code)});
  const app = express();
  installPolarWebhookRoute(app,express,{currentInbox:()=>({receive:async input=>{
    const receipt=await inbox.receive(input);const replay=await inbox.receive(input);
    check(replay.duplicate,'FAILURE_REPLAY_NOT_DEDUPLICATED');
    await pool.query('INSERT INTO step14_receipts VALUES($1,true,true,now()) ON CONFLICT DO NOTHING',[receipt.eventId]);return receipt;
  }})});
  app.get(['/billing/success','/billing/return'],(_req,res)=>res.type('text').send('Sandbox callback. Access depends on verified financial evidence.'));
  app.get('/health',(_req,res)=>res.type('text').send('failure-sandbox'));
  app.get('/portal',async(_req,res)=>{
    try {
      const access=await snapshot(pool,worker.lifecycle,state);
      check(access.customerId&&access.subscriptionId,'FAILURE_PORTAL_CUSTOMER_REQUIRED');
      const portal=await adapter.createCustomerPortal({userId:state.userId,returnUrl:'http://127.0.0.1:4013/billing/return'});
      const target=new URL(portal.url);check(target.protocol==='https:'&&target.hostname==='sandbox.polar.sh','FAILURE_PORTAL_SANDBOX_REQUIRED');
      res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).redirect(303,target.toString());
    }catch(e){console.log('[failure] PORTAL_ERROR',safeCode(e));res.status(503).send('Sandbox portal unavailable.');}
  });
  app.get('/checkout',async(_req,res)=>{
    const row=(await pool.query("SELECT checkout_url FROM billing_checkout_requests WHERE user_id=$1 AND request_id=$2 AND state='OPEN'",[state.userId,state.requestId])).rows[0];
    if(!row)return res.status(409).send('Checkout unavailable or completed.');res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).redirect(303,row.checkout_url);
  });
  const server=await new Promise((resolve,reject)=>{const s=app.listen(4013,'127.0.0.1',()=>resolve(s));s.once('error',reject)});
  worker.start();
  const email=env.POLAR_SANDBOX_E2E_EMAIL.replace('@',`+${state.runId}@`);
  await pool.query('INSERT INTO users(id,email,created_at,updated_at) VALUES($1,$2,now(),now()) ON CONFLICT(id) DO NOTHING',[state.userId,email]);
  const checkout=createPersistentCheckoutService({pool,adapter,allowedCallbackOrigins:['http://127.0.0.1:4013']});
  if(!state.checkoutId){
    const args={user:{id:state.userId,email},request:{requestId:state.requestId,offerId:state.offerId},successUrl:'http://127.0.0.1:4013/billing/success',returnUrl:'http://127.0.0.1:4013/billing/return'};
    const session=await checkout.createSession(args);state.checkoutId=session.checkoutId;state.checkpoint='CHECKOUT_OPEN';save();
    check((await checkout.createSession(args)).checkoutId===state.checkoutId,'FAILURE_CHECKOUT_RETRY');
    await fetch('http://127.0.0.1:4013/billing/success');
    const before=await snapshot(pool,worker.lifecycle,state);check(before.effectivePlanId==='free','FAILURE_PREMATURE_ACCESS');
    state.observations.push({name:'checkout_redirect_before_payment',at:new Date().toISOString(),snapshot:before});save();
  }
  console.log(`[failure] OBSERVING run=${state.runId} sha=${state.commitSha}`);
  let stopping=false, timer, active=Promise.resolve(), last='';
  async function observe(){
    const access=await snapshot(pool,worker.lifecycle,state);
    const page=await client.payments.list({organization_id:config.organizationId,...(access.customerId?{customer_id:access.customerId}:{checkout_id:state.checkoutId}),limit:100});
    check(page.pagination.total_count===page.items.length&&page.pagination.max_page<=1,'FAILURE_PAYMENTS_TRUNCATED');
    const payments=await Promise.all(page.items.map(async p=>{
      check(p.organization_id===state.organizationId,'FAILURE_PAYMENT_ORGANIZATION_BINDING');
      if(p.order_id){
        const order=await adapter.getOrder(p.order_id);
        check(order.id===p.order_id&&order.customer?.organization_id===state.organizationId&&order.customer?.external_id===state.userId,'FAILURE_PAYMENT_ORDER_OWNER_BINDING');
        check(access.customerId?order.customer_id===access.customerId&&order.subscription_id===access.subscriptionId:order.checkout_id===state.checkoutId,'FAILURE_PAYMENT_ORDER_BINDING');
      }else check(p.checkout_id===state.checkoutId,'FAILURE_PAYMENT_CHECKOUT_BINDING');
      return{id:p.id,checkoutId:p.checkout_id,orderId:p.order_id,status:p.status,amountMinor:p.amount,currency:p.currency,processor:p.processor,trigger:p.trigger,createdAt:iso(p.created_at)};
    }));
    const current=await adapter.getCheckout(state.checkoutId);
    const evidence={at:new Date().toISOString(),checkoutStatus:current.status,financialPayments:payments,snapshot:access};
    const fingerprint=JSON.stringify({payments,access:{...access,at:undefined},checkoutStatus:current.status});
    const newObservation=fingerprint!==last;
    if(fingerprint!==last){
      await pool.query('INSERT INTO step14_observations(snapshot) VALUES($1::jsonb)',[JSON.stringify(sanitize(evidence))]);
      state.observations.push(evidence);
    }
    // Rebuild milestones from the preserved timeline, including after restart.
    // Successful polling clears the current error even if finances did not change.
    const headerChanged=refreshFailureHeader(state,evidence.at);
    if(newObservation||headerChanged){
      save();console.log(`[failure] ${state.checkpoint} access=${access.effectivePlanId} providerPayments=${payments.map(p=>p.status).join(',')||'none'}`);
    }
    last=fingerprint;
  }
  function schedule(){if(stopping)return;timer=setTimeout(()=>{active=observe().catch(e=>{console.log('[failure] OBSERVATION_ERROR',safeCode(e));state.lastErrorCode=safeCode(e);save();}).finally(schedule)},5000)}
  schedule();
  await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve)});
  stopping=true;clearTimeout(timer);await active;await worker.stop();await new Promise(resolve=>server.close(resolve));lock.release();await pool.end();
}
module.exports={main};
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error('[failure]',safeCode(e));process.exitCode=1});
