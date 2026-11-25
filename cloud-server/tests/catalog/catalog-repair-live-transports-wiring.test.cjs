'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {buildProvisioner}=require('../../scripts/catalog-repair-live-transports.cjs');

test('repair script wires assignment store and Telegram transport into the provisioner (apply path)',async()=>{
 let locks=0,invites=0,bot=null,state='pending';
 const store={
  async withMembershipLock(_v,cb){locks++;return cb();},
  async getAssignment(){return {transportBotId:bot,membershipState:state};},
  async assignIfMissing(){bot='Bot01';return {transportBotId:bot,membershipState:state};},
  async markMembershipReady(){state='ready';},
 };
 const transport={async ensureCatalogBotMembership({chatId,botId}){invites++;assert.equal(chatId,'-1001234');return {ready:true,botId};}};
 const pool={async query(sql){
  if(sql.includes('FROM catalog_libraries'))return {rows:[{chat_id:'-1001234',telegram_chat_id:'-1001234'}]};
  if(sql.includes('FROM catalog_native_activation'))return {rows:[{transport_bot_ids:JSON.stringify(['Bot01','Bot02','Bot03'])}]};
  if(sql.includes('FROM transport_bots'))return {rows:[{quarantined:false,rotation_pending:false}]};
  throw Error('Unexpected SQL '+sql);
 }};
 let storePool=null;
 const p=buildProvisioner(pool,()=>{},{createStore:(x)=>{storePool=x;return store;},getTransport:()=>transport});
 const r=await p.ensureForUser({userId:'u1'});
 assert.equal(r.ready,true);
 assert.equal(storePool,pool);
 assert.deepEqual({locks,invites},{locks:1,invites:1});
});
