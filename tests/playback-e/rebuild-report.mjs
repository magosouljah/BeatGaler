import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const tmp = path.join(root, 'tmp/playback-e');
const traces = path.join(here, 'traces');
const manifestPath = path.join(traces, 'manifest.json');
const collect = process.argv.includes('--collect');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const n1 = value => value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
const pct = (values, p) => { const a = values.filter(Number.isFinite).sort((x,y) => x-y); return a.length ? n1(a[Math.ceil(a.length*p)-1]) : null; };
const stats = values => ({ n: values.filter(Number.isFinite).length, p50:pct(values,.5), p95:pct(values,.95), p99:pct(values,.99), max:pct(values,1),
  ge15:values.filter(v=>v>=1500).length, ge3:values.filter(v=>v>=3000).length, ge6:values.filter(v=>v>=6000).length, ge9:values.filter(v=>v>=9000).length });
const plans = [
  ['e1-baseline',5,'shared','96,101'], ['e2-e10-fresh',10,'fresh','96,101'],
  ['e3-microtask',1,'fresh','96,101'], ['e3-immediate',1,'fresh','96,101'],
  ['e3-delay1',1,'fresh','96,101'], ['e2-cross-over',1,'mixed','96,101'],
  ['e2-cross-over-b',1,'mixed','96,101'],
  ['e8-inverse-shared',1,'shared','101,96'],
  ['e8-inverse-fresh',1,'fresh','101,96'], ['e6-one-shared',1,'shared','96'],
  ['e6-one-fresh',1,'fresh','96'], ['e6-three-shared',1,'shared','96,101,101'],
  ['e6-three-fresh',1,'fresh','96,101,101'], ['e6-four-shared',1,'shared','96,101,101,101'],
  ['e6-four-fresh',1,'fresh','96,101,101,101'], ['e7-small-small-shared',1,'shared','96,96'],
  ['e7-small-small-fresh',1,'fresh','96,96'],
  ['e11-stress-shared',2,'shared','96,101,101,101,101,101,101'],
  ['e11-stress-fresh',2,'fresh','96,101,101,101,101,101,101'],
  // Also accept the original one-process stress plan if it completed before
  // the shortened auth-safe batches were introduced.
  ['e11-stress-shared',1,'shared','96,101,101,101,101,101,101'],
  ['e11-stress-fresh',1,'fresh','96,101,101,101,101,101,101'],
  ['e2-switch',1,'mixed','96,101'],
  ['e2-reset',1,'mixed','96,101'],
  ['e2-reset-immediate',1,'mixed','96,101'],
];
if (collect) {
  fs.mkdirSync(traces, { recursive:true });
  const manifest = [];
  for (const [base,batches,writer,ids] of plans) for (let i=1;i<=batches;i++) {
    const name = batches>1 ? `${base}-${String(i).padStart(2,'0')}` : base;
    const dir = path.join(tmp,name);
    if (!fs.existsSync(path.join(dir,'trace.jsonl'))) continue;
    const raw = fs.readFileSync(path.join(dir,'trace.jsonl'));
    const gz = zlib.gzipSync(raw,{level:9});
    const summary = JSON.parse(fs.readFileSync(path.join(dir,'summary.json')));
    const bufferDir=path.join(dir,'buffers');
    const bufferSamples=[];
    if(fs.existsSync(bufferDir))for(const file of fs.readdirSync(bufferDir).filter(x=>x.endsWith('.json'))){
      const stem=file.slice(0,-5);const meta=JSON.parse(fs.readFileSync(path.join(bufferDir,file)));
      const ws=fs.readFileSync(path.join(bufferDir,`${stem}-ws.bin`));
      if(digest(ws)!==meta.ws_sha256)throw new Error(`WS buffer hash mismatch: ${name}/${stem}`);
      const units=meta.units.map((unit,index)=>{const data=fs.readFileSync(path.join(bufferDir,`${stem}-unit-${index+1}.bin`));
        if(digest(data)!==unit.sha256)throw new Error(`Unit buffer hash mismatch: ${name}/${stem}/${index+1}`);
        return data;});
      if(meta.exact_cipher_concat&&!Buffer.concat(units).equals(ws))throw new Error(`Byte concatenation mismatch: ${name}/${stem}`);
      const boundary=units.length>1?units[0].length:null;
      bufferSamples.push({stem,run_id:meta.run_id,ws_sha256:meta.ws_sha256,ws_bytes:meta.ws_bytes,
        units:meta.units,exact_cipher_concat:meta.exact_cipher_concat,
        boundary_offset:boundary,
        boundary_before_hex:boundary==null?null:ws.subarray(Math.max(0,boundary-8),boundary).toString('hex'),
        boundary_after_hex:boundary==null?null:ws.subarray(boundary,boundary+8).toString('hex')});
    }
    const file = `${name}.jsonl.gz`;
    fs.writeFileSync(path.join(traces,file),gz);
    manifest.push({ name, base, writer, message_ids:ids.split(',').map(Number),
      requested_runs:summary.requested_runs, status:summary.status, file,
      raw_sha256:digest(raw), raw_bytes:raw.length, gzip_sha256:digest(gz), gzip_bytes:gz.length,
      summary_sha256:digest(fs.readFileSync(path.join(dir,'summary.json'))),buffer_samples:bufferSamples });
  }
  fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
}
if (!fs.existsSync(manifestPath)) throw new Error('No traces/manifest.json. Run suite, then --collect.');
const manifest=JSON.parse(fs.readFileSync(manifestPath));
const groups=new Map();
for(const item of manifest){
  const compressed=fs.readFileSync(path.join(traces,item.file));
  if(digest(compressed)!==item.gzip_sha256) throw new Error(`Compressed hash mismatch: ${item.file}`);
  const raw=zlib.gunzipSync(compressed);
  if(digest(raw)!==item.raw_sha256) throw new Error(`Raw hash mismatch: ${item.file}`);
  const ev=raw.toString().trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const byRun=new Map();
  for(const e of ev) if(e.run_id?.startsWith('test-d-raw-')){
    if(!byRun.has(e.run_id))byRun.set(e.run_id,[]);
    byRun.get(e.run_id).push(e);
  }
  if(!groups.has(item.base))groups.set(item.base,{writer:item.writer,ids:item.message_ids,runs:[],sources:[],setupCoalesced:0});
  const group=groups.get(item.base); group.sources.push(item.name);
  group.setupCoalesced+=ev.filter(e=>e.run_id?.startsWith('setup-')&&e.stage==='D_WEBSOCKET_SEND'&&e.coalesced_packets>1).length;
  for(const [runId,events] of byRun){
    const sorted=events.sort((a,b)=>a.ts_ms-b.ts_ms);
    const start=sorted.find(e=>e.stage==='START'); if(!start)continue;
    const end=sorted.find(e=>e.stage==='END');
    const sends=sorted.filter(e=>e.stage==='D_RPC_WEBSOCKET_SEND');
    const results=sorted.filter(e=>e.stage==='D_RPC_RESULT');
    const initial=sends.filter(e=>e.message_id===96||e.message_id===101).slice(0,item.message_ids.length);
    const rpc=initial.map(e=>{const result=results.find(x=>x.msg_id===e.msg_id&&x.ts_ms>=e.ts_ms);
      const eventual=results.find(x=>x.key===e.key&&x.ts_ms>=e.ts_ms);
      return{message_id:e.message_id,msg_id:e.msg_id,key:e.key,packet_id:e.packet_id,ws_send_id:e.ws_send_id,
        socket_id:e.socket_id,session_tag:e.session_tag,dc_id:e.dc_id,connection_uid:e.connection_uid,
        send_ms:n1(e.ts_ms-start.ts_ms),duration_ms:result?n1(result.ts_ms-e.ts_ms):null,
        eventual_duration_ms:eventual?n1(eventual.ts_ms-e.ts_ms):null,
        result_ms:result?n1(result.ts_ms-start.ts_ms):null};});
    const target=rpc.find(e=>e.message_id===96);
    const firstResult=Math.min(...rpc.map(e=>e.result_ms??Infinity));
    const valid=!!end&&rpc.length===item.message_ids.length&&rpc.every(e=>e.duration_ms!=null)
      &&rpc.every(e=>e.socket_id===rpc[0].socket_id&&e.session_tag===rpc[0].session_tag&&e.dc_id===rpc[0].dc_id)
      &&rpc.every(e=>e.send_ms<firstResult);
    const firstWrites=[...new Set(rpc.map(e=>e.ws_send_id))];
    const writeEvents=sorted.filter(e=>e.stage==='D_WEBSOCKET_SEND');
    const initialWrites=writeEvents.filter(e=>firstWrites.includes(e.ws_send_id));
    const allWrites=writeEvents;
    const recovery=sorted.filter(e=>e.stage==='D_STATE_REQ_WEBSOCKET_SEND');
    const byte=sorted.filter(e=>e.stage==='E_BYTE_BOUNDARY');
    const resource=sorted.find(e=>e.stage==='E_RESOURCE');
    const reset=sorted.find(e=>e.stage==='E_RECONNECT_READY'&&e.ts_ms<start.ts_ms);
    const row={ series:item.name,run_id:runId,valid,status:end?'OK':'ERROR',ids:item.message_ids,rpc,
      writer_mode:sorted.find(e=>e.stage==='E_WRITER_MODE')?.mode??item.writer,
      reconnect_before:reset?{socket_id_before:reset.socket_id_before,
        socket_id_after:reset.socket_id_after,session_tag:reset.session_tag}:null,
      target_ms:target?.duration_ms??null,run_ms:end?n1(end.ts_ms-start.ts_ms):null,
      target_eventual_ms:target?.eventual_duration_ms??null,
      write_count:firstWrites.length,packet_count:new Set(rpc.map(e=>e.packet_id)).size,
      coalesced:firstWrites.length===1&&rpc.length>1&&new Set(rpc.map(e=>e.packet_id)).size===rpc.length,
      split:firstWrites.length===rpc.length&&new Set(rpc.map(e=>e.packet_id)).size===rpc.length,
      concurrent:rpc.length>1&&rpc.every(e=>e.send_ms<firstResult),
      send_gap_ms:rpc.length>1?n1(Math.max(...rpc.map(e=>e.send_ms))-Math.min(...rpc.map(e=>e.send_ms))):null,
      raw_call_gap_ms:(()=>{const x=sorted.filter(e=>e.stage==='D_RAW_CALL_BEGIN'); return x.length>1?n1(x.at(-1).ts_ms-x[0].ts_ms):null;})(),
      state_requests:recovery.length,server_acks:sorted.filter(e=>e.stage==='D_SERVER_ACK').length,
      requeues:sorted.filter(e=>e.stage==='D_RPC_REQUEUED').length,
      new_sockets:sorted.filter(e=>e.stage==='D_SOCKET_SEEN').length,
      inbound_ws_messages:sorted.filter(e=>e.stage==='E_WS_MESSAGE_RECEIVED').length,
      inbound_ws_bytes:sorted.filter(e=>e.stage==='E_WS_MESSAGE_RECEIVED').reduce((n,e)=>n+(e.message_bytes||0),0),
      auth_errors:sorted.filter(e=>e.rpc_error_tag==='AUTH_KEY_UNREGISTERED').length,
      flood_errors:sorted.filter(e=>String(e.rpc_error_tag||'').startsWith('FLOOD_WAIT')).length,
      socket_writes:allWrites.length, socket_bytes:allWrites.reduce((n,e)=>n+(e.sent_bytes||0),0),
      max_buffered_before:Math.max(0,...allWrites.map(e=>e.buffered_amount_before||0)),
      downloaded_bytes:end?.bytes_by_message?.reduce((n,e)=>n+(e.bytes||0),0)??null,
      cpu_ms:resource?n1((resource.cpu_user_us+resource.cpu_system_us)/1000):null,
      rss_delta_mb:resource?n1((resource.rss_after_bytes-resource.rss_before_bytes)/1048576):null,
      first_write_bytes:initialWrites.map(e=>e.sent_bytes),
      byte_evidence:byte.filter(e=>firstWrites.includes(e.ws_send_id)).map(e=>({
        ws_send_id:e.ws_send_id,sha256:e.sha256,bytes:e.sent_bytes,unit_lengths:e.unit_lengths,
        exact_cipher_concat:e.exact_cipher_concat,boundary_offset:e.boundary_offset})),
      timeline:sorted.filter(e=>['START','D_RAW_CALL_BEGIN','D_RPC_ENQUEUE','D_RPC_FLUSH','D_PACKET_ENCODED',
        'D_WEBSOCKET_SEND','D_SERVER_ACK','D_STATE_REQ_WEBSOCKET_SEND','D_STATE_INFO_RECEIVED',
        'D_RPC_RESULT','D_RPC_REQUEUED','END','RUN_ERROR'].includes(e.stage))
        .map(e=>({t_ms:n1(e.ts_ms-start.ts_ms),stage:e.stage,message_id:e.message_id??null,
          ws_send_id:e.ws_send_id??null,packet_id:e.packet_id??null,status:e.status??null}))};
    group.runs.push(row);
  }
}
const aggregate=group=>{const v=group.runs.filter(r=>r.valid);const s=stats(v.map(r=>r.target_ms));return{
  ...s,requested:group.runs.length,valid:v.length,unpaired:group.runs.length-v.length,
  logical_errors:group.runs.filter(r=>r.status!=='OK').length,
  eventual_target:stats(group.runs.filter(r=>r.status==='OK').map(r=>r.target_eventual_ms)),
  coalesced:v.filter(r=>r.coalesced).length,split:v.filter(r=>r.split).length,
  concurrent:v.filter(r=>r.concurrent).length,recovery:v.filter(r=>r.state_requests>0).length,
  new_socket_runs:group.runs.filter(r=>r.new_sockets>0).length,
  auth_error_runs:group.runs.filter(r=>r.auth_errors>0).length,
  flood_error_runs:group.runs.filter(r=>r.flood_errors>0).length,
  inbound_ws_messages_p50:pct(v.map(r=>r.inbound_ws_messages),.5),
  send_gap_p95:pct(v.map(r=>r.send_gap_ms),.95),call_gap_p95:pct(v.map(r=>r.raw_call_gap_ms),.95),
  writes_per_run:pct(v.map(r=>r.socket_writes),.5),bytes_per_run:pct(v.map(r=>r.socket_bytes),.5),
  initial_write_bytes_p50:pct(v.map(r=>r.first_write_bytes.reduce((n,x)=>n+x,0)),.5),
  downloaded_bytes_p50:pct(v.map(r=>r.downloaded_bytes),.5),
  writes_per_second_p50:pct(v.map(r=>r.run_ms>0?r.socket_writes*1000/r.run_ms:null),.5),
  download_bytes_per_second_p50:pct(v.map(r=>r.run_ms>0?r.downloaded_bytes*1000/r.run_ms:null),.5),
  cpu_ms_p50:pct(v.map(r=>r.cpu_ms),.5),rss_delta_mb_p50:pct(v.map(r=>r.rss_delta_mb),.5),
  run_ms_p50:pct(v.map(r=>r.run_ms),.5),max_buffered_before:Math.max(0,...v.map(r=>r.max_buffered_before))};};
