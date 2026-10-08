import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(`--${name}`); return i < 0 ? null : args[i + 1]; };
const list = name => (flag(name) || '').split(',').filter(Boolean);
const normalDirs = list('normal');
const suppressedDirs = list('suppress');
const earlyDirs = list('early');
const out = flag('out');
if (!normalDirs.length || !out) {
  console.error('Usage: node tests/playback-c/report.mjs --normal dir1,dir2,... [--suppress dir] [--early dir] --out directory');
  process.exit(2);
}
const rounded = value => value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
const metric = values => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  const p = fraction => a.length ? rounded(a[Math.ceil(a.length * fraction) - 1]) : null;
  return { n: a.length, p50: p(.5), p95: p(.95), max: a.length ? rounded(a.at(-1)) : null };
};
const id = value => value == null ? null : String(value);
const first = (events, stage) => events.find(event => event.stage === stage);
const bucket = duration => duration < 500 ? '<500 ms' : duration < 2500 ? '500–2500 ms'
  : duration < 5000 ? '2.5–5 s' : duration < 7500 ? '5–7.5 s'
  : duration < 10000 ? '7.5–10 s' : '>10 s';
const bucketOrder = ['<500 ms', '500–2500 ms', '2.5–5 s', '5–7.5 s', '7.5–10 s', '>10 s'];
function decodeStatus(status) {
  if (status == null) return null;
  const low = status & 7;
  const base = { 1: 'desconocido/olvidado', 2: 'no recibido', 3: 'no recibido (ID futuro)', 4: 'recibido' }[low] || `bajo=${low}`;
  return { raw: status, hex: `0x${status.toString(16).padStart(2, '0')}`, base,
    acknowledged: Boolean(status & 8), no_ack_needed: Boolean(status & 16),
    processing_or_complete: Boolean(status & 32), response_generated: Boolean(status & 64),
    definitely_received: Boolean(status & 128) };
}
function load(directory, variant, index) {
  const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
  const events = fs.readFileSync(path.join(directory, 'trace.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const byRun = new Map();
  for (const event of events) {
    if (!byRun.has(event.run_id)) byRun.set(event.run_id, []);
    byRun.get(event.run_id).push(event);
  }
  const rows = [];
  for (const summaryRow of summary.rows) {
    const own = (byRun.get(summaryRow.run_id) || []).sort((a, b) => a.ts_ms - b.ts_ms);
    const start = first(own, 'START');
    const created = own.filter(event => event.stage === 'C_RPC_CREATED');
    const sends = own.filter(event => event.stage === 'WORKER_GET_FILE_WEBSOCKET_SEND_CALLED' && event.message_id === 96);
    if (!created.length && !sends.length) continue; // Cache hit, not a physical target RPC.
    const msgAssignments = own.filter(event => event.stage === 'C_RPC_MSG_ID_ASSIGNED');
    const msgIds = msgAssignments.map(event => id(event.msg_id));
    const targetIdSet = new Set(msgIds);
    // mtcute can deliver a state reply after upload.getFile resolved and the
    // harness has advanced to the next run. Join those diagnostics by msg_id.
    const foreign = events.filter(event => event.run_id !== summaryRow.run_id && event.stage?.startsWith('C_')
      && (targetIdSet.has(id(event.msg_id)) || targetIdSet.has(id(event.old_msg_id))
        || event.target_msg_ids?.some(value => targetIdSet.has(id(value)))
        || event.target_statuses?.some(item => targetIdSet.has(id(item.msg_id)))));
    const e = [...own, ...foreign].sort((a, b) => a.ts_ms - b.ts_ms);
    const results = e.filter(event => event.stage === 'C_RPC_RESULT' && targetIdSet.has(id(event.msg_id)));
    const result = results.at(-1) || null;
    const ingress = e.find(event => event.stage === 'WORKER_GET_FILE_RPC_RESULT_ENTER' && event.message_id === 96);
    const socketSend = sends[0] || null;
    const runError = first(own, 'RUN_ERROR');
    const ingressTs = Number(ingress?.websocket_first_message_ts_ms) || ingress?.ts_ms || result?.ts_ms || null;
    const duration = socketSend && ingressTs ? rounded(ingressTs - socketSend.ts_ms) : null;
    const linked = event => {
      const ids = event.target_msg_ids || event.target_statuses?.map(item => item.msg_id) || [];
      return ids.some(value => targetIdSet.has(id(value)));
    };
    const stateSends = e.filter(event => event.stage === 'C_STATE_REQ_WEBSOCKET_SEND' && linked(event));
    const otherStateSends = e.filter(event => event.stage === 'C_STATE_REQ_WEBSOCKET_SEND' && !linked(event)
      && (!result || event.ts_ms <= result.ts_ms));
    const stateConnectionSends = e.filter(event => event.stage === 'C_STATE_REQ_CONNECTION_SEND' && linked(event));
    const infos = e.filter(event => event.stage === 'C_STATE_INFO_RECEIVED' && linked(event));
    const timeouts = e.filter(event => event.stage === 'C_STATE_REQ_TIMEOUT' && linked(event));
    const ack = e.filter(event => event.stage === 'C_SERVER_ACK' && linked(event));
    const failures = e.filter(event => event.stage === 'C_MESSAGE_FAILED' && targetIdSet.has(id(event.msg_id)));
    const requeues = e.filter(event => event.stage === 'C_RPC_REQUEUED' && targetIdSet.has(id(event.old_msg_id)));
    const detailed = e.filter(event => event.stage === 'C_DETAILED_INFO' && (!event.msg_id || targetIdSet.has(id(event.msg_id))));
    const resends = e.filter(event => event.stage === 'C_SERVER_RESEND_REQ' && linked(event));
    const perState = stateSends.map(request => {
      const info = infos.find(item => id(item.state_msg_id) === id(request.state_msg_id));
      const timeout = timeouts.find(item => id(item.state_msg_id) === id(request.state_msg_id));
      const exact = info?.target_statuses?.find(item => targetIdSet.has(id(item.msg_id)));
      return { state_msg_id: id(request.state_msg_id), send_ms: rounded(request.ts_ms - start.ts_ms),
        send_before_result: !result || request.ts_ms <= result.ts_ms,
        queried_msg_ids: request.queried_msg_ids, target_msg_ids: request.target_msg_ids,
        info_ms: info ? rounded(info.ts_ms - start.ts_ms) : null, status: decodeStatus(exact?.status),
        info_before_result: Boolean(info && (!result || info.ts_ms <= result.ts_ms)),
        timeout_ms: timeout ? rounded(timeout.ts_ms - start.ts_ms) : null,
        timeout_before_result: Boolean(timeout && (!result || timeout.ts_ms <= result.ts_ms)) };
    });
    const timeline = e.filter(event => event.stage.startsWith('C_') ||
      (event.message_id === 96 && ['WORKER_GET_FILE_WEBSOCKET_SEND_CALLED', 'WORKER_GET_FILE_RPC_RESULT_ENTER'].includes(event.stage)))
      .filter(event => event.stage !== 'C_SOCKET_PROBE_ATTACHED' && event.stage !== 'C_TARGET_DOCUMENT_IDENTIFIED')
      .map(event => ({ t_ms: rounded(event.ts_ms - start.ts_ms), stage: event.stage,
        msg_id: id(event.msg_id), state_msg_id: id(event.state_msg_id),
        target_msg_ids: event.target_msg_ids || null, target_statuses: event.target_statuses || null,
        reason: event.reason || null, message_id: event.message_id || null }));
    rows.push({ sample_id: `${variant}-${index}-${summaryRow.run_id}`, variant, status: summaryRow.status,
      duration_ms: duration, bucket: duration == null ? 'incomplete' : bucket(duration),
      error_name: summaryRow.error_name ?? null,
      censored_after_send_ms: socketSend && runError && duration == null ? rounded(runError.ts_ms - socketSend.ts_ms) : null,
      start_to_send_ms: socketSend ? rounded(socketSend.ts_ms - start.ts_ms) : null,
      creation_ms: created[0] ? rounded(created[0].ts_ms - start.ts_ms) : null,
      message_ids: msgIds, connection_uid: socketSend?.connection_uid ?? null,
      ack_before_result: Boolean(ack.find(event => !result || event.ts_ms <= result.ts_ms)),
      ack_ms: ack.map(event => rounded(event.ts_ms - start.ts_ms)),
      state_connection_sends: stateConnectionSends.length, state_requests: perState,
      other_state_sends_before_result_ms: otherStateSends.map(event => rounded(event.ts_ms - start.ts_ms)),
      state_requests_before_result: perState.filter(item => item.send_before_result).length,
      state_infos_before_result: perState.filter(item => item.info_before_result).length,
      state_timeouts_before_result: perState.filter(item => item.timeout_before_result).length,
      state_infos: infos.map(info => ({ t_ms: rounded(info.ts_ms - start.ts_ms), state_msg_id: id(info.state_msg_id),
        target_statuses: info.target_statuses.map(item => ({ msg_id: item.msg_id, ...decodeStatus(item.status) })) })),
      state_timeouts: timeouts.map(event => rounded(event.ts_ms - start.ts_ms)),
      failures: failures.map(event => ({ t_ms: rounded(event.ts_ms - start.ts_ms), reason: event.reason })),
      requeues: requeues.length, detailed_info: detailed.length, server_resend_requests: resends.length,
      rpc_result_ms: result ? rounded(result.ts_ms - start.ts_ms) : null,
      ingress_ms: ingressTs ? rounded(ingressTs - start.ts_ms) : null,
      socket_send_count: sends.length, timeline });
  }
  return { directory, variant, requested_runs: summary.rows.length, physical: rows.length,
    production_sha256: summary.production_sha256,
    c_probe_sha256: summary.harness_sha256?.['tests/playback-c/instrument.mjs'] ?? null,
    rows };
}
const datasets = [
  ...normalDirs.map((directory, index) => load(directory, 'normal', index + 1)),
  ...suppressedDirs.map((directory, index) => load(directory, 'suppress', index + 1)),
  ...earlyDirs.map((directory, index) => load(directory, 'early', index + 1)),
];
const rows = datasets.flatMap(dataset => dataset.rows);
const normal = rows.filter(row => row.variant === 'normal' && row.duration_ms != null && row.rpc_result_ms != null);
const byBucket = Object.fromEntries(bucketOrder.map(name => {
  const group = normal.filter(row => row.bucket === name);
  return [name, { count: group.length, duration: metric(group.map(row => row.duration_ms)),
    ack_before_result: group.filter(row => row.ack_before_result).length,
    with_state_req: group.filter(row => row.state_requests.length > 0).length,
    state_req_count: group.reduce((sum, row) => sum + row.state_requests.length, 0),
    first_state_req_ms: metric(group.map(row => row.state_requests[0]?.send_ms)),
    second_state_req_ms: metric(group.map(row => row.state_requests[1]?.send_ms)),
    with_state_info: group.filter(row => row.state_infos_before_result > 0).length,
    with_state_timeout: group.filter(row => row.state_timeouts_before_result > 0).length,
    timeout_count_before_result: group.reduce((sum, row) => sum + row.state_timeouts_before_result, 0),
    with_resend: group.filter(row => row.requeues > 0 || row.socket_send_count > 1).length,
    with_new_msg_id: group.filter(row => new Set(row.message_ids).size > 1).length,
    rpc_result_ms: metric(group.map(row => row.rpc_result_ms)),
    status_raw: [...new Set(group.flatMap(row => row.state_infos.flatMap(info => info.target_statuses.map(item => item.raw))))],
  }];
}));
const summary = { target: { account: '03', message_id: 96, filename: 'Stage1 Playback v2 03.mp3' },
  datasets: datasets.map(({ rows: _rows, ...dataset }) => dataset), normal_physical: normal.length,
  normal_duration: metric(normal.map(row => row.duration_ms)), buckets: byBucket,
  variants: Object.fromEntries(['normal', 'suppress', 'early'].map(variant => {
    const attempted = rows.filter(row => row.variant === variant);
    // The harness may fail later while waiting for the competing WARM; keep a
    // target RPC if its correlated response frame was already observed.
    const r = attempted.filter(row => row.duration_ms != null && row.rpc_result_ms != null);
    return [variant, { attempted_physical: attempted.length, physical: r.length,
      censored: attempted.filter(row => row.censored_after_send_ms != null).length,
      censor_observation_ms: metric(attempted.map(row => row.censored_after_send_ms)),
      duration: metric(r.map(row => row.duration_ms)),
      state_request_runs: r.filter(row => row.state_requests.length).length,
      state_info_before_result_runs: r.filter(row => row.state_infos_before_result > 0).length,
      requeued_runs: r.filter(row => row.requeues > 0).length,
      state_not_received_runs: r.filter(row => row.state_infos.some(info => info.target_statuses.some(item => (item.raw & 7) === 2))).length,
      tails_ge_6000: r.filter(row => row.duration_ms >= 6000).length,
      response_without_state: r.filter(row => row.state_requests.length === 0 && row.rpc_result_ms != null).length }];
  })) };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'physical-rpcs.json'), JSON.stringify(rows, null, 2) + '\n');
