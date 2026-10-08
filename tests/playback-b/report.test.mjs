import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, metrics } from './report.mjs';

test('accounts for a socket-response tail without charging it to lane or MSE', () => {
  const event = (stage, ts_ms, detail = {}) => ({ stage, ts_ms, ...detail });
  const events = [
    event('INTENT_BEGIN', 0, { session_state: 'ready' }),
    event('START', 10), event('TRANSPORT_FOCUS_DONE', 20),
    event('WORKER_DATA_LANE_ACQUIRED', 21, { wait_ms: 0 }),
    event('WORKER_GET_FILE_WEBSOCKET_SEND_CALLED', 25),
    event('WORKER_GET_FILE_WEBSOCKET_MESSAGE', 80), // unrelated packet
    event('WORKER_GET_FILE_RPC_RESULT_ENTER', 6725, { websocket_first_message_ts_ms: 6720 }),
    event('WARM_PREFIX_READY', 6730, { bytes: 17136 }),
    event('SOURCE_PREPARE_RETURN', 6735),
    event('SOURCE_FIRST_PLAYABLE_RANGE', 6750),
    event('AUDIO_EVENT_PLAYING', 6760),
    event('AUDIO_FIRST_PROGRESS', 7010, { current_time: .2 }),
    event('AUDIO_HALF_SECOND', 7560, { current_time: .73 }),
    event('END', 7561),
  ];
  const row = summarize(events.reverse(), { run_id: 'slow' });
  assert.equal(row.status, 'OK');
  assert.equal(row.total_ms, 7560);
  assert.equal(row.get_file_to_response_ms, 6695);
  assert.equal(row.lane_wait_ms, 0);
  assert.equal(row.source_to_playing_ms, 25);
  assert.equal(row.playing_to_half_ms, 800);
});

test('nearest-rank percentiles exclude failed runs', () => {
  assert.deepEqual(metrics([{ status: 'OK', total_ms: 100 }, { status: 'OK', total_ms: 7000 }, { status: 'ERROR', total_ms: null }]), {
    valid_runs: 2, requested_runs: 3, p50_ms: 100, p95_ms: 7000, max_ms: 7000, runs_ge_6000: 1,
  });
});