const analysis=Object.fromEntries([...groups].map(([name,g])=>[name,{writer:g.writer,ids:g.ids,sources:g.sources,
  setup_coalesced_writes:g.setupCoalesced,stats:aggregate(g),runs:g.runs}]));
if(analysis['e2-cross-over']&&analysis['e2-cross-over-b']){
  const a=analysis['e2-cross-over'],b=analysis['e2-cross-over-b'];
  a.runs.push(...b.runs);a.sources.push(...b.sources);a.stats=aggregate(a);
}
if(analysis['e2-cross-over'])for(const mode of ['shared','fresh']){
  const parent=analysis['e2-cross-over'];const g={writer:mode,ids:parent.ids,sources:parent.sources,
    runs:parent.runs.filter(r=>r.writer_mode===mode)};
  analysis[`e2-cross-over-${mode}`]={...g,stats:aggregate(g)};
}
if(analysis['e2-switch'])for(const [label,lo,hi,writer] of [
  ['clean-fresh',1,15,'fresh'],['shared',16,30,'shared'],['post-fresh',31,45,'fresh']]){
  const parent=analysis['e2-switch'];const g={writer,ids:parent.ids,sources:parent.sources,
    runs:parent.runs.filter(r=>{const i=Number(r.run_id.slice(-3));return i>=lo&&i<=hi;})};
  analysis[`e2-switch-${label}`]={...g,stats:aggregate(g)};
}
if(analysis['e2-reset'])for(const [label,lo,hi,writer] of [
  ['clean-fresh',1,10,'fresh'],['shared',11,15,'shared'],
  ['post-fresh',16,20,'fresh'],['after-reconnect',21,30,'fresh']]){
  const parent=analysis['e2-reset'];const g={writer,ids:parent.ids,sources:parent.sources,
    runs:parent.runs.filter(r=>{const i=Number(r.run_id.slice(-3));return i>=lo&&i<=hi;})};
  analysis[`e2-reset-${label}`]={...g,stats:aggregate(g)};
}
if(analysis['e2-reset-immediate'])for(const [label,lo,hi,writer] of [
  ['clean-fresh',1,10,'fresh'],['shared',11,13,'shared'],
  ['post-fresh',14,14,'fresh'],['after-reconnect',15,24,'fresh']]){
  const parent=analysis['e2-reset-immediate'];const g={writer,ids:parent.ids,sources:parent.sources,
    runs:parent.runs.filter(r=>{const i=Number(r.run_id.slice(-3));return i>=lo&&i<=hi;})};
  analysis[`e2-reset-immediate-${label}`]={...g,stats:aggregate(g)};
}
fs.writeFileSync(path.join(here,'analysis.json'),JSON.stringify(analysis)+'\n');
const fmt=x=>x==null?'—':String(x);
const row=(label,g)=>{const s=g?.stats;return `| ${label} | ${g?.writer??'—'} | sí | ${s?`${s.coalesced} conjunta / ${s.split} separadas`:'—'} | ${fmt(s?.valid)} | ${fmt(s?.p50)} | ${fmt(s?.p95)} | ${fmt(s?.p99)} | ${fmt(s?.max)} | ${fmt(s?.ge6)} |`;};
const baseline=analysis['e1-baseline'],fresh=analysis['e2-e10-fresh'];
const upperZeroTail=fresh?.stats.valid&&fresh.stats.ge6===0
  ?n1((1-Math.pow(.05,1/fresh.stats.valid))*100):null;
