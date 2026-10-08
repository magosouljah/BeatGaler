import fs from 'node:fs';
import path from 'node:path';

// Compare the part both harnesses actually share. The optional second WARM
// file has its own getFile RPCs, so all wire timings below are for message 96.
const [aDir, bDir, outputDir] = process.argv.slice(2);
if (!aDir || !bDir || !outputDir) {
  console.error('Usage: node tests/playback-compare/report.mjs <Test A output> <Test B output> <comparison output>');
  process.exit(2);
}
const targetId = 96;
const round = number => number == null || !Number.isFinite(number) ? null : Math.round(number * 10) / 10;
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return round(ordered[Math.ceil(fraction * ordered.length) - 1]);
};
const metric = values => ({
  n: values.length,
  p50_ms: percentile(values, 0.5),
  p95_ms: percentile(values, 0.95),
  max_ms: values.length ? round(Math.max(...values)) : null,
  ge_3000: values.filter(value => value >= 3000).length,
  ge_6000: values.filter(value => value >= 6000).length,
});
const first = (events, stage, id = null) => events.find(event => event.stage === stage && (id == null || Number(event.message_id) === id));
const all = (events, stage, id = null) => events.filter(event => event.stage === stage && (id == null || Number(event.message_id) === id));
const span = (start, end) => start && end ? round(end.ts_ms - start.ts_ms) : null;
const offset = (start, event) => start && event ? round(event.ts_ms - start.ts_ms) : null;

