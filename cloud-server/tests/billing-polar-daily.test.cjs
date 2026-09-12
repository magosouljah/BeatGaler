'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createCommercialCatalog } = require('../billing-commercial-catalog');
const { validateProviderProductForOffer } = require('../billing-polar-sandbox');
const { MODE,ENTRY,HIGHEST,ENV,readConfig,createCatalog,validateDailyProduct,createAdapter } = require('../scripts/polar-sandbox-daily-config.cjs');
const { databaseName,sanitize,identity,writeState,readState,orderEvidence,assertBefore,proveRenewal } = require('../scripts/polar-sandbox-daily-state.cjs');
const { dbUrl,verifyMarker } = require('../scripts/polar-sandbox-daily-e2e.cjs');
function env() { return { [ENV.mode]:MODE,[ENV.provider]:'polar',[ENV.environment]:'sandbox',POLAR_SANDBOX_ACCESS_TOKEN:'fixture-private-access',POLAR_SANDBOX_WEBHOOK_SECRET:'fixture-private-signing',POLAR_SANDBOX_ORGANIZATION_ID:'org',
  [ENV.entryProduct]:'entry-product',[ENV.entryPrice]:'entry-price',[ENV.entryAmount]:'20000',
  [ENV.highestProduct]:'highest-product',[ENV.highestPrice]:'highest-price',[ENV.highestAmount]:'10000' }; }
function product(offer) {return {id:offer.providerMapping.productId,organization_id:'org',is_archived:false,recurring_interval:'day',recurring_interval_count:1,
  prices:[{id:offer.providerMapping.priceId,is_archived:false,amount_type:'fixed',price_currency:'usd',price_amount:offer.amountMinor,recurring_interval:'day'}]};}
