'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { effectiveBillingPlan, createEntitlementService, EntitlementDeniedError } = require('../billing-entitlements');

test('only active/trialing server subscription grants paid plan', () => {
  assert.equal(effectiveBillingPlan({ plan_id: 'paid_entry', status: 'active' }).id, 'paid_entry');
  assert.equal(effectiveBillingPlan({ plan_id: 'highest_paid', status: 'trialing' }).id, 'highest_paid');
  for (const status of ['inactive','past_due','canceled','unpaid','incomplete','incomplete_expired','paused','bogus']) assert.equal(effectiveBillingPlan({ plan_id: 'highest_paid', status }).id, 'free');
});

function fakePool({ planId='free', status='inactive', used=0 }={}) {
  const inserts=[]; let locked=false;
  const client={
    async query(sql,args=[]) {
      if (sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK') return {rows:[]};
      if (sql.includes('pg_advisory_xact_lock')) { locked=true; return {rows:[{}]}; }
      if (sql.includes('FROM billing_subscription_state') && sql.includes('FOR UPDATE')) return {rows:[{plan_id:planId,status}]};
      if (sql.includes('WHERE reservation_id')) return {rows:[]};
      if (sql.includes('COALESCE(SUM(amount)')) { assert.equal(locked,true); return {rows:[{used}]}; }
      if (sql.startsWith('INSERT INTO entitlement_reservations')) { inserts.push(args); return {rows:[]}; }
      throw new Error(`unexpected sql ${sql}`);
    }, release() {}
  };
  return { connect: async()=>client, query: async()=>({rows:[]}), inserts };
}

test('server quota is checked inside locked transaction before reservation', async () => {
  const pool=fakePool({planId:'free',status:'inactive',used:20});
  const service=createEntitlementService({pool});
  await assert.rejects(()=>service.reserve({userId:'u1',resource:'max_beats',reservationId:'r1'}), e=>e instanceof EntitlementDeniedError && e.code==='ENTITLEMENT_LIMIT_EXCEEDED');
  assert.equal(pool.inserts.length,0);
});

test('paid active plan reserves atomically after lock and quota check', async () => {
  const pool=fakePool({planId:'paid_entry',status:'active',used:99});
  const result=await createEntitlementService({pool}).reserve({userId:'u1',resource:'max_beats',reservationId:'r1'});
  assert.equal(result.state,'RESERVED'); assert.equal(result.planId,'paid_entry'); assert.equal(pool.inserts.length,1);
});

test('past_due fails closed to free limits', async () => {
  const pool=fakePool({planId:'highest_paid',status:'past_due',used:20});
  await assert.rejects(()=>createEntitlementService({pool}).reserve({userId:'u1',resource:'max_beats',reservationId:'r2'}), /quota exceeded/i);
});

test('portal response never grants entitlement from redirect/session', async () => {
  const pool={connect:async()=>{throw new Error('unused')},query:async()=>({rows:[{provider_customer_id:'cus_1',status:'active',cancel_at_period_end:true,current_period_end:'2030-01-01'}]})};
  const portalProvider={createPortalSession:async()=>({url:'https://provider.invalid/portal'})};
  const result=await createEntitlementService({pool,portalProvider}).createPortalSession({userId:'u1',returnUrl:'https://app.invalid'});
  assert.equal(result.entitlementGranted,false); assert.equal(result.subscription.status,'active'); assert.equal(result.subscription.cancelAtPeriodEnd,true);
});
