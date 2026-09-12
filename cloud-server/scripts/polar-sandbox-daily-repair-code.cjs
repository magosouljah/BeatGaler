#!/usr/bin/env node
'use strict';
// Explicit, audited code repair for a paid run. Normal resume never changes its SHA.
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const {execFileSync}=require('node:child_process');
const path=require('node:path');
const {Pool}=require('pg');
const {check,text,readConfig}=require('./polar-sandbox-daily-config.cjs');
const {identity,readState,writeState}=require('./polar-sandbox-daily-state.cjs');
const {dbUrl,verifyMarker}=require('./polar-sandbox-daily-e2e.cjs');
const REASON='LATE_INITIAL_ORDER_UPDATE_CLEARED_PENDING_CHANGE';
async function adoptRepair({pool,file,state,toHead,secrets=[]}) {
  check(/^[a-f0-9]{40}$/.test(toHead)&&toHead!==state.commitSha,'DAILY_REPAIR_HEAD_INVALID');
  check(state.checkpoint==='INITIAL_PAID'&&state.initialOrder?.paid===true&&!state.preRenewal,'DAILY_REPAIR_CHECKPOINT_INVALID');
  const stage=`${file}.repair-${toHead}.json`, backup=`${file}.before-${toHead}.json`;
  const client=await pool.connect();let locked=false;
  try {
    locked=(await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',[`daily-runtime:${state.runId}`])).rows[0].acquired;
    check(locked,'DAILY_RUN_ALREADY_ACTIVE');
    const marker=(await client.query('SELECT identity FROM task11_daily_run WHERE singleton=true')).rows[0]?.identity;
    // Finish the atomic file handoff if a process died after the DB commit.
    if(marker?.commitSha===toHead){
      const next=await readState(stage,{...state,commitSha:toHead});await verifyMarker(client,next);
      await fs.rename(stage,file);return next;
    }
    await verifyMarker(client,state);
    const payments=(await client.query('SELECT provider_order_id,status FROM billing_payments WHERE user_id=$1',[state.userId])).rows;
    check(payments.length===1 && payments[0].provider_order_id===state.initialOrder.id && payments[0].status==='succeeded','DAILY_REPAIR_INITIAL_PAYMENT_REQUIRED');
    try {await fs.copyFile(file,backup,constants.COPYFILE_EXCL);} catch(e){if(e.code!=='EEXIST')throw e;const old=await readState(backup,state);check(JSON.stringify(old)===JSON.stringify(state),'DAILY_REPAIR_BACKUP_MISMATCH');}
    const at=new Date().toISOString();
    const transition={fromCommitSha:state.commitSha,toCommitSha:toHead,at,reason:REASON};
    const next={...state,commitSha:toHead,codeTransitions:[...(state.codeTransitions||[]),transition]};
    await writeState(stage,next,secrets);
    await client.query('BEGIN');
    try {
      await client.query('CREATE TABLE IF NOT EXISTS task11_daily_code_repairs(from_sha text NOT NULL,to_sha text PRIMARY KEY,reason text NOT NULL,applied_at timestamptz NOT NULL)');
      await client.query('INSERT INTO task11_daily_code_repairs VALUES($1,$2,$3,$4)',[state.commitSha,toHead,REASON,at]);
      await client.query('UPDATE task11_daily_run SET identity=$1::jsonb WHERE singleton=true',[JSON.stringify(identity(next))]);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}
    await fs.rename(stage,file);return next;
  }finally{if(locked)await client.query('SELECT pg_advisory_unlock(hashtext($1))',[`daily-runtime:${state.runId}`]);client.release();}
}
async function main(){
  const env=process.env;const config=readConfig(env);
  const from=text(env,'BILLING_E2E_REPAIR_FROM_HEAD'),to=text(env,'BILLING_E2E_EXPECTED_HEAD');
  const root=path.resolve(__dirname,'../..');
  const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  check(git(['rev-parse','HEAD'])===to&&git(['branch','--show-current'])==='billing/v1-policy','DAILY_HEAD_OR_BRANCH_MISMATCH');
  check(!git(['diff','--ignore-cr-at-eol','--stat','HEAD','--','cloud-server','.github/workflows']),'DAILY_COMMITTED_CODE_REQUIRED');
  git(['merge-base','--is-ancestor',from,to]);
  const file=process.argv[2];check(file,'DAILY_STATE_FILE_REQUIRED');
  const state=await readState(file,{runId:text(env,'BILLING_E2E_RUN_ID'),databaseName:text(env,'BILLING_E2E_DATABASE_NAME'),commitSha:from});
  check(state.organizationId===config.organizationId,'DAILY_ORGANIZATION_MISMATCH');
  const admin=text(env,'BILLING_E2E_TEST_ADMIN_URL');const pool=new Pool({connectionString:dbUrl(admin,state.databaseName)});
  try{const next=await adoptRepair({pool,file,state,toHead:to,secrets:[config.accessToken,config.webhookSecret,admin]});console.log(JSON.stringify({runId:next.runId,databaseName:next.databaseName,codeTransition:next.codeTransitions.at(-1)}));}finally{await pool.end();}
}
if(require.main===module)main().catch(e=>{console.error(/^[A-Z0-9_:-]{1,160}$/.test(e.code||'')?e.code:'DAILY_CODE_REPAIR_FAILED');process.exitCode=1;});
module.exports={adoptRepair};