function fixture() {
  const config=readConfig(env()), catalog=createCatalog(config);
  const products=[ENTRY,HIGHEST].map(id=>validateDailyProduct({product:product(catalog.offers[id]),offer:catalog.offers[id],organizationId:'org'}));
  const runId='20260912000000_aabbccdd';
  const first={id:'A',subscriptionId:'sub',customerId:'customer',productId:products[0].productId,priceId:products[0].priceId,billingReason:'subscription_create',status:'paid',paid:true,amountMinor:20000,currency:'usd',refundedAmountMinor:0,createdAt:'2026-09-12T00:00:00.000Z',periodStart:'2026-09-12T00:00:00.000Z',periodEnd:'2026-09-13T00:00:00.000Z'};
  const order={...first,id:'B',productId:products[1].productId,priceId:products[1].priceId,amountMinor:10000,billingReason:'subscription_cycle',createdAt:'2026-09-13T00:00:02.000Z',periodStart:first.periodEnd,periodEnd:'2026-09-14T00:00:00.000Z'};
  first.payments=[{id:'payment-A',orderId:'A',status:'succeeded',amountMinor:20000,currency:'usd',processor:'stripe',trigger:'purchase'}];
  order.payments=[{id:'payment-B',orderId:'B',status:'succeeded',amountMinor:10000,currency:'usd',processor:'stripe',trigger:'subscription_cycle'}];
  const state={schemaVersion:1,mode:MODE,provider:'polar',environment:'sandbox',runId,commitSha:'a'.repeat(40),databaseName:databaseName(runId),organizationId:'org',products,userId:`daily_${runId}`,startedAt:first.createdAt,subscriptionId:'sub',customerId:'customer',initialOrder:first,expectedRenewalAt:first.periodEnd,
    preRenewal:{effectivePlanId:'paid_entry',nextPlanId:'highest_paid',payments:[{orderId:'A',status:'succeeded'}]}};
  return {state,order,subscription:{id:'sub',current_period_end:order.periodEnd},after:{effectivePlanId:'highest_paid',paidThrough:order.periodEnd,payments:[{orderId:'B',status:'succeeded',periodEnd:order.periodEnd}]},webhookProofs:[{eventType:'order.paid',subjectId:'B',state:'PROCESSED',signatureVerified:true,replayDeduplicated:true}]};
}
test('daily isolated catalog accepts day/1 with distinct offer IDs and keeps monthly domain',()=>{
  const cfg=readConfig(env()), cat=createCatalog(cfg);
  assert.equal(cat.offers[ENTRY].interval,'month');assert.equal(cat.offers[ENTRY].providerInterval,'day');
  assert.equal(cat.offers[HIGHEST].planId,'highest_paid');assert.equal(cat.offers.paid_entry_monthly_v1,undefined);
  assert.equal(validateDailyProduct({product:product(cat.offers[ENTRY]),offer:cat.offers[ENTRY],organizationId:'org'}).interval,'day');
  assert.equal(createCommercialCatalog().offers.paid_entry_monthly_v1.interval,'month');
});
test('normal monthly validation still rejects a daily product',()=>{
  const normal=createCommercialCatalog({providerMappings:{paid_entry_monthly_v1:{productId:'entry-product',priceId:'entry-price'}}}).offers.paid_entry_monthly_v1;
  assert.throws(()=>validateProviderProductForOffer({product:product(normal),offer:normal,organizationId:'org'}),/interval/);
});
for(const [key,value] of [[ENV.mode,'monthly_accelerated'],[ENV.environment,'production'],[ENV.environment,''],[ENV.provider,'stripe'],['NODE_ENV','production']]) test(`daily fails closed for ${key}=${value}`,()=>{
  assert.throws(()=>readConfig({...env(),[key]:value}),{code:'DAILY_SANDBOX_ONLY'});
});
for(const key of [ENV.entryProduct,ENV.entryPrice,ENV.highestProduct,ENV.highestPrice,ENV.entryAmount,ENV.highestAmount]) test(`daily requires ${key}`,()=>assert.throws(()=>readConfig({...env(),[key]:''})));
for(const [key,other] of [[ENV.highestProduct,ENV.entryProduct],[ENV.highestPrice,ENV.entryPrice]]) test(`duplicate ${key} fails`,()=>assert.throws(()=>readConfig({...env(),[key]:env()[other]}),{code:'DAILY_DUPLICATE_MAPPING'}));
for(const [label,mutate] of [
  ['wrong organization',p=>p.organization_id='other'],['missing organization',p=>delete p.organization_id],
  ['archived product',p=>p.is_archived=true],['archived price',p=>p.prices[0].is_archived=true],
  ['wrong product',p=>p.id='other'],['wrong price',p=>p.prices[0].id='other'],
  ['not fixed',p=>p.prices[0].amount_type='custom'],['wrong currency',p=>p.prices[0].price_currency='eur'],
  ['wrong amount',p=>p.prices[0].price_amount=1],['monthly product',p=>p.recurring_interval='month'],
  ['day/2',p=>p.recurring_interval_count=2],['conflicting price interval',p=>p.prices[0].recurring_interval='month'],
]) test(`daily mapping rejects ${label}`,()=>{
  const offer=createCatalog(readConfig(env())).offers[ENTRY], p=product(offer);mutate(p);
  assert.throws(()=>validateDailyProduct({product:p,offer,organizationId:'org'}));
});
test('daily validator rejects production and factory excludes clock mutation',()=>{
  const cfg=readConfig(env()), offer=createCatalog(cfg).offers[ENTRY];
  assert.throws(()=>validateDailyProduct({product:product(offer),offer:{...offer,providerEnvironment:'production'},organizationId:'org'}));
  assert.equal(createAdapter(cfg).rescheduleSubscriptionRenewal,undefined);
  assert.throws(()=>createAdapter({...cfg,environment:'production'}));
});
test('runner contains no acceleration or implicit database cleanup',async()=>{
  const source=await fs.readFile(path.join(__dirname,'../scripts/polar-sandbox-daily-e2e.cjs'),'utf8');
  assert.doesNotMatch(source,/rescheduleSubscriptionRenewal|RENEWAL_ACCELERATION|DROP DATABASE|current_billing_period_end\s*:/);
});
test('persistent state survives reopen and rejects commit/run/database mismatch',async()=>{
  const {state}=fixture();const dir=await fs.mkdtemp(path.join(os.tmpdir(),'daily-test-'));const file=path.join(dir,'state.json');
  try {
    await writeState(file,state,['private-value']);assert.deepEqual(await readState(file,state),state);
    for(const key of ['commitSha','runId','databaseName']) await assert.rejects(()=>readState(file,{...state,[key]:'other'}));
    const changed=JSON.parse(await fs.readFile(file,'utf8'));changed.state.customerId='changed';await fs.writeFile(file,JSON.stringify(changed));
    await assert.rejects(()=>readState(file,state),{code:'DAILY_STATE_DIGEST_MISMATCH'});
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('state and evidence reject nested secrets, credential URLs and unknown state fields',async()=>{
  for(const v of [{checkoutUrl:'hidden'},{nested:{accessToken:'hidden'}},{x:'polar_oat_fixture'},{x:'https://checkout.polar.sh/secret'},{x:'known-private-value'}]) assert.throws(()=>sanitize(v,['known-private-value']));
  const {state}=fixture();await assert.rejects(()=>writeState('unused',{...state,password:'do-not-write'}));
  await assert.rejects(()=>writeState('unused',{...state,unknown:'field'}));
});
test('database identity accepts JSONB key ordering but rejects another run or connection',async()=>{
  const {state}=fixture(), marker=JSON.parse(JSON.stringify(identity(state)));
  const pool={query:async sql=>({rows:sql.includes('current_database')?[{name:state.databaseName}]:[{identity:marker}]})};
  await verifyMarker(pool,state);marker.commitSha='b'.repeat(40);await assert.rejects(()=>verifyMarker(pool,state));
  assert.throws(()=>dbUrl('postgresql://user:password@remote.example/postgres',state.databaseName));
  assert.throws(()=>dbUrl('postgresql://user:password@localhost/real_app',state.databaseName));
});
test('only distinct successful natural cycle Order with real webhook grants proof',()=>assert.equal(proveRenewal(fixture()).result,'PASS'));
for(const [label,mutate] of [
  ['same Order',x=>x.order.id='A'],['no second Order',x=>x.order=null],['unpaid cycle',x=>x.order.paid=false],
  ['failed payment',x=>x.order.status='pending'],['free cycle',x=>x.order.amountMinor=0],['manual purchase',x=>x.order.billingReason='purchase'],
  ['proration',x=>x.order.billingReason='subscription_update'],['other subscription',x=>x.order.subscriptionId='other'],
  ['other customer',x=>x.order.customerId='other'],['old period',x=>x.order.periodStart=x.state.initialOrder.periodStart],
  ['Highest before payment',x=>x.state.preRenewal.effectivePlanId='highest_paid'],['Paid Entry after payment',x=>x.after.effectivePlanId='paid_entry'],
  ['stale paidThrough',x=>x.after.paidThrough=x.state.initialOrder.periodEnd],['wrong product',x=>x.order.productId='other'],
  ['wrong price',x=>x.order.priceId='other'],['cycled without order.paid',x=>x.webhookProofs[0].eventType='subscription.cycled'],
  ['no real webhook',x=>x.webhookProofs=[]],['unverified signature',x=>x.webhookProofs[0].signatureVerified=false],
  ['no financial payment',x=>x.order.payments=[]],['same payment',x=>x.order.payments[0].id='payment-A'],
  ['failed financial payment',x=>x.order.payments[0].status='failed'],['manual retry payment',x=>x.order.payments[0].trigger='retry_admin'],
]) test(`renewal proof rejects ${label}`,()=>{const f=fixture();mutate(f);assert.throws(()=>proveRenewal(f));});
test('order period must come from financial line items; no subscription fallback',()=>{
  const e=orderEvidence({id:'A',current_period_start:'2026-09-12',current_period_end:'2026-09-13'});assert.equal(e.periodEnd,null);
});
test('guard rejects production daily without external effects',()=>{
  const result=spawnSync(process.execPath,[path.join(__dirname,'../scripts/polar-sandbox-e2e-guard.cjs'),'start'],{env:{...env(),[ENV.environment]:'production'},encoding:'utf8'});
  assert.equal(result.status,2);assert.match(result.stderr,/DAILY_SANDBOX_ONLY/);
});
module.exports={env,fixture};
