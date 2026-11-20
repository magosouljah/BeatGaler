'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createNativeTransportProvisioner}=require('../../catalog/native-transport-provisioning');

function harness({ membershipState='pending', allowed=['Bot01','Bot02','Bot03'], readyBots=true }={}){
 let bot=null, state=membershipState, invites=0, updates=0, locks=0, assigned=0;
 const store={
  async withMembershipLock(_vault, callback){locks++;return callback();},
  async getAssignment(){return {transportBotId:bot,membershipState:state};},
  async assignIfMissing(){assigned++;bot='Bot01';return {transportBotId:bot,membershipState:state};},
  async markMembershipReady(_vault, expected){assert.equal(expected,'Bot01');state='ready';updates++;},
 };
 const pool={
  async query(sql){
   if(sql.includes('FROM catalog_libraries'))return {rows:[{chat_id:'-1001234',telegram_chat_id:'-1001234'}]};
   if(sql.includes('FROM catalog_native_activation'))return {rows:[{transport_bot_ids:JSON.stringify(allowed)}]};
   if(sql.includes('FROM transport_bots'))return {rows:[{quarantined:!readyBots,rotation_pending:false}]};
   throw Error('Unexpected SQL '+sql);
  },
 };
 const transport={async ensureCatalogBotMembership({chatId,botId}){
  assert.equal(chatId,'-1001234');assert.equal(botId,'Bot01');invites++;return {ready:true,botId:'Bot01'};
 }};
 return {service:createNativeTransportProvisioner({pool,assignmentStore:store,transport}),metrics:()=>({invites,updates,locks,assigned})};
}
test('first native transfer persistently assigns and verifies Telegram bot membership once',async()=>{
 const {service,metrics}=harness();
 const one=await service.ensureForUser({userId:'u1'});
 assert.equal(one.ready,true);
 const two=await service.ensureForUser({userId:'u1'});
 assert.deepEqual(two,one);
 assert.deepEqual(metrics(),{invites:1,updates:1,locks:2,assigned:1});
});
test('unapproved or unavailable Telegram bot never establishes membership',async()=>{
 const x=harness({allowed:['Bot02']});
 await assert.rejects(x.service.ensureForUser({userId:'u1'}),e=>e.code==='CATALOG_UNAVAILABLE'&&e.detail.reason==='BOT_NOT_IN_NATIVE_ACTIVATION');
 assert.equal(x.metrics().invites,0);
 const y=harness({readyBots:false});
 await assert.rejects(y.service.ensureForUser({userId:'u1'}),e=>e.detail.reason==='BOT_NOT_READY');
 assert.equal(y.metrics().invites,0);
});
test('Telegram failure remains pending, never marks membership ready',async()=>{
 const {createNativeTransportProvisioner}=require('../../catalog/native-transport-provisioning');
 let ready=0;
 const service=createNativeTransportProvisioner({
  pool:{async query(sql){
   if(sql.includes('FROM catalog_libraries'))return {rows:[{chat_id:'-1001234',telegram_chat_id:'-1001234'}]};
   if(sql.includes('FROM catalog_native_activation'))return {rows:[{transport_bot_ids:'["Bot01"]'}]};
   return {rows:[{quarantined:false,rotation_pending:false}]};
  }},
  assignmentStore:{
   async withMembershipLock(_v,fn){return fn()},
   async getAssignment(){return {transportBotId:'Bot01',membershipState:'pending'}},
   async markMembershipReady(){ready++},
  },
  transport:{async ensureCatalogBotMembership(){throw Error('network unreachable')}},
 });
 await assert.rejects(service.ensureForUser({userId:'u1'}),e=>e.detail.reason==='BOT_MEMBERSHIP_PENDING');
 assert.equal(ready,0);
});