const lines=[
  '# Test E · frontera de escritura del transporte MTProto', '',
  '## 1. Executive conclusion', '',
  `**${baseline?.stats.valid>=200&&baseline.stats.ge6>0&&fresh?.stats.valid>=500&&fresh.stats.ge6===0?'Desencadenante local confirmado con evidencia fuerte.':'Evidencia en evaluación; revisar los criterios de aceptación.'}** El writer compartido puede agrupar dos paquetes cifrados en una llamada WebSocket; el writer con buffer independiente mantiene la misma sesión, socket y concurrencia, y separa las llamadas. La solución candidata es dar un buffer independiente a cada llamada de \`FramedWriter.write\` y renovar sockets ya afectados durante la transición. La demora observada se mide de \`WebSocket.send\` a \`rpc_result\`; el procesamiento remoto interno no es observable.`, '',
  '## 2. Causal chain', '',
  '`dos flushes MTProto` → `FramedWriter reutiliza un Bytes buffer` → `dos encode concurrentes escriben antes de los continuations de write` → `una WebSocket.send con dos unidades cifradas concatenadas` → `en los tails, respuesta RPC pendiente` → `state recovery antes del rpc_result tardío`. El último tramo describe correlación temporal observada; el servidor no está instrumentado.', '',
  'Código: `@mtcute/core/network/session-connection.js:1228,1558–1559` → `@mtcute/core/network/persistent-connection.js:92,193–200` → `@fuman/io/codec/writer.js:17–26` → `@mtcute/core/network/transports/obfuscated.js:58–61` → `@mtcute/core/network/transports/intermediate.js:26–28` → `@fuman/net/websocket.js:82–85`. El agrupamiento se produce en la dependencia `@fuman/io`, antes del `socket.send` de Node.', '',
  'La reproducción local determinista `node tests/playback-e/writer-race.mjs` usa el `FramedWriter` instalado: dos invocaciones concurrentes generan una escritura `[1,2,3,4]` con el writer compartido y dos escrituras `[1,2]`, `[3,4]` con un buffer por llamada. Es una prueba del mecanismo de buffer, no de la respuesta de Telegram.', '',
  '## 3. Tabla principal', '',
  '| Caso | writer | mismo socket y concurrente | writes iniciales | n | p50 ms | p95 ms | p99 ms | max ms | ≥6 s |',
  '|---|---|---|---|---:|---:|---:|---:|---:|---:|',
  row('E1 · 96+101 baseline',baseline),row('E2/E10 · 96+101 buffer por paquete',fresh), '',
  `E1: ${baseline?.stats.requested??0} intentos, ${baseline?.stats.unpaired??0} sin respuesta al msg_id físico inicial, ${baseline?.stats.logical_errors??0} fallos lógicos; E2/E10: ${fresh?.stats.requested??0} intentos, ${fresh?.stats.unpaired??0} sin par físico inicial, ${fresh?.stats.logical_errors??0} fallos lógicos. Los percentiles principales incluyen únicamente pares físicos completos, misma sesión/socket/DC, con ambos envíos antes de la primera respuesta. En E1, los intentos cuyo msg_id inicial no responde pueden completar por requeue/retry y permanecen visibles en analysis.json.`, '',
  `Si se sigue el mismo RPC lógico a través de retries, E1 tiene ${fmt(baseline?.stats.eventual_target.n)} respuestas del target; p50 ${fmt(baseline?.stats.eventual_target.p50)} ms, p95 ${fmt(baseline?.stats.eventual_target.p95)} ms y ${fmt(baseline?.stats.eventual_target.ge6)} ≥6 s desde su primer envío. La tabla principal mantiene el criterio físico más estricto.`, '',
  `Incidentes observados por run: socket nuevo durante el intento ${fmt(baseline?.stats.new_socket_runs)} → ${fmt(fresh?.stats.new_socket_runs)}; AUTH_KEY_UNREGISTERED ${fmt(baseline?.stats.auth_error_runs)} → ${fmt(fresh?.stats.auth_error_runs)}; FLOOD_WAIT ${fmt(baseline?.stats.flood_error_runs)} → ${fmt(fresh?.stats.flood_error_runs)}.`, '',
  ...(upperZeroTail==null?[]:[`Con 0/${fresh.stats.valid} tails en la variante, el límite superior binomial unilateral aproximado al 95% para la tasa de tails es ${upperZeroTail}% (asumiendo intentos independientes). La prueba no demuestra tasa cero absoluta.`, '']),
  '### Controles de orden, timing, cantidad y tamaño', '',
  '| Caso | n válido | writes conjuntas / separadas | p50 / p95 / max 96 (ms) | ≥6 s | send gap p95 (ms) | bytes iniciales / descargados p50 | state recovery |',
  '|---|---:|---:|---:|---:|---:|---:|---:|'
];
for(const [name,g] of Object.entries(analysis)) if(!['e1-baseline','e2-e10-fresh','e2-cross-over','e2-cross-over-b','e2-switch','e2-reset','e2-reset-immediate'].includes(name)){const s=g.stats;
  lines.push(`| ${name} | ${s.valid} | ${s.coalesced} / ${s.split} | ${fmt(s.p50)} / ${fmt(s.p95)} / ${fmt(s.max)} | ${s.ge6} | ${fmt(s.send_gap_p95)} | ${fmt(s.initial_write_bytes_p50)} / ${fmt(s.downloaded_bytes_p50)} | ${s.recovery} |`);}
