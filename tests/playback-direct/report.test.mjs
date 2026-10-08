import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun, csv } from './report.mjs';

function event(stage, ts_ms, fields = {}) { return { run_id: 'r1', request_id: 'p1', stage, ts_ms, ...fields }; }
test('attributes a 10.4 second sample without double-counting nested spans', () => {
  const events = [event('START', 0), event('WORKER_STREAM_ENTER', 10),
    event('WORKER_MEDIA_GET_MESSAGES_BEGIN', 20), event('WORKER_MEDIA_GET_MESSAGES_DONE', 1010, { elapsed_ms: 990 }),
    event('WORKER_MEDIA_RESOLVE_READY', 1010), event('WORKER_DATA_LANE_ACQUIRED', 1100, { wait_ms: 90 }),
    event('WORKER_PREFIX_DOWNLOAD_BEGIN', 1100), event('WORKER_GET_FILE_CALL_ENTER', 1100),
    event('WORKER_GET_FILE_WEBSOCKET_SEND_CALLED', 1100),
    event('WORKER_GET_FILE_RPC_RESULT_ENTER', 9810, { websocket_first_message_ts_ms: 9800, websocket_message_ts_ms: 9805 }),
    event('WORKER_PREFIX_DOWNLOAD_DONE', 9900, { elapsed_ms: 8800, bytes: 65536 }),
    event('WORKER_STREAM_FIRST_READ_DONE', 9900), event('WORKER_STREAM_FIRST_POST_BEGIN', 9900),
    event('FIRST_BYTES', 9910), event('FIRST_USEFUL_RANGE', 10000), event('DECODED_PCM', 10400)];
  const row = summarizeRun(events, { run_id: 'r1', route: 'stream' });
  assert.equal(row.total_to_pcm_ms, 10400);
  assert.equal(row.socket_to_first_response_ms, 8700);
  assert.equal(row.dispatch_ms + row.media_resolve_ms + row.range_wait_ms + row.range_to_frames_ms + row.consumer_ms, 10400);
  assert.equal(row.get_messages_ms, 990);
  assert.equal(row.download_ms, 8800);
});
test('missing ingress is unknown, never a fabricated negative latency', () => {
  const row = summarizeRun([event('WORKER_GET_FILE_WEBSOCKET_SEND_CALLED', 1700000000000), event('WORKER_GET_FILE_RPC_RESULT_ENTER', 1700000000100, { websocket_first_message_ts_ms: null, websocket_message_ts_ms: null })], { run_id: 'r1' });
  assert.equal(row.socket_to_first_response_ms, null);
  assert.equal(row.response_transfer_ms, null);
  assert.equal(row.total_to_pcm_ms, null);
});
test('cache hit and other runs cannot produce network calls for this run', () => {
  const row = summarizeRun([event('WORKER_PLAYBACK_RANGE_CACHE_HIT', 5), { run_id: 'other', stage: 'WORKER_GET_FILE_CALL_ENTER', ts_ms: 5 }], { run_id: 'r1' });
  assert.equal(row.range_cache_hits, 1);
  assert.equal(row.getfile_calls, 0);
  assert.equal(row.download_ms, 0);
  assert.equal(row.socket_to_first_response_ms, null);
});
test('CSV retains error columns first seen in later failed runs', () => {
  const text = csv([{ status: 'OK' }, { status: 'ERROR', error_name: 'HarnessTimeout' }]);
  assert.match(text, /^status,error_name\n/);
  assert.match(text, /HarnessTimeout/);
});
test('secondary download after primary cache hit is workload, not primary latency', () => {
  const events = [event('START', 0), event('WORKER_STREAM_ENTER', 1), event('WORKER_MEDIA_RESOLVE_READY', 2),
    event('WORKER_STREAM_FIRST_READ_DONE', 3), event('FIRST_USEFUL_RANGE', 5), event('DECODED_PCM', 70),
    event('WORKER_PREFIX_DOWNLOAD_BEGIN', 4, { request_id: 'secondary', offset_bytes: 0, limit_bytes: 65536 }),
    event('WORKER_PREFIX_DOWNLOAD_DONE', 200, { request_id: 'secondary', offset_bytes: 0, elapsed_ms: 196 })];
  const row = summarizeRun(events, { run_id: 'r1', route: 'stream' });
  assert.equal(row.total_to_pcm_ms, 70);
  assert.equal(row.download_ms, 196);
  assert.equal(row.dispatch_ms + row.media_resolve_ms + row.range_wait_ms + row.range_to_frames_ms + row.consumer_ms, 70);
  assert.ok(Object.entries(row).filter(([key]) => key.endsWith('_ms')).every(([, value]) => value === null || value >= 0));
});
test('counts actual core response bytes including continuation without double counting the prefix', () => {
  const row = summarizeRun([event('WORKER_PREFIX_DOWNLOAD_DONE', 10, { bytes: 65536 }),
    event('MTCUTE_CORE_CALL_DONE', 10, { rpc_method: 'upload.getFile', bytes: 65536 }),
    event('MTCUTE_CORE_CALL_DONE', 20, { rpc_method: 'upload.getFile', bytes: 8192 })], { run_id: 'r1' });
  assert.equal(row.downloaded_bytes, 73728);
});