function load(directory) {
  const summary = JSON.parse(fs.readFileSync(path.join(directory, 'summary.json'), 'utf8'));
  const events = fs.readFileSync(path.join(directory, 'trace.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const groups = new Map();
  for (const event of events) {
    if (!groups.has(event.run_id)) groups.set(event.run_id, []);
    groups.get(event.run_id).push(event);
  }
  return { directory, summary, groups };
}

function targetRpc(events) {
  const sends = all(events, 'WORKER_GET_FILE_WEBSOCKET_SEND_CALLED', targetId);
  const results = all(events, 'WORKER_GET_FILE_RPC_RESULT_ENTER', targetId);
  const pairs = [];
  const used = new Set();
  for (const response of results) {
    const sendIndex = sends.findIndex((send, index) => !used.has(index)
      && send.request_id === response.request_id && send.rpc_seq === response.rpc_seq
      && send.ts_ms <= response.ts_ms);
    if (sendIndex < 0) continue;
    used.add(sendIndex);
    const send = sends[sendIndex];
    const ingress = Number(response.websocket_first_message_ts_ms) || response.ts_ms;
    pairs.push({ send, response, ingress_ts_ms: ingress, wire_ms: round(ingress - send.ts_ms),
      rpc_return_ms: span(send, response) });
  }
  return { sends, results, pairs, longest: pairs.reduce((best, pair) => !best || pair.wire_ms > best.wire_ms ? pair : best, null) };
}

function runRow(kind, summaryRow, events) {
  const start = first(events, 'START');
  const ready = kind === 'A' ? first(events, 'FIRST_USEFUL_RANGE') : first(events, 'WARM_PREFIX_READY', targetId);
  const endpoint = kind === 'A' ? first(events, 'CONSUMER_END') : first(events, 'AUDIO_HALF_SECOND');
  const rpc = targetRpc(events);
  const getMessagesBegin = first(events, 'WORKER_MEDIA_GET_MESSAGES_BEGIN');
  const getMessagesDone = first(events, 'WORKER_MEDIA_GET_MESSAGES_DONE');
  const lane = all(events, 'WORKER_DATA_LANE_ACQUIRED', targetId);
  const available = offset(start, ready);
  const relevantStages = kind === 'A'
    ? ['WARM_BATCH_BEGIN', 'START', 'WORKER_MEDIA_GET_MESSAGES_BEGIN', 'WORKER_MEDIA_GET_MESSAGES_DONE',
      'WORKER_DATA_LANE_ACQUIRED', 'WORKER_GET_FILE_CALL_ENTER', 'WORKER_GET_FILE_WEBSOCKET_SEND_CALLED',
      'WORKER_GET_FILE_RPC_RESULT_ENTER', 'FIRST_BYTES', 'FIRST_USEFUL_RANGE', 'CONSUMER_BEGIN', 'CONSUMER_END', 'END']
    : ['WARM_BATCH_BEGIN', 'TRANSPORT_PREFETCH_BATCH_ENTER', 'START', 'PLAY_WARM_ADOPTED',
      'WORKER_MEDIA_GET_MESSAGES_BEGIN', 'WORKER_MEDIA_GET_MESSAGES_DONE', 'WORKER_DATA_LANE_ACQUIRED',
      'WORKER_GET_FILE_CALL_ENTER', 'WORKER_GET_FILE_WEBSOCKET_SEND_CALLED', 'WORKER_GET_FILE_RPC_RESULT_ENTER',
      'WARM_PREFIX_READY', 'SOURCE_PREPARE_RETURN', 'SOURCE_MSE_SOURCEOPEN', 'SOURCE_MSE_APPEND_DONE',
      'SOURCE_FIRST_PLAYABLE_RANGE', 'AUDIO_PLAY_CALL', 'AUDIO_EVENT_PLAYING', 'AUDIO_FIRST_PROGRESS', 'AUDIO_HALF_SECOND'];
  const timeline = events.filter(event => relevantStages.includes(event.stage)
    && (event.message_id == null || Number(event.message_id) === targetId)
    && (event.stage !== 'WARM_PREFIX_READY' || !event.request_id))
    .map(event => ({ t_ms: offset(start, event), stage: event.stage, message_id: event.message_id ?? null,
      request_id: event.request_id ?? null,
      bytes: event.bytes ?? null, wait_ms: event.wait_ms ?? null,
      websocket_first_message_t_ms: event.stage === 'WORKER_GET_FILE_RPC_RESULT_ENTER'
        ? round(Number(event.websocket_first_message_ts_ms) - start.ts_ms) : null }));
  return {
    test: kind, run_id: summaryRow.run_id, status: summaryRow.status,
    start_to_initial_range_ms: available == null ? null : Math.max(0, available),
    initial_range_relative_to_start_ms: available,
    start_to_endpoint_ms: span(start, endpoint),
    endpoint: kind === 'A' ? 'PCM' : 'currentTime>=0.5s',
    target_getfile_sends: rpc.sends.length, target_getfile_responses: rpc.results.length,
    target_connection_uid: rpc.longest?.send.connection_uid ?? null,
    target_socket_send_count: rpc.longest?.send.send_count ?? null,
    target_socket_buffered_before: rpc.longest?.send.buffered_amount_before ?? null,
    connection_transitions_before_target_response: events.filter(event => event.stage === 'WORKER_MTPROTO_CONNECTION_STATE'
      && (!rpc.longest || event.ts_ms <= rpc.longest.ingress_ts_ms)).map(event => event.state),
    target_wire_ms: rpc.longest?.wire_ms ?? null,
    target_rpc_return_ms: rpc.longest?.rpc_return_ms ?? null,
    target_getfile_send_t_ms: rpc.longest ? offset(start, rpc.longest.send) : null,
    target_first_response_t_ms: rpc.longest ? round(rpc.longest.ingress_ts_ms - start.ts_ms) : null,
    mse_first_range_t_ms: kind === 'B' ? offset(start, first(events, 'SOURCE_FIRST_PLAYABLE_RANGE')) : null,
    playing_t_ms: kind === 'B' ? offset(start, first(events, 'AUDIO_EVENT_PLAYING')) : null,
    get_messages_ms: span(getMessagesBegin, getMessagesDone),
    target_lane_wait_ms: round(lane.reduce((sum, event) => sum + Number(event.wait_ms || 0), 0)),
    target_range_cache_hits: events.filter(event => Number(event.message_id) === targetId && /RANGE_CACHE_HIT|ACTIVE_PLAYBACK_HIT/.test(event.stage)).length,
    target_media_cache_hits: all(events, 'WORKER_PLAYBACK_MEDIA_CACHE_HIT', targetId).length,
    target_shared_range_joins: all(events, 'WORKER_PLAYBACK_RANGE_PENDING_JOIN', targetId).length,
    target_retries: events.filter(event => Number(event.message_id) === targetId && /RETRY|RETRANSMIT/.test(event.stage)).length,
    target_rpc_errors: events.filter(event => Number(event.message_id) === targetId && /GET_FILE_RPC_REJECTED|GET_FILE_CALL_ERROR/.test(event.stage)).length,
    target_aborts: events.filter(event => Number(event.message_id) === targetId && /ABORT|PREEMPT|CANCEL/.test(event.stage)
      && event.stage !== 'PLAY_WARM_PREEMPT_ALL').length,
    target_initial_bytes: kind === 'A' ? first(events, 'FIRST_BYTES')?.bytes ?? null : first(events, 'WARM_PREFIX_READY', targetId)?.bytes ?? null,
    target_downloaded_bytes: rpc.sends.length ? Number(first(events, 'WORKER_PREFIX_DOWNLOAD_DONE', targetId)?.bytes || 0) : 0,
    warm_batch_message_ids: first(events, 'TRANSPORT_PREFETCH_BATCH_ENTER')?.message_ids
      ?? first(events, 'WARM_BATCH_BEGIN')?.message_ids ?? null,
    source_mode: kind === 'B' ? first(events, 'SOURCE_PREPARE')?.mode ?? null : null,
    warm_adopted: kind === 'A' ? true : Boolean(first(events, 'PLAY_WARM_ADOPTED')),
    timeline,
  };
}

function summarize(test) {
  const rows = test.summary.rows.map(row => runRow(test.kind, row, (test.groups.get(row.run_id) || []).sort((a, b) => a.ts_ms - b.ts_ms)));
  const valid = rows.filter(row => row.status === 'OK');
  return { kind: test.kind, directory: test.directory, requested: rows.length, valid: valid.length,
    common: metric(valid.map(row => row.start_to_initial_range_ms).filter(Number.isFinite)),
    endpoint: metric(valid.map(row => row.start_to_endpoint_ms).filter(Number.isFinite)),
    targetWire: metric(valid.map(row => row.target_wire_ms).filter(Number.isFinite)),
    runs_with_target_getfile: valid.filter(row => row.target_getfile_sends > 0).length,
    runs_with_target_media_cache_hit: valid.filter(row => row.target_media_cache_hits > 0).length,
    runs_with_target_range_cache_hit: valid.filter(row => row.target_range_cache_hits > 0).length,
    runs_with_target_shared_join: valid.filter(row => row.target_shared_range_joins > 0).length,
    runs_with_target_retry: valid.filter(row => row.target_retries > 0).length,
    runs_with_target_rpc_error: valid.filter(row => row.target_rpc_errors > 0).length,
    runs_with_target_abort: valid.filter(row => row.target_aborts > 0).length,
    runs_with_get_messages: valid.filter(row => row.get_messages_ms != null).length,
    long: valid.filter(row => row.start_to_initial_range_ms >= 6000 || row.start_to_endpoint_ms >= 6000 || row.target_wire_ms >= 6000)
      .map(row => row.run_id), rows };
}

const a = summarize({ ...load(aDir), kind: 'A' });
const b = summarize({ ...load(bDir), kind: 'B' });
const output = { target_message_id: targetId, comparison_basis: 'START to target initial useful bytes/prefix; target-only WebSocket send to correlated first response', a, b };
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'comparison.json'), JSON.stringify(output, null, 2) + '\n');
const fmt = number => number == null ? '—' : String(number);
const lines = [
  '# Test A vs Test B · cuenta 03, mensaje 96', '',
  'Condición: sesión y peer preparados; WARM del 96 y competidor 101 iniciado 10 ms antes de START; tope de prefijo de 64 KiB (este archivo entrega 17 136 bytes); mismo worker de producción. A usa Worker Thread/Node y decodificación FFmpeg; B usa Web Worker/navegador, source manager, MSE y audio.', '',
  'Los percentiles usan nearest rank. El tramo común es START→prefijo inicial útil del mensaje 96; se registra como 0 ms si el WARM lo completó antes de START. La métrica de red usa solo RPC físicos del 96 con send y respuesta correlacionados; los runs de caché sin RPC no entran en su percentil.', '',
  '| Métrica | Test A | Test B |', '|---|---:|---:|',
  `| Runs válidos | ${a.valid}/${a.requested} | ${b.valid}/${b.requested} |`,
  `| START→prefijo p50 | ${fmt(a.common.p50_ms)} ms | ${fmt(b.common.p50_ms)} ms |`,
  `| START→prefijo p95 | ${fmt(a.common.p95_ms)} ms | ${fmt(b.common.p95_ms)} ms |`,
  `| START→prefijo max | ${fmt(a.common.max_ms)} ms | ${fmt(b.common.max_ms)} ms |`,
  `| START→prefijo ≥3 s | ${a.common.ge_3000} | ${b.common.ge_3000} |`,
  `| START→prefijo ≥6 s | ${a.common.ge_6000} | ${b.common.ge_6000} |`,
  `| RPC físicos target 96 (runs) | ${a.runs_with_target_getfile} | ${b.runs_with_target_getfile} |`,
  `| getMessages batch (runs) | ${a.runs_with_get_messages} | ${b.runs_with_get_messages} |`,
  `| Cache descriptor 96 (runs) | ${a.runs_with_target_media_cache_hit} | ${b.runs_with_target_media_cache_hit} |`,
  `| Cache rango 96 (runs) | ${a.runs_with_target_range_cache_hit} | ${b.runs_with_target_range_cache_hit} |`,
  `| Shared range 96 (runs) | ${a.runs_with_target_shared_join} | ${b.runs_with_target_shared_join} |`,
  `| Retry / error RPC 96 (runs) | ${a.runs_with_target_retry}/${a.runs_with_target_rpc_error} | ${b.runs_with_target_retry}/${b.runs_with_target_rpc_error} |`,
  `| Abort 96 (runs) | ${a.runs_with_target_abort} | ${b.runs_with_target_abort} |`,
  `| getFile WebSocket send→respuesta p95 | ${fmt(a.targetWire.p95_ms)} ms | ${fmt(b.targetWire.p95_ms)} ms |`,
  `| getFile WebSocket send→respuesta max | ${fmt(a.targetWire.max_ms)} ms | ${fmt(b.targetWire.max_ms)} ms |`,
  `| START→${a.rows[0]?.endpoint ?? 'PCM'} / ${b.rows[0]?.endpoint ?? '0.5 s'} p50 | ${fmt(a.endpoint.p50_ms)} ms | ${fmt(b.endpoint.p50_ms)} ms |`,
  `| START→endpoint p95 | ${fmt(a.endpoint.p95_ms)} ms | ${fmt(b.endpoint.p95_ms)} ms |`,
  `| START→endpoint max | ${fmt(a.endpoint.max_ms)} ms | ${fmt(b.endpoint.max_ms)} ms |`,
  '',
  `En esta serie, A reprodujo ${a.common.ge_6000} tails y B ${b.common.ge_6000} tails ≥6 s hasta el prefijo. En todos ellos el RPC físico del mensaje 96 también tardó ≥6 s entre WebSocket send y el primer frame de respuesta correlacionado. Por tanto MSE/audio no son necesarios para que aparezca el tail. La frecuencia y p95 difieren entre las dos series secuenciales; esta muestra no permite atribuir esa diferencia al runtime Node o navegador.`,
  '',
  'Los 44 intentos anteriores de A usaron otras condiciones de WARM/repetición; esta comparación añade `warm-adopt` al harness A para consumir el prefijo del mismo batch previo al START, sin una segunda solicitud foreground. La espera de socket observada todavía engloba red, MTProto, Telegram y transporte: no localiza internamente cuál causó la pausa.',
  '',
  '## Runs', '',
  '| Test | Run | Estado | START→prefijo | getMessages | lane wait 96 | send→respuesta 96 | START→endpoint | RPC 96 | bytes prefijo | bytes red 96 | cache rango 96 |',
  '|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...[...a.rows, ...b.rows].map(row => `| ${row.test} | ${row.run_id} | ${row.status} | ${fmt(row.start_to_initial_range_ms)} | ${fmt(row.get_messages_ms)} | ${fmt(row.target_lane_wait_ms)} | ${fmt(row.target_wire_ms)} | ${fmt(row.start_to_endpoint_ms)} | ${row.target_getfile_sends} | ${fmt(row.target_initial_bytes)} | ${fmt(row.target_downloaded_bytes)} | ${row.target_range_cache_hits} |`),
  '', '## Tails ≥6 s (tramo común, RPC 96 o endpoint)', '',
];
const slow = [...a.rows, ...b.rows].filter(row => row.status === 'OK' && (row.start_to_initial_range_ms >= 6000 || row.start_to_endpoint_ms >= 6000 || row.target_wire_ms >= 6000));
if (!slow.length) lines.push('No se observó ningún tail ≥6 s.');
else lines.push('| Test / run | send 96 | primer frame 96 | prefijo | MSE primer rango | playing | endpoint |',
  '|---|---:|---:|---:|---:|---:|---:|',
  ...slow.map(row => `| ${row.test} ${row.run_id} | ${fmt(row.target_getfile_send_t_ms)} | ${fmt(row.target_first_response_t_ms)} | ${fmt(row.start_to_initial_range_ms)} | ${fmt(row.mse_first_range_t_ms)} | ${fmt(row.playing_t_ms)} | ${fmt(row.start_to_endpoint_ms)} |`), '');