if(analysis['e6-one-shared']&&analysis['e6-one-fresh'])lines.push('',
  `El control de **un solo getFile durante START** no arranca necesariamente limpio: el preparado de descriptores anterior a START hizo ${analysis['e6-one-shared'].setup_coalesced_writes} writes conjuntas en e6-one-shared y ${analysis['e6-one-fresh'].setup_coalesced_writes} en e6-one-fresh. Así se explica por qué un run con una sola write del target puede seguir lento en una sesión previamente expuesta; no demuestra que una write conjunta ocurriera durante ese run.`, '');
const crossover=analysis['e2-cross-over']?.runs||[];
const adjacent=[];
for(const source of new Set(crossover.map(r=>r.series))){const runs=crossover.filter(r=>r.series===source);
for(let i=0;i+1<runs.length;i+=2){const a=runs[i],b=runs[i+1];
  if(a.valid&&b.valid)adjacent.push({same_socket:a.rpc[0].socket_id===b.rpc[0].socket_id,
    same_session:a.rpc[0].session_tag===b.rpc[0].session_tag,
    same_dc:a.rpc[0].dc_id===b.rpc[0].dc_id});}}
lines.push('', `El control cruzado alterna writer compartido/fresh dentro del **mismo proceso y auth temporal**. Pares adyacentes válidos: ${adjacent.length}; mismo socket ${adjacent.filter(x=>x.same_socket).length}, misma sesión ${adjacent.filter(x=>x.same_session).length}, mismo DC ${adjacent.filter(x=>x.same_dc).length}.`, '');
if((analysis['e2-cross-over-fresh']?.stats.ge6??0)>0)lines.push(`**Efecto residual:** ${analysis['e2-cross-over-fresh'].stats.ge6} runs fresh del control cruzado tardaron ≥6 s después de runs shared en el mismo proceso. Por tanto una write conjunta no es necesaria *dentro del mismo run* una vez que la conexión ya estuvo expuesta a una. La serie principal de 500 fresh partió de conexiones sin writes conjuntas durante sus runs.`, '');
lines.push(`En ese control, los eventos locales \`WebSocket message\` recibidos por run tienen mediana ${fmt(analysis['e2-cross-over-shared']?.stats.inbound_ws_messages_p50)} (writer compartido) frente a ${fmt(analysis['e2-cross-over-fresh']?.stats.inbound_ws_messages_p50)} (fresh). El adaptador de \`@fuman/net\` agrega el contenido de cada mensaje recibido a un buffer de flujo; no conserva límites de frame para el parser MTProto.`, '');
if(analysis['e2-switch'])lines.push('La secuencia fresh→shared→fresh usa una sola auth/sesión/socket salvo reconnect observado. Los tres bloques de 15 aparecen separados en la tabla para detectar si una write conjunta deja latencia residual en writes posteriores ya separadas.', '');
if(analysis['e2-switch']){
  const series=analysis['e2-switch'].runs;
  const first=series.find(r=>r.run_id==='test-d-raw-001');
  lines.push('| Transición run | writer | socket / sesión iniciales | writes iniciales | 96 send→result (ms) | state req |',
    '|---:|---|---|---:|---:|---:|');
  for(const i of [14,15,16,17,18,19,20,29,30,31,32,33,34,45]){
    const r=series.find(x=>x.run_id===`test-d-raw-${String(i).padStart(3,'0')}`);
    if(!r)continue;
    const same=r.rpc[0]?.socket_id===first?.rpc[0]?.socket_id&&r.rpc[0]?.session_tag===first?.rpc[0]?.session_tag;
    lines.push(`| ${i} | ${r.writer_mode} | ${r.rpc[0]?.socket_id??'—'} / ${same?'misma':'cambió'} | ${r.write_count} | ${fmt(r.target_eventual_ms)} | ${r.state_requests} |`);
  }
  lines.push('');
}
if(analysis['e2-reset']){
  const r=analysis['e2-reset'].runs.find(x=>x.run_id==='test-d-raw-021');
  lines.push(`El control de reconnect reemplaza el socket **fuera de START** antes del run 21: ${r?.reconnect_before?.socket_id_before??'—'} → ${r?.reconnect_before?.socket_id_after??'—'}, con el mismo hash de sesión ${r?.reconnect_before?.session_tag??'—'}. Los bloques clean, shared, post y after-reconnect aparecen en la tabla. Es una prueba de recuperación secundaria; la solución candidata sigue siendo separar escrituras.`, '');
}
if(analysis['e2-reset-immediate']){
  const before=analysis['e2-reset-immediate'].runs.find(x=>x.run_id==='test-d-raw-014');
  const after=analysis['e2-reset-immediate'].runs.find(x=>x.run_id==='test-d-raw-015');
  lines.push(`En el control de reconnect **inmediato**: run 14 fresh en socket ${before?.rpc[0]?.socket_id??'—'} tardó ${fmt(before?.target_eventual_ms)} ms; el reconnect fuera de START cambió socket ${after?.reconnect_before?.socket_id_before??'—'} → ${after?.reconnect_before?.socket_id_after??'—'} con sesión ${after?.reconnect_before?.session_tag??'—'}; run 15 fresh tardó ${fmt(after?.target_eventual_ms)} ms. Los 10 runs posteriores aparecen en la tabla.`, '');
}
lines.push('', '## 4. Byte/framing evidence', '');
for(const name of ['e1-baseline','e2-e10-fresh']){const g=analysis[name];const example=g?.runs.find(r=>r.valid&&r.byte_evidence.length&&(name==='e1-baseline'?r.coalesced:r.split));
  if(example)lines.push(`- **${name}/${example.series}/${example.run_id}:** ${example.byte_evidence.map(e=>`write ${e.ws_send_id}: ${e.bytes} B, unidades ${e.unit_lengths.join('+')} B, SHA-256 ${e.sha256}, concatenación exacta=${e.exact_cipher_concat}`).join('; ')}.`);}
