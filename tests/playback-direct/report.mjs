const rounded = n => Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
const delta = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? rounded(b - a) : null;

export function summarizeRun(events, run) {
  const e = events.filter(e => e.run_id === run.run_id);
  const first = stage => e.find(e => e.stage === stage);
  const time = stage => first(stage)?.ts_ms;
  const span = (a, b) => delta(time(a), time(b));
  const all = stage => e.filter(e => e.stage === stage);
  const sum = (stage, field) => rounded(all(stage).reduce((n, e) => n + (Number(e[field]) || 0), 0));
  const ingress = first('WORKER_GET_FILE_RPC_RESULT_ENTER');
  const send = first('WORKER_GET_FILE_WEBSOCKET_SEND_CALLED');
  const entry = run.route === 'stream' ? 'WORKER_STREAM_ENTER' : 'WORKER_PREFETCH_ENTER';
  const post = run.route === 'stream' ? 'WORKER_STREAM_FIRST_POST_BEGIN' : 'WORKER_PREFIX_RESPONSE_POST_BEGIN';
  const primaryId = first(entry)?.request_id;
  const primaryTime = stage => e.find(event => event.stage === stage && event.request_id === primaryId)?.ts_ms;
  const rangeDone = run.route === 'stream' ? 'WORKER_STREAM_FIRST_READ_DONE' : 'WORKER_PREFETCH_READY';
  const messageRpc = stage => e.find(event => event.stage === stage && /^(channels|messages)\.getMessages$/.test(event.rpc_method));
  const messageCore = messageRpc('MTCUTE_CORE_CALL_BEGIN');
  const messageConnection = messageRpc('MTCUTE_CONNECTION_RPC_BEGIN');
  const messageDone = e.find(event => event.stage === 'MTCUTE_CONNECTION_RPC_DONE' && event.rpc_id === messageConnection?.rpc_id);
  const coreDownloads = all('MTCUTE_CORE_CALL_DONE').filter(event => event.rpc_method === 'upload.getFile' && Number.isFinite(event.bytes));
  const activeRanges = new Map();
  let duplicateRanges = 0;
  for (const event of e) {
    if (event.stage === 'WORKER_PREFIX_DOWNLOAD_BEGIN') {
      const key = `${event.offset_bytes}:${event.limit_bytes}`;
      if ([...activeRanges.values()].includes(key)) duplicateRanges++;
      activeRanges.set(`${event.request_id}:${event.offset_bytes}`, key);
    }
    if (event.stage === 'WORKER_PREFIX_DOWNLOAD_DONE' || event.stage === 'WORKER_PREFIX_DOWNLOAD_ERROR') activeRanges.delete(`${event.request_id}:${event.offset_bytes}`);
  }
  return {
    ...run,
    total_to_pcm_ms: span('START', 'DECODED_PCM'),
    total_to_frames_ms: span('START', 'FIRST_USEFUL_RANGE'),
    dispatch_ms: span('START', entry),
    media_resolve_ms: delta(primaryTime(entry), primaryTime('WORKER_MEDIA_RESOLVE_READY')),
    range_wait_ms: delta(primaryTime('WORKER_MEDIA_RESOLVE_READY'), primaryTime(rangeDone)),
    range_to_frames_ms: delta(primaryTime(rangeDone), time('FIRST_USEFUL_RANGE')),
    get_messages_ms: sum('WORKER_MEDIA_GET_MESSAGES_DONE', 'elapsed_ms'),
    get_messages_calls: all('WORKER_MEDIA_GET_MESSAGES_BEGIN').length,
    get_messages_before_core_ms: delta(time('WORKER_MEDIA_GET_MESSAGES_BEGIN'), messageCore?.ts_ms),
    get_messages_to_connection_ms: delta(messageCore?.ts_ms, messageConnection?.ts_ms),
    get_messages_connection_ms: delta(messageConnection?.ts_ms, messageDone?.ts_ms),
    get_messages_after_connection_ms: delta(messageDone?.ts_ms, time('WORKER_MEDIA_GET_MESSAGES_DONE')),
    lane_wait_ms: sum('WORKER_DATA_LANE_ACQUIRED', 'wait_ms'),
    download_ms: sum('WORKER_PREFIX_DOWNLOAD_DONE', 'elapsed_ms'),
    getfile_calls: all('WORKER_GET_FILE_CALL_ENTER').length,
    getfile_before_socket_ms: span('WORKER_GET_FILE_CALL_ENTER', 'WORKER_GET_FILE_WEBSOCKET_SEND_CALLED'),
    socket_to_first_response_ms: delta(send?.ts_ms, ingress?.websocket_first_message_ts_ms),
    response_transfer_ms: delta(ingress?.websocket_first_message_ts_ms, ingress?.websocket_message_ts_ms),
    response_to_download_done_ms: delta(ingress?.websocket_message_ts_ms, time('WORKER_PREFIX_DOWNLOAD_DONE')),
    worker_delivery_ms: span(post, 'FIRST_BYTES'),
    consumer_ms: span('FIRST_USEFUL_RANGE', 'DECODED_PCM'),
    media_cache_hit: first('WORKER_MEDIA_RESOLVE_READY')?.media_cache_hit ?? null,
    range_cache_hits: all('WORKER_PLAYBACK_RANGE_CACHE_HIT').length,
    shared_range_joins: all('WORKER_PLAYBACK_RANGE_PENDING_JOIN').length,
    media_pending_joins: all('WORKER_PLAYBACK_MEDIA_PENDING_JOIN').length,
    downloaded_bytes: coreDownloads.length ? rounded(coreDownloads.reduce((total, event) => total + event.bytes, 0)) : sum('WORKER_PREFIX_DOWNLOAD_DONE', 'bytes'),
    consumer_bytes: first('FIRST_USEFUL_RANGE')?.bytes ?? null,
    retries: all('WORKER_GET_FILE_RPC_RETRY').length,
    get_messages_errors: all('WORKER_MEDIA_GET_MESSAGES_ERROR').length,
    mtcute_rpc_errors: all('MTCUTE_CONNECTION_RPC_ERROR').length,
    getfile_errors: all('WORKER_GET_FILE_CALL_ERROR').length,
    mtcute_logs: all('MTCUTE_LOG').length,
    socket_sends: all('WORKER_GET_FILE_WEBSOCKET_SEND_CALLED').length,
    foreground_requests: all('SCHEDULER_REQUEST').filter(event => ['stream', 'prefetch'].includes(event.operation)).length,
    concurrent_duplicate_ranges: duplicateRanges,
    wire_timing_complete: all('WORKER_PREFIX_DOWNLOAD_BEGIN').length ? Number.isFinite(send?.ts_ms) && Number.isFinite(ingress?.websocket_first_message_ts_ms) : null,
    mse_ready_ms: null, playing_ms: null, current_time_advance_ms: null,
  };
}

