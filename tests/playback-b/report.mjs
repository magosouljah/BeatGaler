const round = value => value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
const first = (events, stage) => events.find(event => event.stage === stage);
const last = (events, stage) => events.findLast(event => event.stage === stage);
const diff = (a, b) => a && b ? round(b.ts_ms - a.ts_ms) : null;
const value = item => item == null ? '—' : String(item);

export function summarize(inputEvents, base = {}) {
  const events = [...inputEvents].sort((a, b) => a.ts_ms - b.ts_ms);
  const intent = first(events, 'INTENT_BEGIN');
  const start = first(events, 'START');
  const peer = first(events, 'PEER_READY');
  const focus = first(events, 'TRANSPORT_FOCUS_DONE');
  const prepared = first(events, 'SOURCE_PREPARE_RETURN');
  const playing = first(events, 'AUDIO_EVENT_PLAYING');
  const progress = first(events, 'AUDIO_FIRST_PROGRESS');
  const half = first(events, 'AUDIO_HALF_SECOND');
  const end = last(events, 'END');
  const gets = events.filter(event => event.stage === 'WORKER_MEDIA_GET_MESSAGES_DONE');
  const lane = events.filter(event => event.stage === 'WORKER_DATA_LANE_ACQUIRED');
  const fileBegin = first(events, 'WORKER_GET_FILE_WEBSOCKET_SEND_CALLED') || first(events, 'WORKER_GET_FILE_SOCKET_SEND_CALLED') || first(events, 'WORKER_GET_FILE_CALL_ENTER');
  const fileResponse = first(events, 'WORKER_GET_FILE_RPC_RESULT_ENTER') || first(events, 'WORKER_GET_FILE_CALL_DONE');
  const firstByte = first(events, 'WARM_PREFIX_READY') || first(events, 'PLAY_STREAM_FIRST_CHUNK');
  const firstRange = first(events, 'SOURCE_FIRST_PLAYABLE_RANGE');
  const getMessagesBegin = first(events, 'WORKER_MEDIA_GET_MESSAGES_BEGIN');
  const getMessagesEnd = first(events, 'WORKER_MEDIA_GET_MESSAGES_DONE');
  const statuses = events.filter(event => /CANCEL|ABORT|PREEMPT/.test(String(event.stage)) && (event.stage !== 'PLAY_WARM_PREEMPT_ALL' || Number(event.aborted || 0) > 0));
  const retries = events.filter(event => /RETRY|RETRANSMIT/.test(String(event.stage)));
  const cacheHits = events.filter(event => /CACHE_HIT|PENDING_JOIN|ACTIVE_PLAYBACK_HIT|SESSION_CACHE_HIT/.test(String(event.stage)));
  const sessionMs = intent?.session_state === 'new' ? diff(intent, peer) : 0;
  return {
    ...base, status: end && half ? 'OK' : 'ERROR',
    total_ms: diff(intent || start, half), intent_to_start_ms: diff(intent, start), session_ms: sessionMs,
    start_to_focus_ms: diff(start, focus), focus_to_source_ms: diff(focus, prepared),
    source_to_playing_ms: diff(prepared, playing), playing_to_progress_ms: diff(playing, progress),
    playing_to_half_ms: diff(playing, half),
    get_messages_ms: diff(getMessagesBegin, getMessagesEnd), get_messages_calls: gets.length,
    get_file_to_response_ms: fileBegin && fileResponse ? round((Number(fileResponse.websocket_first_message_ts_ms) || fileResponse.ts_ms) - fileBegin.ts_ms) : null,
    start_to_first_byte_ms: diff(start, firstByte), first_byte_to_range_ms: diff(firstByte, firstRange),
    first_range_to_playing_ms: diff(firstRange, playing),
    lane_wait_ms: round(lane.reduce((sum, event) => sum + Number(event.wait_ms || 0), 0)),
    retries: retries.length, aborts_preempts: statuses.length, cache_hits: cacheHits.length,
    shared_range_joins: events.filter(event => event.stage === 'WORKER_PLAYBACK_RANGE_PENDING_JOIN').length,
    prefix_bytes: firstByte?.bytes ?? null,
    source_mode: first(events, 'SOURCE_PREPARE')?.mode ?? null,
    warm_adopted: events.some(event => event.stage === 'PLAY_WARM_ADOPTED'),
    warm_promoted: events.some(event => event.stage === 'PLAY_WARM_PROMOTED'),
    batch_count: events.filter(event => event.stage === 'WARM_BATCH_BEGIN').length,
    batch_ids: events.filter(event => event.stage === 'TRANSPORT_PREFETCH_BATCH_ENTER').flatMap(event => event.message_ids || []).join(';') || null,
    first_progress_s: progress?.current_time ?? null,
    half_progress_s: half?.current_time ?? null,
    error_name: first(events, 'RUN_ERROR')?.error_name ?? null,
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]);
}
export function metrics(rows) {
  const values = rows.filter(row => row.status === 'OK').map(row => row.total_ms).filter(Number.isFinite);
  return { valid_runs: values.length, requested_runs: rows.length, p50_ms: percentile(values, .5), p95_ms: percentile(values, .95), max_ms: values.length ? round(Math.max(...values)) : null, runs_ge_6000: values.filter(value => value >= 6000).length };
}
export { metrics as summarizeMetrics };
export function csv(rows) {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  return [keys.join(','), ...rows.map(row => keys.map(key => {
    const value = row[key] ?? '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }).join(','))].join('\n') + '\n';
}
export function markdown(summary, events) {
  const m = metrics(summary.rows);
  const lines = [
    '# Test B · playback real en navegador mínimo',
    '',
    `Cuenta 03 · Telegram message_id 96 · Stage1 Playback v2 03.mp3 · modo ${summary.mode}.`,
    '',
    `Runs válidos: ${m.valid_runs}/${m.requested_runs}. P50 ${value(m.p50_ms)} ms · p95 ${value(m.p95_ms)} ms · máximo ${value(m.max_ms)} ms · ≥6 s: ${m.runs_ge_6000}. Percentiles: nearest rank sobre runs válidos.`,
    '',
    'Las etapas foco→fuente incluyen WARM/adopción. getMessages, getFile y lane son subdivisiones que pueden solaparse: no se suman a las etapas.',
    '',
    '| Run | Estado | Total→0.5s | Intent→START | Sesión/peer* | START→foco | Foco→fuente | Fuente→playing | Playing→0.5s | getMessages* | getFile→respuesta* | Lane* | Modo |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...summary.rows.map(row => `| ${row.run_id} | ${row.status} | ${value(row.total_ms)} | ${value(row.intent_to_start_ms)} | ${value(row.session_ms)} | ${value(row.start_to_focus_ms)} | ${value(row.focus_to_source_ms)} | ${value(row.source_to_playing_ms)} | ${value(row.playing_to_half_ms)} | ${value(row.get_messages_ms)} | ${value(row.get_file_to_response_ms)} | ${value(row.lane_wait_ms)} | ${value(row.source_mode)} |`),
    '',
    '* Sesión/peer es parte de Intent→START. getMessages, getFile y lane son subdivisiones solapadas de otras etapas.',
    '',
    '## Timeline de runs ≥6 s',
    '',
  ];
  const slow = summary.rows.filter(row => row.status === 'OK' && row.total_ms >= 6000);
  if (!slow.length) lines.push('No hubo runs ≥6 s.');
  for (const row of slow) {
    const runEvents = events.filter(event => event.run_id === row.run_id).sort((a, b) => a.ts_ms - b.ts_ms);
    const start = first(runEvents, 'INTENT_BEGIN') || first(runEvents, 'START');
    lines.push(`### ${row.run_id} · ${row.total_ms} ms`, '');
    for (const event of runEvents) {
      if (!/^(SESSION_|PEER_|START$|TRANSPORT_FOCUS|PLAY_WARM|WARM_PREFIX|WORKER_MEDIA_GET_MESSAGES|WORKER_GET_FILE_(CALL|WEBSOCKET)|WORKER_DATA_LANE|SOURCE_(PREPARE|URL_READY|MSE_SOURCEOPEN|MSE_APPEND_DONE|FIRST_PLAYABLE_RANGE)|AUDIO_(PLAY_CALL|EVENT_PLAYING|FIRST_PROGRESS|HALF_SECOND))/.test(String(event.stage))) continue;
      lines.push(`- +${round(event.ts_ms - start.ts_ms)} ms · ${event.stage}${event.message_id ? ` · message ${event.message_id}` : ''}`);
    }
    lines.push('');
  }
  lines.push('## Límites', '', ...summary.limits.map(item => `- ${item}`), '');
  return lines.join('\n');
}