const badSample=manifest.find(m=>m.base==='e1-baseline')?.buffer_samples?.find(s=>s.run_id?.startsWith('test-d-raw')&&s.exact_cipher_concat&&s.units.length>1);
if(badSample)lines.push(`- **Frontera de bytes exacta:** offset ${badSample.boundary_offset} de ${badSample.ws_bytes} B; 8 bytes cifrados antes \`${badSample.boundary_before_hex}\`, después \`${badSample.boundary_after_hex}\`. El SHA-256 de la write es \`${badSample.ws_sha256}\`; las longitudes cifradas de cada unidad son ${badSample.units.map(u=>u.bytes).join(' + ')} B. Comparación de todos los bytes: write = unidad A || unidad B.`);
lines.push('', 'Los buffers completos cifrados de muestra quedan localmente en `tmp/playback-e/<serie>/buffers/` (ignorado por Git). El manifiesto del reporte archiva las trazas estructuradas, no claves ni contenido de los archivos. Obfuscated intermediate antepone 4 bytes LE de longitud **antes del cifrado** a cada paquete; por ello el prefijo no puede leerse directamente en el ciphertext. `WebSocket.send` equivale a una llamada de API/mensaje, pero la cantidad de frames WebSocket y paquetes TCP internos no se observa en esta interfaz.', '',
  '## 5. Timing evidence', '');