const v = x => x == null ? '—' : String(x);
const observedStatuses = [...new Set(normal.flatMap(row => row.state_infos.flatMap(info => info.target_statuses.map(item => item.raw))))].sort((a, b) => a - b);
const lines = ['# Test C · mtcute state recovery para upload.getFile', '',
  `RPC físicos normales válidos del mensaje 96: ${normal.length}. Duración WebSocket send→primer frame correlacionado p50 ${v(summary.normal_duration.p50)} ms, p95 ${v(summary.normal_duration.p95)} ms, máximo ${v(summary.normal_duration.max)} ms.`, '',
  '| Duración | RPC | ACK antes de result | Con state_req | # state_req | Info antes de result | Timeout antes de result | Con resend | Nuevo msg_id | Estados brutos |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
  ...bucketOrder.map(name => { const b = byBucket[name]; return `| ${name} | ${b.count} | ${b.ack_before_result} | ${b.with_state_req} | ${b.state_req_count} | ${b.with_state_info} | ${b.with_state_timeout} | ${b.with_resend} | ${b.with_new_msg_id} | ${b.status_raw.join(', ') || '—'} |`; }),
  '', 'Tiempos p50 relativos a `START` de cada grupo; el conteo de timeouts excluye los posteriores a `rpc_result`:', '',
  '| Duración | state_req #1 | state_req #2 | # timeouts previos | rpc_result |',
  '|---|---:|---:|---:|---:|',
  ...bucketOrder.map(name => { const b = byBucket[name]; return `| ${name} | ${v(b.first_state_req_ms.p50)} | ${v(b.second_state_req_ms.p50)} | ${b.timeout_count_before_result} | ${v(b.rpc_result_ms.p50)} |`; }),
  '', '## Estados MTProto', '',
  ...observedStatuses.map(raw => { const d = decodeStatus(raw); return `- ${raw} (${d.hex}): ${d.base}; flag +8 reconocido=${d.acknowledged}, +32 procesando/completo=${d.processing_or_complete}, +64 respuesta generada=${d.response_generated}, +128 certeza adicional=${d.definitely_received}.`; }),
  ...(observedStatuses.length ? [] : ['- No llegó ningún `msgs_state_info` correlacionado.']),
  '', 'La semántica del byte sigue la [especificación oficial MTProto](https://core.telegram.org/mtproto/service_messages_about_messages). Un estado recibido después de `rpc_result` describe lo que el servidor sabe en ese momento posterior; no prueba cuándo recibió el RPC ni cuándo generó la respuesta.',
  '', 'La columna ACK cuenta solo `mt_msgs_ack` del servidor antes de `rpc_result`; `_onMessageAcked` también se invoca al procesar una respuesta y no se confunde con un ACK previo. Las marcas de `state_req` son envíos reales de WebSocket correlacionados al `msg_id` del RPC 96. Los timeouts o `state_info` posteriores a `rpc_result` se conservan en los timelines, sin atribuirles causalidad retrospectiva.', '',
  '## RPC físicos por run', '',
  '| Run | Harness | getFile ms | ACK | state_req #1 | estado #1 | timeout #1 | state_req #2 | estado #2 | resend | rpc_result | msg_ids |',
  '|---|---|---:|---|---:|---|---:|---:|---|---|---:|---|',
  ...rows.map(row => { const [s1, s2] = row.state_requests; return `| ${row.sample_id} | ${row.error_name || row.status} | ${row.duration_ms == null && row.censored_after_send_ms != null ? `>${row.censored_after_send_ms} (censurado)` : v(row.duration_ms)} | ${row.ack_before_result ? row.ack_ms[0] : 'no'} | ${v(s1?.send_ms)} | ${s1?.status ? `${s1.status.raw} (${s1.status.hex}) @${v(s1.info_ms)}` : '—'} | ${v(s1?.timeout_ms)} | ${v(s2?.send_ms)} | ${s2?.status ? `${s2.status.raw} (${s2.status.hex}) @${v(s2.info_ms)}` : '—'} | ${row.requeues || row.socket_send_count > 1 ? `sí (${row.requeues})` : 'no'} | ${v(row.rpc_result_ms)} | ${row.message_ids.join(', ')} |`; }),
  '', '## Timelines representativos', '',
];
for (const name of bucketOrder) {
  const group = normal.filter(row => row.bucket === name);
  if (!group.length) continue;
  const representative = group[Math.floor(group.length / 2)];
  lines.push(`### ${name}: ${representative.sample_id} (${representative.duration_ms} ms)`, '');
  for (const event of representative.timeline) lines.push(`- ${event.t_ms >= 0 ? '+' : ''}${event.t_ms} ms · ${event.stage}${event.msg_id ? ` · msg_id ${event.msg_id}` : ''}${event.state_msg_id ? ` · state_msg_id ${event.state_msg_id}` : ''}${event.target_statuses ? ` · estado ${event.target_statuses.map(item => item.status).join(',')}` : ''}${event.reason ? ` · ${event.reason}` : ''}`);
  lines.push('');
}
lines.push('## Variantes', '',
  '| Variante | RPC físicos | Respuesta | Censurados | p50 | p95 | max | tails ≥6 s | con state_req | info previa | estado 2 | requeue | resultado sin state_req |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...Object.entries(summary.variants).map(([name, item]) => `| ${name} | ${item.attempted_physical} | ${item.physical} | ${item.censored} | ${v(item.duration.p50)} | ${v(item.duration.p95)} | ${v(item.duration.max)} | ${item.tails_ge_6000} | ${item.state_request_runs} | ${item.state_info_before_result_runs} | ${item.state_not_received_runs} | ${item.requeued_runs} | ${item.response_without_state} |`), '');
fs.writeFileSync(path.join(out, 'RESULTS.md'), lines.join('\n'));
console.log(JSON.stringify({ normal_physical: normal.length, buckets: Object.fromEntries(bucketOrder.map(name => [name, byBucket[name].count])), variants: summary.variants }, null, 2));
