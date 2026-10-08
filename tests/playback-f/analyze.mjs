import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2);
if (!dirs.length) throw new Error('Usage: node tests/playback-f/analyze.mjs <Test E output dirs...>');
const rounded = value => Math.round(value * 10) / 10;
const percentile = (values, p) => rounded([...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]);
const runs = [];
for (const dir of dirs) {
  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'COMPLETE');
  assert.equal(summary.test_e_writer, 'shared'); // Installed production writer, no fresh-writer test override.
  assert.deepEqual(summary.test_e_message_ids, [96, 101]);
  const events = fs.readFileSync(path.join(dir, 'trace.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  for (const row of summary.rows) {
    const trace = events.filter(event => event.run_id === row.run_id);
    const start = trace.find(event => event.stage === 'START');
    const end = trace.find(event => event.stage === 'END');
    const sends = [96, 101].map(id => trace.find(event =>
      event.stage === 'D_RPC_WEBSOCKET_SEND' && event.message_id === id));
    const results = sends.map(send => send && trace.find(event =>
      event.stage === 'D_RPC_RESULT' && event.msg_id === send.msg_id && event.ts_ms >= send.ts_ms));
    const valid = row.status === 'OK' && start && end && sends.every(Boolean) && results.every(Boolean)
      && sends[0].socket_id === sends[1].socket_id
      && sends[0].session_tag === sends[1].session_tag
      && sends[0].packet_id !== sends[1].packet_id
      && sends.every(send => send.ts_ms < Math.min(...results.map(result => result.ts_ms)));
    runs.push({
      series: path.basename(dir), run_id: row.run_id, valid: Boolean(valid),
      target_ms: valid ? rounded(results[0].ts_ms - sends[0].ts_ms) : null,
      same_socket: Boolean(valid && sends[0].socket_id === sends[1].socket_id),
      concurrent: Boolean(valid && sends.every(send => send.ts_ms < Math.min(...results.map(result => result.ts_ms)))),
      separate_packets: Boolean(valid && sends[0].packet_id !== sends[1].packet_id),
      separate_writes: Boolean(valid && sends[0].ws_send_id !== sends[1].ws_send_id),
      state_requests: trace.filter(event => event.stage === 'D_STATE_REQ_WEBSOCKET_SEND').length,
      reconnects: trace.filter(event => event.stage === 'D_SOCKET_SEEN' && start && end
        && event.ts_ms >= start.ts_ms && event.ts_ms <= end.ts_ms).length,
      auth_errors: trace.filter(event => event.rpc_error_tag === 'AUTH_KEY_UNREGISTERED').length,
      flood_errors: trace.filter(event => String(event.rpc_error_tag || '').startsWith('FLOOD_WAIT')).length,
    });
  }
}
const valid = runs.filter(run => run.valid);
const times = valid.map(run => run.target_ms);
const result = {
  attempted: runs.length, valid: valid.length,
  p50: times.length ? percentile(times, .5) : null,
  p95: times.length ? percentile(times, .95) : null,
  p99: times.length ? percentile(times, .99) : null,
  max: times.length ? percentile(times, 1) : null,
  ge15: times.filter(ms => ms >= 1500).length,
  ge3: times.filter(ms => ms >= 3000).length,
  ge6: times.filter(ms => ms >= 6000).length,
  ge9: times.filter(ms => ms >= 9000).length,
  same_socket: valid.filter(run => run.same_socket).length,
  concurrent: valid.filter(run => run.concurrent).length,
  separate_packets: valid.filter(run => run.separate_packets).length,
  separate_writes: valid.filter(run => run.separate_writes).length,
  state_request_runs: valid.filter(run => run.state_requests > 0).length,
  reconnect_runs: valid.filter(run => run.reconnects > 0).length,
  auth_error_runs: runs.filter(run => run.auth_errors > 0).length,
  flood_error_runs: runs.filter(run => run.flood_errors > 0).length,
};
console.log(JSON.stringify(result, null, 2));
if (valid.length < 200 || result.separate_writes !== valid.length || result.concurrent !== valid.length) process.exitCode = 1;