export function csv(rows) {
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const quote = value => JSON.stringify(value === null || value === undefined ? '' : String(value));
  return [keys.join(','), ...rows.map(row => keys.map(key => quote(row[key])).join(','))].join('\n') + '\n';
}

export function markdown(summary) {
  const value = x => x === null || x === undefined ? '—' : String(x);
  return `# Playback directo · cuenta ${summary.account} · mensaje ${summary.message_id}\n\n` +
    `Estado: ${summary.status}. Modo: ${summary.mode}. Ruta: ${summary.route || 'prefetch'}. Archivo esperado: ${summary.filename}.\n\n` +
    'Todas las duraciones están en ms. START ocurre con sesión y peer preparados. Las cinco etapas despacho + media + rango + entrega/parser + consumidor suman START→PCM (salvo redondeo). Rango incluye espera de lane/caché/shared/download; getMessages y getFile son subdivisiones, no se suman otra vez. Un guion significa no medido/no aplica.\n\n' +
    '| Run | Estado | Sesión previa | Despacho | Media | Rango | Entrega/parser | Consumidor PCM | Total PCM | getMessages | getFile | Lane | Cache rango |\n' +
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n' +
    summary.rows.map(r => `| ${[r.run_id, r.status, r.session_setup_ms, r.dispatch_ms, r.media_resolve_ms, r.range_wait_ms, r.range_to_frames_ms, r.consumer_ms, r.total_to_pcm_ms, r.get_messages_ms, r.download_ms, r.lane_wait_ms, r.range_cache_hits].map(value).join(' | ')} |`).join('\n') +
    '\n\nMSE, PLAYING, salida audible y currentTime: no medidos. FFmpeg recibe el rango y EOF; su arranque y decodificación están dentro de consumidor PCM. FIRST_USEFUL_RANGE sólo significa ≥2 frames MPEG completos según el parser de producción. DECODED_PCM sí prueba decodificación.\n\n' +
    summary.limits.map(limit => `- ${limit}`).join('\n') + '\n';
}