for(const name of ['e1-baseline','e2-e10-fresh']){const g=analysis[name];const example=name==='e1-baseline'?g?.runs.find(r=>r.valid&&r.target_ms>=6000):g?.runs.find(r=>r.valid&&r.split);
  if(example){lines.push(`**${name}/${example.series}/${example.run_id}** · 96 send→result ${example.target_ms} ms; writes iniciales ${example.write_count}; estado ${example.state_requests}:`,'');
    for(const e of example.timeline.filter(e=>['START','D_RAW_CALL_BEGIN','D_RPC_FLUSH','D_WEBSOCKET_SEND','D_STATE_REQ_WEBSOCKET_SEND','D_STATE_INFO_RECEIVED','D_RPC_RESULT','END'].includes(e.stage)).slice(0,35))lines.push(`- +${e.t_ms} ms ${e.stage}${e.message_id?` m${e.message_id}`:''}${e.ws_send_id?` write#${e.ws_send_id}`:''}`);
    lines.push('');}}
lines.push('## 6. Stress', '',
  `Siete solicitudes concurrentes en la misma conexión: baseline ${fmt(analysis['e11-stress-shared']?.stats.valid)} runs válidos, p95 ${fmt(analysis['e11-stress-shared']?.stats.p95)} ms, ≥6 s ${fmt(analysis['e11-stress-shared']?.stats.ge6)}; buffer independiente ${fmt(analysis['e11-stress-fresh']?.stats.valid)} runs válidos, p95 ${fmt(analysis['e11-stress-fresh']?.stats.p95)} ms, ≥6 s ${fmt(analysis['e11-stress-fresh']?.stats.ge6)}.`, '',
  '## 7. Overhead', '',
  'Para el par inicial 96+101, los 376 bytes cifrados son iguales **en cantidad**: una `WebSocket.send(376 B)` en baseline o dos `send(220 B)` y `send(156 B)` en la variante. Se agrega una llamada de API por par, no bytes de framing MTProto. El ciphertext concreto difiere por sesión/contador y no se compara entre runs.', '',
  `En los pares principales: mediana de escrituras observadas por run (incluido recovery) ${fmt(baseline?.stats.writes_per_run)} → ${fmt(fresh?.stats.writes_per_run)}; bytes salientes medianos ${fmt(baseline?.stats.bytes_per_run)} → ${fmt(fresh?.stats.bytes_per_run)}; escrituras/s medianas ${fmt(baseline?.stats.writes_per_second_p50)} → ${fmt(fresh?.stats.writes_per_second_p50)}; throughput de bytes descargados mediano ${fmt(baseline?.stats.download_bytes_per_second_p50)} → ${fmt(fresh?.stats.download_bytes_per_second_p50)} B/s; CPU del proceso/run p50 ${fmt(baseline?.stats.cpu_ms_p50)} → ${fmt(fresh?.stats.cpu_ms_p50)} ms; delta RSS p50 ${fmt(baseline?.stats.rss_delta_mb_p50)} → ${fmt(fresh?.stats.rss_delta_mb_p50)} MiB; mediana run START→END ${fmt(baseline?.stats.run_ms_p50)} → ${fmt(fresh?.stats.run_ms_p50)} ms; máximo bufferedAmount antes de send ${fmt(baseline?.stats.max_buffered_before)} → ${fmt(fresh?.stats.max_buffered_before)} B. CPU incluye el worker y no aísla sólo el writer; frames TCP no medidos. El número de bytes de framing MTProto no cambia; sí crece el número de llamadas WebSocket.`, '',
  '## 8. Root cause', '',
  '**Demostrado:** el buffer reutilizado de `FramedWriter` permite juntar ciphertext de múltiples paquetes en una llamada de WebSocket; la separación local conserva conexiones y concurrencia. La concatenación se verifica byte por byte con hashes de cada muestra.', '',
  '**Altamente probable:** la escritura conjunta deja un estado transitorio de conexión que también afecta a escrituras posteriores ya separadas. El control fresh→shared→fresh muestra esa persistencia; el control de reconnect inmediato conserva la sesión, cambia sólo el socket y recupera tiempos normales. El punto exacto de ese estado (cliente, red o extremo remoto) no es observable aquí. Los escalones de recovery se activan mientras el RPC sigue pendiente y antes de su resultado tardío.', '',
  'Esta condición es **directa, sin WARM**: el harness llama `downloadChunk` para 96 y 101. El Test D previo observó 0/100 tails al separar sockets; Test E mantiene el mismo socket y demuestra que compartirlo y solapar RPC no bastan en una conexión limpia. Una write conjunta tampoco es necesaria dentro de *cada* run lento después de que el socket ya quedó afectado. La condición de inicio reproducible aquí es exponer ese socket a writes conjuntas; su efecto residual se observa hasta el reconnect.', '',
  '**Todavía no observable desde cliente:** tiempo interno del servidor, número real de frames WebSocket emitidos ni segmentación TCP. No se atribuye a Telegram una pérdida de paquete o bug concreto.', '',
  '## 9. Production recommendation', '',
  'Cambiar `FramedWriter.write` del `@fuman/io` fijado (`node_modules/@fuman/io/codec/writer.js:20–26`) mediante parche de dependencia o upstream: crear un `Bytes` local **por llamada**, codificar ahí y enviar esa copia como una sola unidad. Ése es el diff conceptual mínimo; el campo privado `#buffer` compartido deja de ser usado para escrituras solapadas. Mantener simultáneos los RPC y la misma conexión/socket en operación normal; no cambiar timeouts ni desactivar recovery. La variante impide nuevos agrupamientos en una conexión limpia, pero no sana inmediatamente un socket ya expuesto: en la implementación/rollout hay que validar renovación de esos sockets existentes o dejar que el reconnect normal los sustituya. El control inmediato sugiere que renovar el socket conserva la auth/sesión temporal y limpia el efecto. Antes de publicar, validar el orden del cifrador CTR, reconexiones y la implementación WebSocket de navegador; asignar un buffer por llamada tiene coste de memoria/GC que debe medirse. El harness prototipa el resultado usando un writer fresco por paquete y no modifica el paquete instalado.', '',
  '## 10. Go / No-Go', '',
  baseline?.stats.valid>=200&&baseline.stats.ge6>0&&fresh?.stats.valid>=500&&fresh.stats.ge6===0
    &&analysis['e2-cross-over-shared']?.stats.valid>=25&&analysis['e2-cross-over-shared'].stats.ge6>0
    &&analysis['e2-cross-over-fresh']?.stats.valid>=25&&analysis['e2-cross-over-fresh'].stats.ge6>0
    &&adjacent.filter(x=>x.same_socket&&x.same_session).length>=20
    &&analysis['e8-inverse-fresh']?.stats.ge6===0
    &&analysis['e2-reset-immediate-post-fresh']?.stats.valid===1
    &&analysis['e2-reset-immediate-post-fresh'].stats.p50>1500
    &&analysis['e2-reset-immediate-after-reconnect']?.stats.valid===10
    &&analysis['e2-reset-immediate-after-reconnect'].stats.ge15===0
    &&analysis['e11-stress-fresh']?.stats.valid>=20&&analysis['e11-stress-fresh'].stats.ge6===0
    ? '**GO** para implementar el aislamiento del buffer de escritura en la dependencia fijada y validarlo en producción. La decisión incluye tratar la transición de sockets ya expuestos: la variante evita nuevos agrupamientos, pero no sana de inmediato un socket afectado. El control de reconnect inmediato lo recuperó sin cambiar de sesión.'
    : '**NO-GO aún:** falta cumplir una muestra física o un control de orden, stress o estado residual. Revisar el detalle y las trazas antes de cambiar producción.', '',
  '## Archivos y reproducción', '',
  '`node tests/playback-e/run-suite.mjs --phase main`, luego `--phase controls`, después `--phase supplement`, y `node tests/playback-e/rebuild-report.mjs --collect`; ejecutar finalmente `node tests/playback-e/rebuild-report.mjs` verifica todos los hashes y reconstruye el reporte. Requiere Cloud/PostgreSQL y `.env.stage1` como Test D. Las trazas comprimidas y sus hashes están en `traces/manifest.json`.', ''
);
fs.writeFileSync(path.join(here,'RESULTS.md'),lines.join('\n'));
console.log(`Verified ${manifest.length} compressed traces, wrote RESULTS.md`);
