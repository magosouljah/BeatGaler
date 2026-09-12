'use strict';
// Local integration fixtures only. This test never calls Polar and is not E2E evidence.
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {Client}=require('pg');
const {MODE,ENTRY,HIGHEST,createCatalog}=require('../scripts/polar-sandbox-daily-config.cjs');
const {databaseName,writeState,readState}=require('../scripts/polar-sandbox-daily-state.cjs');
const {adoptRepair}=require('../scripts/polar-sandbox-daily-repair-code.cjs');
const {initializeDatabase,verifyMarker,snapshot}=require('../scripts/polar-sandbox-daily-e2e.cjs');
const {createBillingLifecycle}=require('../billing-lifecycle');
const {createBillingReconciliationService}=require('../billing-reconciliation');
const ADMIN=process.env.BILLING_E2E_TEST_ADMIN_URL;
test('daily equivalents persist pending change under unchanged monthly DB constraint and advance only on new paid order',{skip:!ADMIN},async()=>{
  const runId=new Date().toISOString().replace(/\D/g,'').slice(0,14)+'_'+crypto.randomBytes(4).toString('hex');
  const state={schemaVersion:1,mode:MODE,provider:'polar',environment:'sandbox',runId,databaseName:databaseName(runId),commitSha:'a'.repeat(40),organizationId:'fixture-org',products:[],userId:`daily_${runId}`,startedAt:new Date().toISOString()};
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
    await apply('order.updated',{order:first,subscription:pending});
    s=await snapshot(pool,lifecycle,state);assert.equal(s.nextPlanId,'highest_paid','late initial invoice update must preserve the provider pending upgrade');assert.equal(s.effectivePlanId,'paid_entry');assert.equal(s.payments.length,1);
    await apply('order.paid',{order:first,subscription:pending});
    assert.equal((await snapshot(pool,lifecycle,state)).nextPlanId,'highest_paid','paid Order replay must preserve the pending upgrade');
    await apply('order.updated',{order:first,subscription:sub});
    assert.equal((await snapshot(pool,lifecycle,state)).nextPlanId,null,'an authoritative canceled pending update is cleared');
    const reconciler=createBillingReconciliationService({pool,lifecycle,logger:{emit(){}},adapter:{...adapter,
      listSubscriptionsForUser:async()=>({items:[pending],truncated:false}),listOrdersForUser:async()=>({items:[first],truncated:false})}});
    assert.equal((await reconciler.reconcileUser({userId:state.userId,reconciliationId:'fixture-daily-repair'})).reconciled,true);
    assert.equal((await snapshot(pool,lifecycle,state)).nextPlanId,'highest_paid','real-provider reconciliation path retains pending metadata after projecting Orders');
    assert.equal((await reconciler.reconcileUser({userId:state.userId,reconciliationId:'fixture-daily-repair-repeat'})).repaired,false);
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'daily-repair-test-'));
    try{
      const file=path.join(dir,'state.json');state.initialOrder={id:first.id,paid:true};state.checkpoint='INITIAL_PAID';await writeState(file,state);
      const original={...state};const repaired=await adoptRepair({pool,file,state,toHead:'c'.repeat(40)});
      assert.equal(repaired.codeTransitions[0].fromCommitSha,original.commitSha);
      assert.deepEqual(await readState(`${file}.before-${'c'.repeat(40)}.json`,original),original);
      await assert.rejects(()=>readState(file,original));await verifyMarker(pool,repaired);
      await fs.copyFile(file,`${file}.repair-${'c'.repeat(40)}.json`);
      await fs.copyFile(`${file}.before-${'c'.repeat(40)}.json`,file);
      assert.deepEqual(await adoptRepair({pool,file,state:original,toHead:'c'.repeat(40)}),repaired,'interruption after DB commit completes the staged file handoff');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM task11_daily_code_repairs')).rows[0].count,1);
      Object.assign(state,repaired);assert.deepEqual(await readState(file,state),state);
    }finally{await fs.rm(dir,{recursive:true,force:true});}
    const cycled={...sub,product_id:'high',price_id:'high-price',current_period_start:end,current_period_end:nextEnd};await apply('subscription.updated',cycled);
    assert.equal((await snapshot(pool,lifecycle,state)).effectivePlanId,'paid_entry');
    const second={...first,id:'fixture-order-b',product_id:'high',product_price_id:'high-price',billing_reason:'subscription_cycle',net_amount:10000,items:[{product_price_id:'high-price',start_timestamp:end,end_timestamp:nextEnd}]};
    await apply('order.paid',{order:second,subscription:cycled});s=await snapshot(pool,lifecycle,state);assert.equal(s.effectivePlanId,'highest_paid');assert.equal(s.paidThrough,nextEnd);assert.equal(s.payments.length,2);
    assert.equal(s.nextPlanId,null,'new-period payment consumes the applied upgrade');
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
