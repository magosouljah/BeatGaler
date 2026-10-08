import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
const series = (flag('series') || '').split(',').filter(Boolean).map(item => {
  const at = item.indexOf('=');
  if (at < 1) throw new Error(`Invalid series: ${item}`);
  return { name: item.slice(0, at), dir: path.resolve(item.slice(at + 1)) };
});
const out = path.resolve(flag('out') || 'tests/playback-d');
if (!series.length) throw new Error('Usage: node tests/playback-d/report.mjs --series d1=dir,d2-warm=dir,d2-raw=dir,... --out tests/playback-d');
const r = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
const pct = (values, p) => { const a = values.filter(Number.isFinite).sort((a, b) => a - b); return a.length ? r(a[Math.ceil(p * a.length) - 1]) : null; };
const stat = values => ({ n: values.filter(Number.isFinite).length, p50: pct(values, .5), p95: pct(values, .95),
  max: pct(values, 1), ge3: values.filter(v => v >= 3000).length,
  ge6: values.filter(v => v >= 6000).length, ge9: values.filter(v => v >= 9000).length });
const byStage = (events, stage, messageId) => events.filter(e => e.stage === stage && (messageId == null || e.message_id === messageId));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const all = [], sources = [];
for (const { name, dir } of series) {
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(dir, 'trace.jsonl'));
  const events = raw.toString().trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const byRun = new Map();
  for (const event of events) {
    if (!byRun.has(event.run_id)) byRun.set(event.run_id, []);
    byRun.get(event.run_id).push(event);
  }
  const runs = [];
  for (const row of summary.rows) {
    const ev = (byRun.get(row.run_id) || []).sort((a, b) => a.ts_ms - b.ts_ms);
    const start = ev.find(e => e.stage === 'START');
    if (!start) continue;
    const rpc = messageId => {
      const sends = byStage(ev, 'D_RPC_WEBSOCKET_SEND', messageId);
      const resultEvents = byStage(ev, 'D_RPC_RESULT', messageId);
      return sends.map(send => {
        const result = resultEvents.find(e => e.msg_id === send.msg_id && e.ts_ms >= send.ts_ms);
        const linked = ev.filter(e => e.msg_id === send.msg_id || e.target_msg_ids?.includes(send.msg_id));
        const state = linked.filter(e => e.stage === 'D_STATE_REQ_WEBSOCKET_SEND');
        const info = linked.filter(e => e.stage === 'D_STATE_INFO_RECEIVED');
        const ack = linked.filter(e => e.stage === 'D_SERVER_ACK');
        const requeue = linked.filter(e => e.stage === 'D_RPC_REQUEUED');
        return { message_id: messageId, msg_id: send.msg_id,
          connection_uid: send.connection_uid, connection_probe_id: send.connection_probe_id,
          socket_id: send.socket_id, pool_kind: send.pool_kind, dc_id: send.dc_id,
          session_tag: send.session_tag, packet_id: send.packet_id, ws_send_id: send.ws_send_id ?? null,
          container_id: send.container_id, coalesced_packets: send.coalesced_packets ?? 1,
          send_ms: r(send.ts_ms - start.ts_ms), result_ms: result ? r(result.ts_ms - start.ts_ms) : null,
          duration_ms: result ? r(result.ts_ms - send.ts_ms) : null,
          state_requests: state.length, state_info: info.map(e => ({ t_ms: r(e.ts_ms - start.ts_ms), status: e.status })),
          ack_ms: ack.map(e => r(e.ts_ms - start.ts_ms)), requeues: requeue.length,
          timeline: linked.filter(e => /^(D_RPC_|D_STATE_|D_SERVER_ACK|D_MESSAGE_INFO_APPLIED)/.test(e.stage))
            .map(e => ({ t_ms: r(e.ts_ms - start.ts_ms), stage: e.stage,
              msg_id: e.msg_id ?? null, state_msg_id: e.state_msg_id ?? null, packet_id: e.packet_id ?? null,
              status: e.status ?? null })) };
      });
    };
    const a = rpc(96), b = rpc(101);
    const first96 = a.find(x => x.duration_ms != null) || a[0] || null;
    const first101 = b.find(x => x.duration_ms != null) || b[0] || null;
    const overlap = !!(first96 && first101 && first96.result_ms != null && first101.result_ms != null
      && first96.send_ms < first101.result_ms && first101.send_ms < first96.result_ms);
    runs.push({ run_id: row.run_id, status: row.status, start_ts_ms: start.ts_ms,
      rpc96: a, rpc101: b, first96, first101, overlap,
      same_connection: first96 && first101 ? first96.connection_uid === first101.connection_uid : null,
      same_socket: first96 && first101 ? first96.socket_id === first101.socket_id : null,
      same_packet: first96 && first101 ? first96.packet_id === first101.packet_id : null,
      same_container: first96 && first101 && first96.container_id && first101.container_id
        ? first96.container_id === first101.container_id : false,
      coalesced_ws_send: first96 && first101 && first96.socket_id === first101.socket_id
        && first96.ws_send_id != null && first96.ws_send_id === first101.ws_send_id
        && first96.packet_id !== first101.packet_id });
  }
  all.push({ name, summary: { status: summary.status, mode: summary.mode, requested_runs: summary.requested_runs,
    test_d_route_101: summary.test_d_route_101, test_d_order: summary.test_d_order,
    test_d_offset_ms: summary.test_d_offset_ms, test_d_first: summary.test_d_first,
    test_d_sequential: summary.test_d_sequential,
    test_d_include_101: summary.test_d_include_101 }, runs });
  sources.push({ name, dir, trace_sha256: sha(raw), trace_bytes: raw.length,
    summary_sha256: sha(fs.readFileSync(path.join(dir, 'summary.json'))) });
}
fs.mkdirSync(out, { recursive: true });
const traceDir = path.join(out, 'traces');
fs.mkdirSync(traceDir, { recursive: true });
const manifest = [];
for (const source of sources) {
  const raw = fs.readFileSync(path.join(source.dir, 'trace.jsonl'));
  const compressed = zlib.gzipSync(raw, { level: 9 });
  const filename = `${source.name}.jsonl.gz`;
  fs.writeFileSync(path.join(traceDir, filename), compressed);
  manifest.push({ series: source.name, file: filename, raw_sha256: source.trace_sha256,
    raw_bytes: source.trace_bytes, gzip_sha256: sha(compressed), gzip_bytes: compressed.length,
    summary_sha256: source.summary_sha256 });
}
fs.writeFileSync(path.join(traceDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(all, null, 2));
const lines = ['# Test D · conexión MTProto y WARM', '', 'Resultados generados desde las trazas crudas archivadas en `traces/`.', '',
  '## Metodología', '',
  'Cuenta 03, mensaje 96 (`Stage1 Playback v2 03.mp3`, 17 136 bytes) y competidor 101 (archivo de 64 MiB). Sesión/peer y, en raw, descriptores de ambos mensajes se prepararon fuera de `START`. Cada intento raw pidió 64 KiB desde offset 0 mediante `TelegramClient.downloadChunk` real; D1 hizo solo el RPC 96 durante el run. WARM usó el batch de producción `[96,101]`, foco 96 y 10 ms de anticipación. D3 cambió únicamente el RPC 101 a `kind:"download"` dentro del worker experimental; el 96 siguió en `main`. Las series se ejecutaron secuencialmente.', '',
  'Un RPC físico exige `D_RPC_WEBSOCKET_SEND` y `D_RPC_RESULT` con el mismo `msg_id`. Un par válido requiere ambos RPC completos y run `OK`; “solapado” significa que ambos se enviaron antes de la primera de sus respuestas. Los percentiles son nearest-rank. Los hits de rango WARM y los runs fallidos no se convierten en RPC de 0 ms. `session_tag` es un hash truncado, suficiente para comparar sesiones sin guardar su valor crudo. `packet_id` identifica un flush/paquete MTProto; `ws_send_id` una escritura WebSocket física.', '',
  '## Comparación principal (RPC físico 96 completo, runs `OK`)', '',
  '| Caso | Runs lógicos | RPC físicos 96 | p50 / p95 / max (ms) | ≥3 / ≥6 / ≥9 s | State recovery | Pares físicos válidos | Solapados | Escritura WebSocket conjunta |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
for (const [label, names] of [
  ['D1 · 96 solo', ['d1']],
  ['D2 · WARM mismo socket', ['d2-warm', 'd2-warm-repeat']],
  ['D3 · WARM sockets separados', ['d3-warm', 'd3-warm-repeat']],
  ['D2 · raw simultáneo mismo socket', ['d2-raw-a', 'd2-raw-b']],
  ['D3 · raw simultáneo sockets separados', ['d3-raw']],
]) {
  const groups = all.filter(g => names.includes(g.name));
  if (!groups.length) continue;
  const x = groups.flatMap(g => g.runs).filter(z => z.status === 'OK');
  const v = x.map(z => z.first96?.duration_ms).filter(Number.isFinite);
  const s = stat(v);
  const pairs = x.filter(z => z.first96?.duration_ms != null && z.first101?.duration_ms != null);
  lines.push(`| ${label} | ${groups.reduce((sum,g) => sum + g.runs.length, 0)} | ${s.n} | ${s.p50 ?? '—'} / ${s.p95 ?? '—'} / ${s.max ?? '—'} | ${s.ge3} / ${s.ge6} / ${s.ge9} | ${x.filter(z => z.first96?.state_requests > 0).length} | ${pairs.length} | ${pairs.filter(z => z.overlap).length} | ${pairs.filter(z => z.coalesced_ws_send).length} |`);
}
lines.push('', '## RPC físico 101 completo', '',
  '| Caso | RPC físicos 101 | p50 / p95 / max (ms) | ≥3 / ≥6 / ≥9 s | State recovery |',
  '|---|---:|---:|---:|---:|');
for (const [label, names] of [
  ['D2 · WARM mismo socket', ['d2-warm', 'd2-warm-repeat']],
  ['D3 · WARM sockets separados', ['d3-warm', 'd3-warm-repeat']],
  ['D2 · raw mismo socket', ['d2-raw-a', 'd2-raw-b']],
  ['D3 · raw sockets separados', ['d3-raw']],
]) {
  const x = all.filter(g => names.includes(g.name)).flatMap(g => g.runs).filter(z => z.status === 'OK');
  if (!x.length) continue;
  const rpc = x.flatMap(z => z.rpc101).filter(z => z.duration_ms != null);
  const s = stat(rpc.map(z => z.duration_ms));
  lines.push(`| ${label} | ${s.n} | ${s.p50} / ${s.p95} / ${s.max} | ${s.ge3} / ${s.ge6} / ${s.ge9} | ${rpc.filter(z => z.state_requests > 0).length} |`);
}
lines.push('', '## Series individuales', '',
  '| Serie | Runs | RPC físicos completos 96 | 96 p50 / p95 / max (ms) | 96 ≥3 / ≥6 / ≥9 s | Recovery 96 | RPC físicos completos 101 | 101 p50 / p95 / max (ms) | 101 ≥3 / ≥6 / ≥9 s | Recovery 101 | Pares físicos | Solapados | Mismo socket | Diferente socket |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const group of all) {
  const x = group.runs;
  const valid = x.filter(z => z.status === 'OK');
  const s96 = stat(valid.flatMap(z => z.rpc96.map(y => y.duration_ms)));
  const s101 = stat(valid.flatMap(z => z.rpc101.map(y => y.duration_ms)));
  const pair = valid.filter(z => z.first96 && z.first101 && z.first96.duration_ms != null && z.first101.duration_ms != null);
  const triple = s => `${s.p50 ?? '—'} / ${s.p95 ?? '—'} / ${s.max ?? '—'}`;
  const tails = s => `${s.ge3} / ${s.ge6} / ${s.ge9}`;
  const recovery96 = valid.flatMap(z => z.rpc96).filter(z => z.duration_ms != null && z.state_requests > 0).length;
  const recovery101 = valid.flatMap(z => z.rpc101).filter(z => z.duration_ms != null && z.state_requests > 0).length;
  lines.push(`| ${group.name} | ${x.length} | ${s96.n} | ${triple(s96)} | ${tails(s96)} | ${recovery96} | ${s101.n} | ${triple(s101)} | ${tails(s101)} | ${recovery101} | ${pair.length} | ${pair.filter(z => z.overlap).length} | ${pair.filter(z => z.same_socket).length} | ${pair.filter(z => z.same_socket === false).length} |`);
}
lines.push('', 'Solo los runs con estado `OK` entran en percentiles, tails y pares válidos. Los runs fallidos se conservan en `analysis.json` y en las trazas.', '',
  '| Serie | Runs fallidos |', '|---|---:|');
for (const group of all) lines.push(`| ${group.name} | ${group.runs.filter(z => z.status !== 'OK').length} |`);
lines.push('', '## Topología física de cada serie', '',
  '| Serie | Dos RPC en mismo `WebSocket.send` | Mismo paquete MTProto | Mismo container | Mismo DC | Misma sesión MTProto |',
  '|---|---:|---:|---:|---:|---:|');
for (const group of all) {
  const pairs = group.runs.filter(z => z.status === 'OK' && z.first96 && z.first101);
  lines.push(`| ${group.name} | ${pairs.filter(z => z.coalesced_ws_send).length} | ${pairs.filter(z => z.same_packet).length} | ${pairs.filter(z => z.same_container).length} | ${pairs.filter(z => z.first96.dc_id === z.first101.dc_id).length} | ${pairs.filter(z => z.first96.session_tag === z.first101.session_tag).length} |`);
}
lines.push('', '## Identidades de conexión representativas', '',
  '| Serie/run | 96: pool, conexión, socket, DC, sesión | 101: pool, conexión, socket, DC, sesión |',
  '|---|---|---|');
for (const name of ['d2-warm', 'd3-warm', 'd2-raw-a', 'd3-raw']) {
  const group = all.find(g => g.name === name);
  const sample = group?.runs.find(z => z.status === 'OK' && z.first96?.duration_ms != null && z.first101?.duration_ms != null);
  if (!sample) continue;
  const fmt = z => `${z.pool_kind}/${z.connection_uid}/${z.socket_id}/DC${z.dc_id}/${z.session_tag}`;
  lines.push(`| ${name}/${sample.run_id} | ${fmt(sample.first96)} | ${fmt(sample.first101)} |`);
}
lines.push('', '## Orden y offset (D4)', '',
  '| Serie | Primer mensaje | Offset pedido (ms) | Envío físico 96 antes de 101 | 96 ≥6 s | 101 ≥6 s |',
  '|---|---:|---:|---:|---:|---:|');
for (const group of all.filter(g => g.name.startsWith('d4-'))) {
  const pairs = group.runs.filter(z => z.status === 'OK' && z.first96 && z.first101);
  const first = group.summary.test_d_first ?? (group.summary.test_d_order === '101' ? 101 : 96);
  lines.push(`| ${group.name} | ${first} | ${group.summary.test_d_offset_ms} | ${pairs.filter(z => z.first96.send_ms < z.first101.send_ms).length}/${pairs.length} | ${pairs.filter(z => z.first96?.duration_ms >= 6000).length} | ${pairs.filter(z => z.first101?.duration_ms >= 6000).length} |`);
}
const combined = names => all.filter(g => names.includes(g.name)).flatMap(g => g.runs).filter(z => z.status === 'OK');
const sameRaw = combined(['d2-raw-a', 'd2-raw-b']);
const splitRaw = combined(['d3-raw']);
const sameWarm = combined(['d2-warm', 'd2-warm-repeat']);
const splitWarm = combined(['d3-warm', 'd3-warm-repeat']);
const gated = all.filter(g => g.name.startsWith('d4-') && !g.name.includes('coalesced') && !g.name.includes('sequential'))
  .flatMap(g => g.runs).filter(z => z.status === 'OK');
const first101Ungated = combined(['d4-101-first-coalesced']);
const complete96 = rows => rows.filter(z => z.first96?.duration_ms != null);
const tail96 = rows => complete96(rows).filter(z => z.first96.duration_ms >= 6000).length;
const coalesced = rows => rows.filter(z => z.coalesced_ws_send).length;
lines.push('', '## Interpretación causal', '');
if (sameRaw.length && splitRaw.length) {
  lines.push(`En llamadas raw equivalentes, ${tail96(sameRaw)}/${complete96(sameRaw).length} RPC del 96 alcanzaron 6 s con 96 y 101 en el mismo socket; al enrutar solo 101 a otro socket fueron ${tail96(splitRaw)}/${complete96(splitRaw).length}. Ambos grupos solaparon físicamente los dos RPC. Las trazas verifican pool, conexión, socket, DC y sesión MTProto por intento.`, '');
}
if (sameWarm.length && splitWarm.length) {
  lines.push(`Con el batch WARM y foco de producción, los RPC físicos completos del 96 tuvieron ${tail96(sameWarm)}/${complete96(sameWarm).length} tails ≥6 s en el mismo socket y ${tail96(splitWarm)}/${complete96(splitWarm).length} con sockets distintos. Los demás runs WARM reutilizaron rango; no se computan como RPC de duración cero.`, '');
}
if (sameRaw.length && gated.length) {
  lines.push(`La conexión compartida por sí sola no basta: ${coalesced(sameRaw)}/${sameRaw.length} pares raw simultáneos quedaron en una sola escritura WebSocket, frente a ${coalesced(gated)}/${gated.length} pares con barrera/offset en el mismo socket. En estos últimos, los RPC siguieron solapados casi siempre y hubo ${tail96(gated)} tails del 96 ≥6 s.`, '');
}
if (first101Ungated.length) {
  lines.push(`Invirtiendo el orden sin barrera, ${coalesced(first101Ungated)}/${first101Ungated.length} pares volvieron a compartir una escritura WebSocket y ${tail96(first101Ungated)}/${complete96(first101Ungated).length} RPC del 96 tuvieron tail ≥6 s. El orden 96/101 no explica por sí solo el fenómeno.`, '');
}
lines.push('Los dos `upload.getFile` reciben `msg_id` y paquetes MTProto distintos; no comparten flush ni `msg_container`. En las variantes lentas, el `FramedWriter` de `@fuman/io` puede codificar ambos sobre su buffer compartido antes de una sola escritura. La coincidencia entre esa escritura conjunta y el tail es el mecanismo cliente más concreto que muestran estos datos. El experimento no separa tiempo de red, procesamiento Telegram y transporte remoto; tampoco prueba si la demora nace en el writer, en el framing recibido o en la respuesta del servidor.', '',
  'En BeatGaler, `downloadChunk` de mtcute usa el pool `main` por defecto: la etiqueta de lane «download» del scheduler no selecciona automáticamente el pool MTProto `download`. D3 fuerza **solo en el harness** `kind:"download"` para 101 y prepara ese pool antes de `START`; esto cambia también la sesión MTProto, además del socket. D4 elimina esa confusión al mantener ambos RPC en el mismo socket y variar si comparten escritura.', '',
  'Arquitectura candidata, aún sin implementar: impedir que dos descargas compartan una escritura concurrente de la misma conexión, mediante serialización del writer por conexión o asignando Play y WARM a conexiones independientes con prioridad acotada. Primero habría que verificar el framing y el comportamiento del writer en una prueba aislada; aumentar timeouts no ataca el mecanismo observado.', '',
  'Las marcas send→`rpc_result` son del cliente. Los escalones de ~2.5 s incluyen `msgs_state_req`/recovery de mtcute, pero la ausencia de respuesta anterior al primer state request no atribuye el origen de la espera exclusivamente a Telegram. Un run raw fallido por `AUTH_KEY_UNREGISTERED` tras reconexiones quedó fuera de los percentiles y se conservó completo en la traza.', '',
  'Código inspeccionado: `src/features/cloud/webTransport.worker.ts` (batch, foco, descarga); `node_modules/@mtcute/core/network/session-connection.js` (`_doFlush`, corte especial de `upload.getFile`); `node_modules/@mtcute/core/network/multi-session-connection.js` (selección por carga); `node_modules/@fuman/io/codec/writer.js` (`FramedWriter.write`); `tests/playback-d/instrument.mjs` (probes solo de test).', '');
lines.push('', '## Tails del RPC 96 ≥6 s', '', '| Serie/run | Duración (ms) | 96 send→result | 101 send→result | Conexión/socket 96 vs 101 | State req / info / requeue 96 |',
  '|---|---:|---|---|---|---|');
let tailCount = 0;
for (const group of all) for (const run of group.runs.filter(z => z.status === 'OK')) for (const rpc of run.rpc96) {
  if (!(rpc.duration_ms >= 6000)) continue;
  tailCount++;
  const other = run.first101;
  lines.push(`| ${group.name}/${run.run_id} | ${rpc.duration_ms} | ${rpc.send_ms}→${rpc.result_ms} | ${other ? `${other.send_ms}→${other.result_ms ?? '?'}` : '—'} | ${rpc.connection_uid}/${rpc.socket_id} vs ${other ? `${other.connection_uid}/${other.socket_id}` : '—'} | ${rpc.state_requests}/${rpc.state_info.length}/${rpc.requeues} |`);
}
if (!tailCount) lines.push('| Ninguno | — | — | — | — | — |');
lines.push('', '## Timelines representativos de tails 96 (hasta 3 más lentos por serie)', '');
for (const group of all) for (const run of [...group.runs].filter(z => z.status === 'OK').sort((a,b) => (b.first96?.duration_ms ?? 0) - (a.first96?.duration_ms ?? 0)).slice(0,3)) for (const rpc of run.rpc96) {
  if (!(rpc.duration_ms >= 6000)) continue;
  lines.push(`### ${group.name}/${run.run_id} · ${rpc.duration_ms} ms`, '',
    `96: ${rpc.pool_kind}, conexión ${rpc.connection_uid}, socket ${rpc.socket_id}, msg_id ${rpc.msg_id}; ` +
    (run.first101 ? `101: ${run.first101.pool_kind}, conexión ${run.first101.connection_uid}, socket ${run.first101.socket_id}, msg_id ${run.first101.msg_id}.` : '101 ausente.'), '',
    '```text');
  const timeline = [...rpc.timeline.map(e => ({ ...e, who: 96 })),
    ...(run.first101?.timeline || []).map(e => ({ ...e, who: 101 }))].sort((a, b) => a.t_ms - b.t_ms);
  for (const e of timeline) lines.push(`${String(e.t_ms).padStart(7)} ms  ${e.who}  ${e.stage}` +
    (e.status == null ? '' : ` status=${e.status}`) + (e.packet_id == null ? '' : ` packet=${e.packet_id}`));
  lines.push('```', '');
}
fs.writeFileSync(path.join(out, 'RESULTS.md'), lines.join('\n') + '\n');
console.log(`Wrote ${path.join(out, 'RESULTS.md')} (${tailCount} tails)`);
