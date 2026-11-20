#!/usr/bin/env node
'use strict';
// One-command owner-approved native launch. EXACTLY 5 disposable SQL users,
// never touch Telegram media or rotate a bot token. Dry-run before apply.
// This explicitly accepts residual G2 risk; it does not mark G2 PASS.
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {Pool}=require('pg');
const {createNativeCli,inventory,compareJsonCompat}=require('../catalog/native-cli.js');
const {canonicalJson}=require('../catalog/authority.js');
const REPO='/home/ec2-user/BeatGaler-native-candidate';
const REL='/home/ec2-user/BeatGaler-releases';
const START='/usr/local/bin/beatgaler-cloud-start';
const WEB='/var/www/beatgaler-web/current';
const NATIVE_WEB='/var/www/beatgaler-web/releases/native-1ceb9c39';
const BOTS=['Bot01','Bot02','Bot03'];
const BACKUP_ID='bk-20261120T053050-29892';
const BUCKET='beatgaler-catalog-backups-403659231201-us-east-2';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function assert(ok,code){if(!ok)throw Error(code)}
function shell(cmd,args,timeout=60000){return execFileSync(cmd,args,{encoding:'utf8',timeout,maxBuffer:4194304,stdio:['ignore','pipe','pipe']}).trim()}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function cred(){
 const s=fs.readFileSync('/etc/beatgaler/catalog-runtime-db.env','utf8');
 const m=/^export DATABASE_URL='([^'\n]+)'$/m.exec(s);
 assert(m,'STOP_CRED_MISSING');
 const u=new URL(m[1]);
 assert(u.username==='beatgaler_catalog_rt'&&u.hostname==='galer-cloud-prod.cvwoqa80k8h6.us-east-2.rds.amazonaws.com'&&u.pathname==='/postgres','STOP_DB_IDENTITY');
 return m[1];
}
function safety(){
 assert(process.getuid()===0,'STOP_ROOT_REQUIRED');
 assert(process.argv.length===3&&['--apply','--dry-run'].includes(process.argv[2]),'USAGE_RUN_WITH_APPLY_OR_DRY_RUN');
 assert(shell('systemctl',['is-active','beatgaler-cloud.service'])==='active','STOP_CLOUD_INACTIVE');
 assert(shell('curl',['-s','--max-time','6','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:4000/readyz'])==='200','STOP_CLOUD_NOT_READY');
 assert(fs.existsSync(NATIVE_WEB+'/index.html'),'STOP_WEB_NOT_STAGED');
 assert(fs.lstatSync(WEB).isSymbolicLink(),'STOP_WEB_NOT_SYMLINK');
 shell('nginx',['-t']);
 const raw=shell('aws',['s3','cp','s3://'+BUCKET+'/'+BACKUP_ID+'.manifest.json','-']);
 const m=JSON.parse(raw),c=m.counts||{};
 assert(c.schema_migrations===42&&c.users===5&&c.vaults===5&&c.legacy_beats===28&&m.catalog_counts?.catalog_libraries===0,'STOP_BACKUP_NOT_MATCHED');
 for(const suffix of ['.dump','.manifest.json.sha256'])shell('aws',['s3api','head-object','--bucket',BUCKET,'--key',BACKUP_ID+suffix]);
 console.log('BACKUP_AND_CLOUD_PREFLIGHT_PASS');
}
function stage(){
 const sha=shell('git',['-c','safe.directory='+REPO,'-C',REPO,'rev-parse','--short=8','HEAD']);
 assert(/^[a-f0-9]{8}$/.test(sha),'STOP_SHA');
 const dir=REL+'/native-'+sha;
 if(!fs.existsSync(dir)){
   fs.mkdirSync(dir,{recursive:true});
   shell('bash',['-lc','git -c safe.directory='+REPO+' -C '+REPO+' archive HEAD | tar -x -C '+dir],90000);
   fs.cpSync(REL+'/native-541212df/cloud-server/node_modules',dir+'/cloud-server/node_modules',{recursive:true});
   for(const name of ['accounts-data.json','cloud-data.json','session-security-state.json','account-lifecycle-state.json','authz-session-bindings.json']){
     const src=REL+'/native-541212df/cloud-server/'+name;
     if(fs.existsSync(src))fs.copyFileSync(src,dir+'/cloud-server/'+name);
   }
   shell('chown',['-R','ec2-user:ec2-user',dir],150000);
 }
 assert(fs.existsSync(dir+'/cloud-server/migrations/0042_catalog_reused_bots.sql') &&
   fs.existsSync(dir+'/cloud-server/node_modules/pg'),'STOP_RELEASE_SCHEMA_OR_MODULES');
 return dir;
}
async function status(pool,auth){
 const c=await pool.connect();
 try{
  await c.query('BEGIN READ ONLY');
  const counts=(await c.query('SELECT (SELECT count(*)::int FROM users) AS users,(SELECT count(*)::int FROM vaults) AS vaults,(SELECT count(*)::int FROM library_beats) AS legacy_beats,(SELECT count(*)::int FROM schema_migrations) AS schema_migrations,(SELECT count(*)::int FROM catalog_native_activation) AS activations,(SELECT count(*)::int FROM catalog_libraries) AS libraries,(SELECT count(*)::int FROM control_plane_flush_quarantine WHERE resolved_at IS NULL) AS quarantined')).rows[0];
  assert(counts.users===5&&counts.vaults===5&&counts.legacy_beats===28&&counts.schema_migrations===42&&counts.activations===0&&counts.libraries===0&&counts.quarantined===0,'STOP_TEST_SQL_COUNTS');
  const b=(await c.query('SELECT id,quarantined,rotation_pending FROM transport_bots WHERE id=ANY($1::text[])',[BOTS])).rows;
  assert(b.length===3&&b.every(x=>!x.quarantined&&!x.rotation_pending),'STOP_BOT_POOL');
  const comp=await compareJsonCompat(c,auth);
  assert(comp.match,'STOP_AUTH_JSON_SQL_MISMATCH');
  const cut=(await c.query("SELECT state FROM control_plane_cutovers WHERE id='legacy-json-v1'")).rows[0];
  assert(cut?.state==='READY','STOP_CONTROL_PLANE');
  const v=await inventory(c,{authJson:auth});
  assert(v.vaults.length===5&&!v.vaults.some(x=>x.quarantined),'STOP_VAULTS');
  const ids=(await c.query('SELECT id FROM users ORDER BY id')).rows.map(x=>String(x.id));
  await c.query('COMMIT');
  return {digest:hash(canonicalJson(ids)),inventory_sha256:v.inventory_sha256};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}
}
function manifest(s){
 return {
  environment_id:'beatgaler-prod',run_id:'native-reused-20261119',
  transport_bot_ids:BOTS,direct_token_exposure:'REUSED_UNROTATED',
  reuse_risk_accepted:true,owner_decision_ref:'owner-20261119-use-existing-bots-no-rotation',
  instance_inventory:[{id:'old-cloud-instance-stopped',stopped:true}],
  inspect:{inventory_sha256:s.inventory_sha256,approval_ref:'owner-20261119-go-live'},
  credential_fence:{old_db_role:'galer_admin'},
  test_account_reset:{owner_approved:true,approval_ref:'owner-20261119-all-five-disposable',
   expected_users:5,expected_vaults:5,expected_legacy_beats:28,user_ids_sha256:s.digest}
 };
}
function changeStart(dir){
 const before=fs.readFileSync(START,'utf8');
 const m=/^cd \/home\/ec2-user\/BeatGaler-releases\/native-[^\n]+$/m.exec(before);
 assert(m&&before.includes('exec node cloud-server/server.js'),'STOP_START_SCRIPT');
 const backup=START+'.pre-final-20261119';
 assert(!fs.existsSync(backup),'STOP_BACKUP_START_ALREADY_EXISTS');
 fs.copyFileSync(START,backup);
 const exports=[
  'export BEATGALER_CATALOG_NATIVE_ENABLED=true',
  'export BEATGALER_CATALOG_GATEWAY_ENABLED=true',
  'export BEATGALER_CATALOG_DIRECT_ENABLED=true',
  'export BEATGALER_CATALOG_OWNER_G2_RISK_ACCEPTED=true',
  'export BEATGALER_CATALOG_DIRECT_PREWARM_BOTS=0',
  'exec node cloud-server/server.js'].join('\n');
 fs.writeFileSync(START,before.replace(m[0],'cd '+dir).replace('exec node cloud-server/server.js',exports));
 return backup;
}
async function awaitCloud(){
 for(let n=0;n<30;n++){
  try{
   if(shell('curl',['-s','--max-time','3','-o','/dev/null','-w','%{http_code}','http://127.0.0.1:4000/readyz'],5500)==='200')return;
  }catch(_){}
  await sleep(3500);
 }
 throw Error('STOP_CLOUD_BOOT_FAILED');
}
function switchWeb(previous){
 const pending='/var/www/beatgaler-web/.native-pending';
 assert(!fs.existsSync(pending),'STOP_WEB_TEMP_EXISTS');
 fs.symlinkSync(NATIVE_WEB,pending);fs.renameSync(pending,WEB);
 try{
  assert(fs.readlinkSync(WEB)===NATIVE_WEB&&fs.existsSync(WEB+'/index.html'),'STOP_WEB_SYMLINK_INVALID');
 }catch(e){
  const revert='/var/www/beatgaler-web/.native-revert';
  fs.symlinkSync(previous,revert);fs.renameSync(revert,WEB);throw e;
 }
}
async function main(){
 safety();
 const previousWeb=fs.readlinkSync(WEB);
 const dir=stage();
 const auth=JSON.parse(fs.readFileSync(dir+'/cloud-server/accounts-data.json','utf8'));
 const pool=new Pool({connectionString:cred(),max:2,ssl:{rejectUnauthorized:true,ca:fs.readFileSync('/home/ec2-user/rds-global-bundle.pem','utf8')}});
 let stopped=false, activated=false, previousStart=null;
 try{
  const baseline=await status(pool,auth);
  console.log('FIVE_TEST_ACCOUNTS_BOT_POOL_SQL_PASS');
  if(process.argv[2]==='--dry-run'){console.log('CUTOVER_DRY_RUN_READY_NO_SQL_WRITES');return}
  stopped=true; // even if systemctl stop times out, the recovery path must run
  shell('systemctl',['stop','beatgaler-cloud.service'],190000);
  assert(shell('systemctl',['show','-p','ActiveState','--value','beatgaler-cloud.service'])==='inactive','STOP_OLD_CLOUD_STILL_RUNNING');
  const now=await status(pool,auth);
  assert(now.digest===baseline.digest&&now.inventory_sha256===baseline.inventory_sha256,'STOP_STATE_CHANGED_AFTER_DRAIN');
  const tmp=fs.mkdtempSync('/run/beatgaler-cutover-');
  const mp=path.join(tmp,'activation.json'),ap=path.join(tmp,'accounts.json');
  fs.writeFileSync(mp,JSON.stringify(manifest(now)),{mode:0o600});
  fs.writeFileSync(ap,JSON.stringify(auth),{mode:0o600});
  const cli=createNativeCli({pool}),a=['activate','--manifest',mp,'--auth-json',ap];
  const plan=await cli.run(a);
  assert(plan.result.outcome==='WOULD_ACTIVATE'&&plan.result.plan.test_account_reset.users===5,'STOP_DRY_RUN');
  console.log('ATOMIC_RESET_ACTIVATION_DRY_RUN_PASS');
  const done=await cli.run([...a,'--apply']);
  assert(done.result.outcome==='ACTIVATED','STOP_ACTIVATION');
  activated=true;
  fs.rmSync(tmp,{recursive:true,force:true});
  console.log('NATIVE_ACTIVATION_AND_FIVE_SQL_TEST_RESET_COMMITTED');
  previousStart=changeStart(dir);
  shell('systemctl',['start','beatgaler-cloud.service'],130000);
  await awaitCloud();
  const log=shell('journalctl',['-u','beatgaler-cloud.service','-n','160','--no-pager','-o','cat'],25000);
  assert(log.includes('native=enabled')&&log.includes('gateway=bot-router(lazy)'),'STOP_CATALOG_GATEWAY_NOT_STARTED');
  console.log('NATIVE_CLOUD_GATEWAY_HTTP_200');
  switchWeb(previousWeb);
  console.log('NATIVE_WEB_PUBLISHED');
  try{shell('systemctl',['start','beatgaler-pg-backup.service'],190000);console.log('POST_CUTOVER_BACKUP_PASS')}catch(_){console.log('POST_CUTOVER_BACKUP_UNVERIFIED')}
  console.log('NATIVE_WEB_AND_CLOUD_PUBLISHED;G2_MEDIA_SMOKE=NOT_PROVEN;REUSED_BOT_RISK_ACCEPTED;TELEGRAM_MEDIA_DELETED=0;TOKEN_ROTATIONS=0');
 }catch(e){
  console.error('GO_LIVE_STOP:',String(e.code||e.message).replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[HIDDEN]'));
  if(stopped){
   try{
    if(previousStart&&fs.existsSync(previousStart))fs.copyFileSync(previousStart,START);
    shell('systemctl',['start','beatgaler-cloud.service'],130000);
    console.error('CLOUD_RECOVERY_START_ATTEMPTED');
   }catch(_){console.error('CLOUD_RECOVERY_REQUIRES_MANUAL_ACTION')}
  }
  if(activated)console.error('SQL_ACTIVATION_COMMITTED_DO_NOT_CLAIM_ROLLBACK');
  process.exitCode=3;
 }finally{await pool.end().catch(()=>{})}
}
main().catch(e=>{console.error('GO_LIVE_PREFLIGHT_STOP:',e.code||e.message);process.exitCode=3});
