'use strict';
// Local integration fixtures only. This test never calls Polar and is not E2E evidence.
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Client}=require('pg');
const {MODE,ENTRY,HIGHEST,createCatalog}=require('../scripts/polar-sandbox-daily-config.cjs');
const {databaseName,identity}=require('../scripts/polar-sandbox-daily-state.cjs');
const {initializeDatabase,verifyMarker,snapshot}=require('../scripts/polar-sandbox-daily-e2e.cjs');
const {createBillingLifecycle}=require('../billing-lifecycle');
const ADMIN=process.env.BILLING_E2E_TEST_ADMIN_URL;
test('daily equivalents persist pending change under unchanged monthly DB constraint and advance only on new paid order',{skip:!ADMIN},async()=>{
  const runId=new Date().toISOString().replace(/\D/g,'').slice(0,14)+'_'+crypto.randomBytes(4).toString('hex');
  const state={runId,databaseName:databaseName(runId),commitSha:'a'.repeat(40),organizationId:'fixture-org',products:[],userId:`daily_${runId}`,startedAt:new Date().toISOString()};
  const cfg={mode:MODE,provider:'polar',environment:'sandbox',providerMappings:{[ENTRY]:{productId:'entry',priceId:'entry-price'},[HIGHEST]:{productId:'high',priceId:'high-price'}},amounts:{[ENTRY]:20000,[HIGHEST]:10000}};
  const catalog=createCatalog(cfg);
  let pool;
  const now=Date.now(), start=new Date(now-60000).toISOString(), end=new Date(now+86400000).toISOString(), nextEnd=new Date(now+172800000).toISOString();
  const sub={id:'fixture-sub',customer_id:'fixture-customer',product_id:'entry',price_id:'entry-price',status:'active',current_period_start:start,current_period_end:end};
  const adapter={provider:'polar',environment:'sandbox',catalog,getSubscription:async()=>sub,getOrder:async()=>{throw new Error('unused fixture lookup');}};const lifecycle=createBillingLifecycle({adapter});
  function context(type,id){return {resolvedUserId:state.userId,provider:'polar',environment:'sandbox',event:{eventType:type,eventId:`fixture-${id}`,validatedPayload:{timestamp:new Date().toISOString()},subjectId:id}};}
  async function apply(type,object){const c=await pool.connect();try{await c.query('BEGIN');await lifecycle.handlers[type].apply(c,context(type,object.id||object.order.id),object);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  const first={id:'fixture-order-a',customer_id:sub.customer_id,subscription_id:sub.id,product_id:'entry',product_price_id:'entry-price',billing_reason:'subscription_create',paid:true,status:'paid',net_amount:20000,currency:'usd',items:[{product_price_id:'entry-price',start_timestamp:start,end_timestamp:end}]};
  try{
    pool=await initializeDatabase(ADMIN,state);await verifyMarker(pool,state);
    await pool.query('INSERT INTO users(id,email,created_at,updated_at) VALUES($1,$2,now(),now())',[state.userId,`${runId}@example.test`]);
    await apply('subscription.updated',sub);assert.equal((await snapshot(pool,lifecycle,state)).effectivePlanId,'free');
    await apply('order.paid',{order:first,subscription:sub});assert.equal((await snapshot(pool,lifecycle,state)).effectivePlanId,'paid_entry');
    const pending={...sub,pending_update:{product_id:'high',applies_at:end}};await apply('subscription.updated',pending);
    let s=await snapshot(pool,lifecycle,state);assert.equal(s.nextPlanId,'highest_paid');assert.equal(s.effectivePlanId,'paid_entry');
    assert.equal((await pool.query('SELECT next_interval FROM billing_subscription_state WHERE user_id=$1',[state.userId])).rows[0].next_interval,'month');
    const cycled={...sub,product_id:'high',price_id:'high-price',current_period_start:end,current_period_end:nextEnd};await apply('subscription.updated',cycled);
    assert.equal((await snapshot(pool,lifecycle,state)).effectivePlanId,'paid_entry');
    const second={...first,id:'fixture-order-b',product_id:'high',product_price_id:'high-price',billing_reason:'subscription_cycle',net_amount:10000,items:[{product_price_id:'high-price',start_timestamp:end,end_timestamp:nextEnd}]};
    await apply('order.paid',{order:second,subscription:cycled});s=await snapshot(pool,lifecycle,state);assert.equal(s.effectivePlanId,'highest_paid');assert.equal(s.paidThrough,nextEnd);assert.equal(s.payments.length,2);
    await apply('order.paid',{order:second,subscription:cycled});assert.equal((await snapshot(pool,lifecycle,state)).payments.length,2);
    await pool.end();pool=null;
    pool=await initializeDatabase(ADMIN,state);await verifyMarker(pool,state);assert.equal((await snapshot(pool,lifecycle,state)).payments.length,2);
    await assert.rejects(()=>verifyMarker(pool,{...state,commitSha:'b'.repeat(40)}));
  }finally{
    if(pool)await pool.end();
    // Only the database created by this local fixture, with its exact generated name.
    assert.equal(state.databaseName,databaseName(runId));const admin=new Client({connectionString:ADMIN});await admin.connect();try{await admin.query(`DROP DATABASE IF EXISTS "${state.databaseName}" WITH (FORCE)`);}finally{await admin.end();}
  }
});