if (slow.length) lines.push(`En estos ${slow.length} tails: getMessages ${slow.filter(row => row.get_messages_ms != null).length}, retries del RPC 96 ${slow.filter(row => row.target_retries > 0).length}, aborts del 96 ${slow.filter(row => row.target_aborts > 0).length}, reconexiones antes de la respuesta del 96 ${slow.filter(row => row.connection_transitions_before_target_response.length > 0).length}; espera de lane máxima ${Math.max(...slow.map(row => row.target_lane_wait_ms))} ms.`, '');
for (const row of slow) {
  lines.push(`### ${row.test} ${row.run_id}`, '',
    `START→prefijo ${fmt(row.start_to_initial_range_ms)} ms; send→respuesta 96 ${fmt(row.target_wire_ms)} ms; START→${row.endpoint} ${fmt(row.start_to_endpoint_ms)} ms.`, '');
  for (const event of row.timeline) lines.push(`- ${event.t_ms >= 0 ? '+' : ''}${event.t_ms} ms · ${event.stage}${event.message_id ? ` · mensaje ${event.message_id}` : ''}${event.bytes != null ? ` · ${event.bytes} bytes` : ''}${event.websocket_first_message_t_ms != null ? ` · primer frame correlacionado +${event.websocket_first_message_t_ms} ms` : ''}`);
  lines.push('');
}
fs.writeFileSync(path.join(outputDir, 'RESULTS.md'), lines.join('\n'));
console.log(JSON.stringify({ a: { common: a.common, endpoint: a.endpoint, targetWire: a.targetWire, physical: a.runs_with_target_getfile, long: a.long }, b: { common: b.common, endpoint: b.endpoint, targetWire: b.targetWire, physical: b.runs_with_target_getfile, long: b.long } }, null, 2));
