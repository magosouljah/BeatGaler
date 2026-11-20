#!/usr/bin/env node
'use strict';
// Operator-only repair of missing Telegram bot membership for native libraries.
// Never creates bots, rotates tokens, deletes Telegram media or touches INDEX.
const fs=require('node:fs');
const {Pool}=require('pg');
const {createNativeTransportProvisioner}=require('../catalog/native-transport-provisioning');
async function main(){
 const apply=process.argv.length===3 && process.argv[2]==='--apply';
 const dry=process.argv.length===3 && process.argv[2]==='--dry-run';
 if(!apply&&!dry)throw Error('USAGE: --dry-run | --apply');
 if(!process.env.DATABASE_URL||!process.env.BEATGALER_MASTER_SESSION)throw Error('CREDENTIALS_OR_MASTER_MISSING');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:3,
   ssl:{rejectUnauthorized:true,ca:fs.readFileSync('/home/ec2-user/rds-global-bundle.pem','utf8')}});
 try{
   const a=(await pool.query('SELECT direct_token_exposure,transport_bot_ids FROM catalog_native_activation')).rows;
   if(a.length!==1||a[0].direct_token_exposure!=='REUSED_UNROTATED')throw Error('NATIVE_ACTIVATION_MISSING');
   const allowed=JSON.parse(a[0].transport_bot_ids);
   if(JSON.stringify(allowed)!==JSON.stringify(['Bot01','Bot02','Bot03']))throw Error('BOT_POOL_NOT_APPROVED');
   const accounts=(await pool.query(`SELECT l.user_id,v.telegram_chat_id,v.transport_bot_id,v.transport_membership_state,
       c.chat_id as current_chat_id FROM catalog_libraries l
       JOIN vaults v ON v.user_id=l.user_id
       JOIN catalog_library_chats c ON c.user_id=l.user_id AND c.state='CURRENT'
       WHERE l.authority='POSTGRES' ORDER BY l.created_at`)).rows;
   if(accounts.length!==2)throw Error('UNEXPECTED_NATIVE_LIBRARY_COUNT');
   if(accounts.some(x=>String(x.telegram_chat_id)!==String(x.current_chat_id)))throw Error('CHAT_INTEGRITY_MISMATCH');
   console.log('NATIVE_LIBRARIES='+accounts.length);
   console.log('MISSING_BOT_ASSIGNMENTS='+accounts.filter(x=>!x.transport_bot_id).length);
   if(dry){console.log('DRY_RUN_PASS_NO_WRITES');return;}
   const provisioner=createNativeTransportProvisioner({pool,log:(...parts)=>console.log(parts.map(x=>String(x).slice(0,75)).join(' '))});
   let ready=0;
   for(let i=0;i<accounts.length;i++){
      try{
        const result=await provisioner.ensureForUser({userId:accounts[i].user_id});
        console.log('LIBRARY_'+(i+1)+'_TRANSPORT_'+(result.ready?'READY':'PENDING')+' BOT='+result.botId);
        if(result.ready)ready++;
      }catch(error){
        console.log('LIBRARY_'+(i+1)+'_TRANSPORT_STOP '+String(error.code||'ERROR')+' '+String(error.detail?.reason||''));
        process.exitCode=3;
      }
   }
   const verified=(await pool.query(`SELECT count(*)::int AS ready FROM catalog_libraries l JOIN vaults v ON v.user_id=l.user_id
        WHERE l.authority='POSTGRES' AND v.transport_bot_id IS NOT NULL AND v.transport_membership_state='ready'`)).rows[0].ready;
   console.log('READY_MEMBERSHIPS='+verified+'/'+accounts.length);
   if(ready!==accounts.length||verified!==accounts.length)process.exitCode=3;
 }finally{await pool.end();}
}
main().catch(e=>{console.error('REPAIR_STOP',e.code||e.message);process.exitCode=3});
