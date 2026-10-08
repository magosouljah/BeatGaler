import fs from 'node:fs';
import path from 'node:path';

const slowOnly = process.argv.includes('--slow-only');
const dirs = process.argv.slice(2).filter(value => value !== '--slow-only');
const parse = entry => {
  const at = String(entry?.line || '').indexOf('[play-trace]');
  if (at < 0) return null;
  try { return JSON.parse(entry.line.slice(at + 12).trim()); } catch { return null; }
};
const round = n => n == null ? null : Math.round(n);
const elapsed = (a,b) => a == null || b == null ? null : round(b-a);
const inWindow = (x,start,end) => x.ts_ms >= start-150 && x.ts_ms <= end+300;
const rows = [];
for (const dir of dirs) for (const file of fs.readdirSync(dir).filter(x => /^run-\d\d-measurement-raw\.json$/.test(x)).sort()) {
  const report = JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
  const run = Number(file.match(/run-(\d+)/)[1]);
  for (const sample of report.phase2_task0.samples.play_tras_biblioteca_autoritativa) {
    const start = sample.clicked_at_ms, end = sample.first_playing_at_ms;
    const main = (sample.main_play_trace || []).map(parse).filter(Boolean).filter(x=>inWindow(x,start,end));
    const worker = (sample.worker_path_trace || []).map(parse).filter(Boolean).filter(x=>x.ts_ms >= start-5000 && x.ts_ms <= end+300);
    const m = stage => main.find(x=>x.stage===stage);
    const click=m('CARD_PLAY_CLICK'),handle=m('APP_HANDLE_PLAY_ENTER'),prefix=m('PLAY_PREFIX_READY');
    const range=m('SOURCE_FIRST_PLAYABLE_RANGE'),playing=m('AUDIO_EVENT_PLAYING');
    const message=prefix?.message_id??m('ADAPTER_PREPARE_ENTER')?.message_id??null;
    const raw=[start,click?.ts_ms,handle?.ts_ms,prefix?.ts_ms,range?.ts_ms,playing?.ts_ms,end];
    const stageKeys=['webdriver_to_dom_click','dom_click_to_controller','controller_to_prefix','prefix_to_mse_range','mse_range_to_playing','playing_to_threshold_0_5'];
    const segments=Object.fromEntries(stageKeys.map((key,i)=>[key,elapsed(raw[i],raw[i+1])]));
    const explained=Object.values(segments).every(x=>x!=null)?Object.values(segments).reduce((a,b)=>a+b,0):null;
    const workerTarget=worker.filter(x=>x.message_id===message || x.focused_message_id===message || x.message_ids?.includes(message));
    const gmBegins=workerTarget.filter(x=>x.stage==='WORKER_MEDIA_GET_MESSAGES_BEGIN' && x.ts_ms <= (prefix?.ts_ms??end));
    const gmBegin=gmBegins.at(-1);
    const gmDone=gmBegin && workerTarget.find(x=>x.stage==='WORKER_MEDIA_GET_MESSAGES_DONE' && x.request_id===gmBegin.request_id && x.ts_ms>=gmBegin.ts_ms);
    const gmPhysical=gmBegin ? worker.filter(x=>x.stage.startsWith('WORKER_GET_MESSAGES_') && Array.isArray(x.message_ids) && x.message_ids.includes(message) && x.ts_ms>=gmBegin.ts_ms-100 && x.ts_ms<=(gmDone?.ts_ms??end)+100) : [];
    const batchIds=[...new Set(gmPhysical.map(x=>x.batch_id).filter(x=>x!=null))];
    const gmBatches=batchIds.map(batchId=>{
      const x=gmPhysical.filter(x=>x.batch_id===batchId);
      const at=stage=>x.find(y=>y.stage===stage)?.ts_ms;
      const call=at('WORKER_GET_MESSAGES_CALL_ENTER'),queued=at('WORKER_GET_MESSAGES_RPC_QUEUED'),flush=at('WORKER_GET_MESSAGES_MT_PROTO_FLUSH'),send=at('WORKER_GET_MESSAGES_WEBSOCKET_SEND_CALLED'),result=at('WORKER_GET_MESSAGES_RPC_RESULT_ENTER'),done=at('WORKER_GET_MESSAGES_CALL_DONE');
      const resultEvent=x.find(y=>y.stage==='WORKER_GET_MESSAGES_RPC_RESULT_ENTER');
      const connectionEvent=x.find(y=>y.stage==='WORKER_GET_MESSAGES_CONNECTION_RPC_BEGIN');
      const flushEvent=x.find(y=>y.stage==='WORKER_GET_MESSAGES_MT_PROTO_FLUSH');
      return {batch_id:batchId,method:x[0]?.rpc_method??null,call_at:elapsed(start,call),queued_at:elapsed(start,queued),flush_at:elapsed(start,flush),send_at:elapsed(start,send),websocket_message_at:elapsed(start,resultEvent?.websocket_message_ts_ms),result_at:elapsed(start,result),done_at:elapsed(start,done),call_to_send_ms:elapsed(call,send),send_to_result_ms:elapsed(send,result),result_to_done_ms:elapsed(result,done),socket_id:resultEvent?.socket_id??null,connection_uid:resultEvent?.connection_uid??null,dc_id:connectionEvent?.dc_id??null,queued_before:connectionEvent?.queued_before??null,in_flight_before:connectionEvent?.in_flight_before??null,in_flight_at_flush:flushEvent?.in_flight_rpc_count??null,since_previous_physical_rpc_ms:flushEvent?.since_previous_physical_rpc_ms??null,physical_rpc_ordinal:resultEvent?.physical_rpc_ordinal??null,rpc_msg_id:resultEvent?.rpc_msg_id??null,acked:resultEvent?.acked??null,retries:x.filter(y=>y.stage==='WORKER_GET_MESSAGES_RPC_RETRY').length,send_count:x.filter(y=>y.stage==='WORKER_GET_MESSAGES_WEBSOCKET_SEND_CALLED').length};
    });
    const fileSends=workerTarget.filter(x=>x.stage==='WORKER_GET_FILE_WEBSOCKET_SEND_CALLED');
    const fileResults=workerTarget.filter(x=>x.stage==='WORKER_GET_FILE_RPC_RESULT_ENTER');
    const getFile=fileSends.map(send=>{
      const result=fileResults.find(x=>x.request_id===send.request_id&&x.rpc_seq===send.rpc_seq&&x.ts_ms>=send.ts_ms);
      return result ? {send_at:elapsed(start,send.ts_ms),result_at:elapsed(start,result.ts_ms),send_to_result_ms:elapsed(send.ts_ms,result.ts_ms),socket_id:result.socket_id??null,connection_uid:result.connection_uid??null} : null;
    }).filter(Boolean);
    const events={};
    for(const stage of ['CARD_PLAY_CLICK','CARD_PLAY_ACCEPTED','APP_HANDLE_PLAY_ENTER','APP_PREPARE_BEGIN','ADAPTER_PREPARE_ENTER','PLAY_FOCUS_BEGIN','WORKER_PLAYBACK_REQUEST_POSTED','PLAY_WARM_PROMOTED','PLAY_WARM_PROMOTED_READY','CONTROLLER_CONNECT_REUSE','CONTROLLER_VAULT_PEER_READY','WORKER_PREFIX_RECEIVED_MAIN','SOURCE_PREPARE','PLAY_PREFIX_READY','SOURCE_URL_READY','APP_PREPARE_READY','APP_AUDIO_PLAY_CALL','AUDIO_PLAY_FUNCTION_ENTER','AUDIO_EVENT_PLAY','AUDIO_EVENT_WAITING','SOURCE_MSE_SOURCEOPEN','SOURCE_MSE_APPEND_BEGIN','SOURCE_MSE_APPEND_DONE','SOURCE_FIRST_PLAYABLE_RANGE','AUDIO_EVENT_PLAYING','AUDIO_FIRST_PROGRESS'])events[stage]=elapsed(start,m(stage)?.ts_ms);
    for(const stage of ['WORKER_PLAYBACK_REQUEST_RECEIVED','WORKER_PLAYBACK_FOCUS','WORKER_PREFETCH_ENTER','WORKER_MEDIA_RESOLVE_CACHE','WORKER_MEDIA_RESOLVE_READY','WORKER_DATA_LANE_ACQUIRED','WORKER_PREFIX_DOWNLOAD_BEGIN','WORKER_PREFIX_DOWNLOAD_DONE','WORKER_PREFETCH_READY','WARM_PREFIX_READY'])events[stage]=elapsed(start,workerTarget.find(x=>x.stage===stage)?.ts_ms);
    rows.push({experiment:path.basename(dir),run,account:sample.account_label,round:sample.round,message_id:message,total_ms:elapsed(start,end),segments,explained_ms:explained,gap_ms:explained==null?null:round(end-start)-explained,events,webdriver_click_returned_at:elapsed(start,sample.webdriver_click_returned_at_ms),getMessages:gmBegin?{begin_at:elapsed(start,gmBegin.ts_ms),done_at:elapsed(start,gmDone?.ts_ms),total_ms:elapsed(gmBegin.ts_ms,gmDone?.ts_ms),cache:workerTarget.find(x=>x.stage==='WORKER_MEDIA_RESOLVE_CACHE')?.hits??null,physical:gmBatches}:null,getFile,first_audio_playing_at:elapsed(start,sample.first_audio_playing_at_ms),first_progress_gt0_at:elapsed(start,sample.first_progress_gt_0_at_ms),first_progress_ge01_at:elapsed(start,sample.first_progress_ge_0_1_at_ms),first_progress_ge05_at:elapsed(start,sample.first_progress_ge_0_5_at_ms),warm_promoted:main.some(x=>x.stage==='PLAY_WARM_PROMOTED'&&x.message_id===message),target_cache_miss:workerTarget.some(x=>x.stage==='WORKER_PLAYBACK_MEDIA_CACHE_MISS'),target_pending_join:workerTarget.some(x=>x.stage==='WORKER_PLAYBACK_MEDIA_PENDING_JOIN'),trace: elapsed(start,end)>=3000 ? {main:main.map(x=>({at:elapsed(start,x.ts_ms),stage:x.stage})),worker:worker.filter(x=>inWindow(x,start,end)).map(x=>({at:elapsed(start,x.ts_ms),stage:x.stage,message_id:x.message_id??undefined}))} : undefined});
  }
}
console.log(JSON.stringify(slowOnly
  ? {schema_version:1,description:'Task0 Play >=3000 ms; relative milliseconds from pre-WebDriver click timestamp; raw traces remain in tmp/phase2-task0.',rows:rows.filter(row=>row.total_ms>=3000)}
  : {rows},null,2));
