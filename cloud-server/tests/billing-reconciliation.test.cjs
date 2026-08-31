'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBillingReconciliationService, BillingReconciliationError } = require('../billing-reconciliation');

function fakePool(local) {
  const exceptions = new Map();
  const client = {
    async query(sql,args=[]) {
      if (sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'||sql.includes('pg_advisory_xact_lock')) return {rows:[]};
      if (sql.includes('FROM billing_subscription_state')) return {rows: local ? [local] : []};
      if (sql.startsWith('INSERT INTO billing_reconciliation_exceptions')) {
        const prev=exceptions.get(args[0]);
        exceptions.set(args[0],{attempt_count:(prev?.attempt_count||0)+1,provider:JSON.parse(args[4]),local:JSON.parse(args[5]),state:'OPEN'});
        return {rows:[]};
      }
      if (sql.startsWith("UPDATE billing_reconciliation_exceptions SET state='RESOLVED'")) { if(exceptions.has(args[0])) exceptions.get(args[0]).state='RESOLVED'; return {rows:[]}; }
      throw new Error(`unexpected sql ${sql}`);
    }, release() {}
  };
  return { connect:async()=>client, query:async()=>({rows:[]}), exceptions };
}

const providerState={customerId:'cus_1',subscriptionId:'sub_1',planId:'paid_entry',status:'active'};

test('matching authoritative provider/local state reconciles without granting entitlement', async()=>{
  const pool=fakePool({provider_customer_id:'cus_1',provider_subscription_id:'sub_1',plan_id:'paid_entry',status:'active'});
  const service=createBillingReconciliationService({pool,provider:{fetchSubscription:async()=>providerState}});
  const result=await service.reconcile({userId:'u1',reconciliationId:'rec_1'});
  assert.deepEqual(result,{reconciled:true,divergent:false,entitlementGranted:false});
});

test('divergence creates durable exception and never grants entitlement', async()=>{
  const pool=fakePool({provider_customer_id:'cus_1',provider_subscription_id:'sub_1',plan_id:'free',status:'inactive'});
  const service=createBillingReconciliationService({pool,provider:{fetchSubscription:async()=>providerState}});
  const result=await service.reconcile({userId:'u1',reconciliationId:'rec_2'});
  assert.equal(result.divergent,true); assert.equal(result.entitlementGranted,false);
  assert.equal(pool.exceptions.get('rec_2').state,'OPEN');
});

test('replay is idempotent by exception identity and increments retry attempt', async()=>{
  const pool=fakePool(null);
  const service=createBillingReconciliationService({pool,provider:{fetchSubscription:async()=>providerState}});
  await service.reconcile({userId:'u1',reconciliationId:'rec_3'});
  await service.reconcile({userId:'u1',reconciliationId:'rec_3'});
  assert.equal(pool.exceptions.size,1); assert.equal(pool.exceptions.get('rec_3').attempt_count,2);
});

test('ambiguous provider state fails closed before local mutation', async()=>{
  const pool=fakePool(null);
  const service=createBillingReconciliationService({pool,provider:{fetchSubscription:async()=>({customerId:'cus_1',subscriptionId:'sub_1',planId:'highest_paid',status:'mystery'})}});
  await assert.rejects(()=>service.reconcile({userId:'u1',reconciliationId:'rec_4'}), e=>e instanceof BillingReconciliationError && e.code==='BILLING_PROVIDER_SNAPSHOT_INVALID');
  assert.equal(pool.exceptions.size,0);
});

test('provider lookup failure fails closed and does not grant or queue fabricated state', async()=>{
  const pool=fakePool(null);
  const service=createBillingReconciliationService({pool,provider:{fetchSubscription:async()=>{throw new Error('timeout')}}});
  await assert.rejects(()=>service.reconcile({userId:'u1',reconciliationId:'rec_5'}), e=>e.code==='BILLING_PROVIDER_UNAVAILABLE');
  assert.equal(pool.exceptions.size,0);
});
