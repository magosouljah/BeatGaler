import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildHarness, root } from '../tests/playback-direct/build.mjs';
import { summarizeRun, csv, markdown } from '../tests/playback-direct/report.mjs';

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
}
if (process.argv.includes('--help')) {
  console.log('node scripts/run-playback-direct.mjs [--runs 20] [--mode repeat|cold|warm|warm-adopt|duplicate|test-d-raw] [--route stream|prefetch] [--warm-message-ids 101] [--warm-lead-ms 10] [--test-c-mode observe|suppress|early] [--test-d-mode observe] [--test-d-route-101 main|download] [--test-d-order none|96|101] [--test-d-offset-ms 0] [--test-d-include-101 true|false] [--test-d-sequential true|false] [--test-d-first 96|101] [--account 03] [--message 96] [--filename "Stage1 Playback v2 03.mp3"] [--ffmpeg ffmpeg] [--out directory]\nRequires existing .env.stage1 and running Cloud/PostgreSQL. Test D raw mode calls real mtcute downloadChunk without UI or PCM; media is resolved before START.');
  process.exit(0);
}
const runs = Number(option('runs', '20'));
const mode = option('mode', 'repeat');
const route = option('route', 'stream');
const account = option('account', '03');
const messageId = Number(option('message', '96'));
const filename = option('filename', 'Stage1 Playback v2 03.mp3');
const warmMessageIds = String(option('warm-message-ids', '')).split(',').filter(Boolean).map(Number);
const warmLeadMs = Number(option('warm-lead-ms', '10'));
const testCMode = option('test-c-mode', 'off');
const testCEarlyMs = Number(option('test-c-early-ms', '100'));
const testCWarmTimeoutMs = Number(option('test-c-warm-timeout-ms', '90000'));
const testDMode = option('test-d-mode', 'off');
const testDRoute101 = option('test-d-route-101', 'main');
const testDOrder = option('test-d-order', 'none');
const testDOffsetMs = Number(option('test-d-offset-ms', '0'));
const testDInclude101 = option('test-d-include-101', 'true') === 'true';
const testDSequential = option('test-d-sequential', 'false') === 'true';
const testDFirst = Number(option('test-d-first', testDOrder === '101' ? '101' : '96'));
const testEWriter = option('test-e-writer', 'shared');
const testETiming = option('test-e-timing', 'same');
const testEMessageIds = String(option('test-e-message-ids', '')).split(',').filter(Boolean).map(Number);
const testECapture = option('test-e-capture', 'false') === 'true';
const testEAlternate = option('test-e-alternate', 'false') === 'true';
const testEScheduleText = option('test-e-schedule', '');
const testEReconnectBefore = Number(option('test-e-reconnect-before', '0'));
const testESchedule = testEScheduleText ? testEScheduleText.split(',').map(part => {
  const [writer, countText] = part.split(':'); return { writer, count: Number(countText) };
}) : [];
if (!['shared', 'fresh'].includes(testEWriter) || !['same', 'microtask', 'immediate', 'delay'].includes(testETiming) || testEMessageIds.some(id => ![96,101].includes(id)) || testEMessageIds.length > 7 || (testEWriter !== 'shared' && testDMode !== 'observe') || (testETiming !== 'same' && mode !== 'test-d-raw') || (testEAlternate && mode !== 'test-d-raw') || (testESchedule.length && (mode !== 'test-d-raw' || testEAlternate || testESchedule.some(s => !['shared','fresh'].includes(s.writer) || !Number.isInteger(s.count) || s.count<1) || testESchedule.reduce((n,s)=>n+s.count,0)!==runs)) || !Number.isInteger(testEReconnectBefore) || testEReconnectBefore<0 || (testEReconnectBefore>0 && (mode!=='test-d-raw'||testEReconnectBefore>runs))) throw new Error('Invalid Test E options');
if (!Number.isInteger(runs) || runs < 1 || runs > 100 || !Number.isSafeInteger(messageId) || messageId < 1 || !['stream', 'prefetch'].includes(route) || !['repeat', 'cold', 'warm', 'warm-adopt', 'duplicate', 'test-d-raw'].includes(mode) || !/^\d{2}$/.test(account) || warmMessageIds.some(id => !Number.isSafeInteger(id) || id < 1) || !Number.isFinite(warmLeadMs) || warmLeadMs < 0 || (mode === 'warm-adopt' && route !== 'prefetch') || !['off', 'observe', 'suppress', 'early'].includes(testCMode) || !Number.isFinite(testCEarlyMs) || testCEarlyMs < 0 || !Number.isFinite(testCWarmTimeoutMs) || testCWarmTimeoutMs < 1000 || testCWarmTimeoutMs > 90000 || (testCMode === 'off' && testCWarmTimeoutMs !== 90000) || !['off', 'observe'].includes(testDMode) || !['main', 'download'].includes(testDRoute101) || !['none', '96', '101'].includes(testDOrder) || !Number.isFinite(testDOffsetMs) || testDOffsetMs < 0 || testDOffsetMs > 500 || (testDMode !== 'off' && testCMode !== 'off') || (testDMode === 'off' && (testDRoute101 !== 'main' || testDOrder !== 'none' || testDOffsetMs !== 0)) || (mode === 'test-d-raw' && (testDMode !== 'observe' || messageId !== 96)) || !['true','false'].includes(option('test-d-include-101','true')) || !['true','false'].includes(option('test-d-sequential','false')) || (testDSequential && (mode !== 'test-d-raw' || testDOrder !== 'none' || testDOffsetMs !== 0))) throw new Error('Invalid arguments; see --help');
const experimentId = `direct-${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}`;
const out = path.resolve(root, option('out', `tmp/playback-harness/${experimentId}`));
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'trace.jsonl'))) throw new Error('Output already contains a trace; use a new --out directory');
const events = [], rows = [];
let runId = 'setup', intentId = null, worker = null, session = null, heartbeat = null, sessionSetupMs = null;
let serial = 0, token = '', cookie = '', csrf = '';
const pending = new Map();
const ts = () => performance.timeOrigin + performance.now();
// No raw requests/responses, auth keys, access hashes, cookies or error text.
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/auth_key|access.?hash|cookie|token|binding|salt|vault_chat_id|channel_id|user_id|bot_id|session_id|error_message/i.test(key)).map(([key, value]) => [key, sanitize(value)]));
}
function record(event) {
  const row = sanitize({ run_id: runId, intent_id: intentId, ts_ms: ts(), ...event });
  events.push(row);
  fs.appendFileSync(path.join(out, 'trace.jsonl'), JSON.stringify(row) + '\n');
}
const realInfo = console.info;
console.info = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[play-trace] ')) {
    try { record(JSON.parse(args[0].slice(13))); } catch { /* optional observation */ }
  }
};
const envPath = path.join(root, '.env.stage1');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const cloud = String(process.env.STAGE1_CLOUD_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const installation = `playback-harness-${crypto.randomUUID()}`;
if (testDMode !== 'off' && ![96, 101].includes(testDFirst)) throw new Error('Invalid --test-d-first');
const summary = { schema_version: 1, experiment_id: experimentId, account, message_id: messageId, filename, mode, route, warm_message_ids: warmMessageIds, warm_lead_ms: warmLeadMs, test_c_mode: testCMode, test_c_early_ms: testCEarlyMs, test_c_warm_timeout_ms: testCWarmTimeoutMs, test_d_mode: testDMode, test_d_route_101: testDRoute101, test_d_order: testDOrder, test_d_offset_ms: testDOffsetMs, test_d_first: testDFirst, test_d_include_101: testDInclude101, test_d_sequential: testDSequential, test_e_writer: testEWriter, test_e_timing: testETiming, test_e_message_ids: testEMessageIds, test_e_capture: testECapture, test_e_alternate: testEAlternate, test_e_schedule: testESchedule, test_e_reconnect_before: testEReconnectBefore, requested_runs: runs,
  runtime: process.version, websocket: 'Node native WebSocket + production @mtcute/web 0.31.0', status: 'RUNNING', rows,
  limits: ['No React/UI, main-thread source cache, INDEX or competing accounts.', 'Node WebSocket and FFmpeg are not browser WebSocket/MSE/audio.', 'PCM proves decoding, not audible output or currentTime advance.', 'Socket wait includes network and Telegram; no server-side timing.', 'Response ingress attribution uses production framed-packet probe; null means unavailable.'] };
function save() {
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(out, 'runs.csv'), csv(rows));
  fs.writeFileSync(path.join(out, 'report.md'), markdown(summary));
}
async function http(route, body = {}) {
  const start = ts();
  record({ stage: 'CONTROL_BEGIN', route });
  const response = await fetch(cloud + route, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-BeatGaler-CSRF': csrf } : {}),
  }, body: JSON.stringify({ ...body, beatgalerUserId: installation }), signal: AbortSignal.timeout(90000) });
  const payload = await response.json();
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map(c => c.split(';')[0]).join('; ');
  if (payload.csrf_token) csrf = payload.csrf_token;
  record({ stage: 'CONTROL_END', route, status: response.status, elapsed_ms: ts() - start });
  if (!response.ok) throw Object.assign(new Error(`Control HTTP ${response.status}: ${route}`), { name: 'ControlError', status: response.status });
  return payload;
}
function request(op, fields = {}, timeoutMs = 45000, onChunk, onPrefetchChunk, onPrefetchTerminal) {
  const requestId = `${runId}:${++serial}:${op}`;
  record({ stage: 'SCHEDULER_REQUEST', request_id: requestId, operation: op });
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(Object.assign(new Error(`Worker timeout: ${op}`), { name: 'HarnessTimeout' })); }, timeoutMs);
    pending.set(requestId, { resolve, reject, timer, onChunk, onPrefetchChunk, onPrefetchTerminal });
    worker.postMessage({ op, requestId, ...fields, stage1TraceContext: { correlation_id: experimentId, account_label: account } });
  });
  return { requestId, promise };
}
async function stopWorker() {
  clearInterval(heartbeat);
  heartbeat = null;
  if (worker) {
    await request('shutdown', {}, 5000).promise.catch(() => {});
    await worker.terminate(); worker = null;
  }
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Worker closed')); }
  pending.clear();
}
async function initialize(authModule, workerFile) {
  await stopWorker();
  const setupStarted = ts();
  record({ stage: 'SESSION_SETUP_BEGIN' });
  const bootstrap = await http('/transport/session/start', { browserClientId: installation });
  session = bootstrap;
  let bound, imported, tempSessionId;
  // Same two-attempt, nonce-only policy as bindTemporarySession in production.
  // These setup attempts are outside START→PCM and remain visible in the trace.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let prepared;
    try {
      record({ stage: 'SESSION_TEMP_AUTH_ATTEMPT', attempt });
      prepared = await authModule.prepareWebTempAuth(bootstrap.temp_auth.dc_id);
      bound = await http('/transport/session/start', { browserClientId: installation, tempAuthMetadata: prepared.metadata });
      if (bound.session_id !== bootstrap.session_id || bound.generation !== bootstrap.generation || bound.transport_id !== bootstrap.transport_id || bound.temp_auth.api_id !== bootstrap.temp_auth.api_id || bound.temp_auth.expires_at !== prepared.metadata.expiresAt) throw new Error('Temporary lease changed');
      imported = await prepared.bind(bound.temp_auth.binding);
      tempSessionId = prepared.metadata.tempSessionId;
      break;
    } catch (error) {
      const nonceFailure = /invalid nonce hash from server/i.test(error.message);
      record({ stage: 'SESSION_TEMP_AUTH_ERROR', attempt, error_name: error.name, reason: nonceFailure ? 'invalid_nonce_hash' : 'other' });
      if (!nonceFailure || attempt === 2) throw error;
      record({ stage: 'SESSION_TEMP_AUTH_RETRY', attempt: attempt + 1, reason: 'invalid_nonce_hash' });
    } finally { await prepared?.destroy(); }
  }
  session = bound;
  worker = new Worker(workerFile, { workerData: { messageId, filename,
    testCMode: testCMode === 'off' ? null : testCMode, testCEarlyMs,
    testDMode: testDMode === 'off' ? null : testDMode,
    testDRoute101, testDOrder: testDOrder === 'none' ? null : testDOrder,
    testDOffsetMs, testEWriter, testECapture, testEAlternate,
    testEObserveIncoming: testEAlternate || testESchedule.length > 0 } });
  await new Promise((resolve, reject) => {
    worker.on('error', error => { reject(error); for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
    worker.on('message', message => {
      if (message.harnessReady) { resolve(); return; }
      if (message.testEBytes) {
        const sample = message.testEBytes;
        const dir = path.join(out, 'buffers'); fs.mkdirSync(dir, { recursive: true });
        const stem = `sample-${String(fs.readdirSync(dir).filter(name => name.endsWith('.json')).length + 1).padStart(3, '0')}`;
        const ws = Buffer.from(sample.ws);
        fs.writeFileSync(path.join(dir, `${stem}-ws.bin`), ws);
        const units = sample.units.map((value, index) => { const data = Buffer.from(value);
          fs.writeFileSync(path.join(dir, `${stem}-unit-${index + 1}.bin`), data);
          return { bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }; });
        fs.writeFileSync(path.join(dir, `${stem}.json`), JSON.stringify({ run_id: runId,
          ...sample.fields, ws_bytes: ws.length,
          ws_sha256: crypto.createHash('sha256').update(ws).digest('hex'), units }, null, 2));
        return;
      }
      if (message.harnessTrace) { record(message.harnessTrace); return; }
      if (message.event === 'stage1-trace') { record({ stage: message.trace.stage, ts_ms: message.trace.at_ms, ...message.trace.detail }); return; }
      const p = pending.get(message.requestId);
      if (message.event === 'download-chunk') { p?.onChunk?.(message); return; }
      if (message.event === 'prefetch-chunk') { p?.onPrefetchChunk?.(message.progress); return; }
      if (message.event === 'prefetch-terminal') { p?.onPrefetchTerminal?.(message.terminal); return; }
      if (message.event) return;
      if (p) {
        clearTimeout(p.timer); pending.delete(message.requestId);
        if (!message.ok) record({ stage: 'WORKER_RESPONSE_ERROR', request_id: message.requestId, error_code: message.code || null,
          reason: /cancel|abort/i.test(message.error || '') ? 'cancelled' : 'other' });
        message.ok ? p.resolve(message.result) : p.reject(Object.assign(new Error('Worker request failed'), { name: message.code || 'WorkerError' }));
      }
    });
  });
  const input = { ...bound, expected_bot_id: bound.temp_auth.expected_bot_id, temp_api_id: bound.temp_auth.api_id,
    temp_auth_key: imported.authKey, temp_session_id: tempSessionId,
    temp_session_state: imported.sessionState, temp_primary_dcs: imported.primaryDcs };
  try { await request('initialize', { session: input, startupMessageIds: [] }).promise; }
  finally { imported.authKey.fill(0); }
  const identity = { sessionId: bound.session_id, generation: bound.generation, credentialVersion: bound.credential_version };
  const activated = await http('/transport/session/activate', identity);
  await Promise.all([request('verify_identity').promise, request('verify', { membership: activated.membership || null }).promise]);
  heartbeat = setInterval(() => { void http('/transport/session/heartbeat', identity).catch(error => record({ stage: 'HEARTBEAT_ERROR', error_name: error.name })); }, Math.max(5000, bound.heartbeat_interval_ms || 15000));
  heartbeat.unref();
  record({ stage: 'SESSION_SETUP_DONE', transport_id: bound.transport_id, session_tag: crypto.createHash('sha256').update(bound.session_id).digest('hex').slice(0, 12) });
  sessionSetupMs = Math.round((ts() - setupStarted) * 10) / 10;
}
async function decode(bytes) {
  record({ stage: 'CONSUMER_BEGIN', bytes: bytes.length, consumer: 'ffmpeg-pipe-eof' });
  await new Promise((resolve, reject) => {
    const proc = spawn(option('ffmpeg', 'ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0', '-t', '0.1', '-f', 's16le', 'pipe:1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let pcm = 0, errorBytes = 0;
    const timer = setTimeout(() => { proc.kill(); reject(new Error('PCM timeout')); }, 10000);
    proc.on('error', error => { clearTimeout(timer); reject(error); });
    proc.stdout.on('data', data => { if (!pcm) record({ stage: 'DECODED_PCM', pcm_bytes: data.length }); pcm += data.length; });
    proc.stderr.on('data', data => { errorBytes += data.length; });
    proc.stdin.on('error', () => {});
    proc.on('close', code => { clearTimeout(timer); record({ stage: 'CONSUMER_END', exit_code: code, pcm_bytes: pcm, diagnostic_bytes: errorBytes }); code === 0 && pcm > 0 ? resolve() : reject(new Error('No valid decoded PCM')); });
    proc.stdin.end(bytes);
  });
}

async function readStream(input, measure, primary = true, prefix = Buffer.alloc(0)) {
  let bytes = prefix, cancelledForLimit = false, first = true, streamError = null;
  const handle = request('stream', { input: { ...input, offsetBytes: prefix.length, purpose: 'playback' } }, 45000, message => {
    if (primary && first && prefix.length === 0) record({ stage: 'FIRST_BYTES', request_id: message.requestId, bytes: message.chunk.byteLength });
    first = false;
    bytes = Buffer.concat([bytes, Buffer.from(message.chunk)]);
    const measurement = measure(bytes);
    const useful = measurement.completeFrames >= 2;
    if (primary && useful && !events.some(event => event.run_id === runId && event.stage === 'FIRST_USEFUL_RANGE')) record({ stage: 'FIRST_USEFUL_RANGE', bytes: bytes.length, ...measurement });
    const complete = message.downloadedBytes >= message.totalBytes;
    cancelledForLimit = (useful || bytes.length >= 2097152) && !complete;
    void request(cancelledForLimit ? 'cancel' : 'stream_ack', { targetRequestId: message.requestId }).promise.catch(() => {});
  });
  try { await handle.promise; }
  catch (error) { streamError = error; }
  // Only intentional cancellation after useful frames is accepted. Timeouts,
  // transport failures, and empty successful streams remain failed samples.
  if (streamError && !(cancelledForLimit && measure(bytes).completeFrames >= 2 && streamError.name === 'WorkerError')) throw streamError;
  if (first) throw new Error('Stream returned no bytes');
  return bytes;
}

try {
  if (!process.env.STAGE1_COHORT_ID || !process.env.STAGE1_COHORT_PASSWORD) throw new Error('Existing Stage1 credentials required in .env.stage1');
  execFileSync(option('ffmpeg', 'ffmpeg'), ['-version'], { stdio: 'ignore', windowsHide: true });
  summary.git_head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  summary.production_sha256 = Object.fromEntries(['src/features/cloud/webTransport.worker.ts', 'src/features/cloud/playbackGetFileTrace.ts', 'src/features/cloud/webTempAuth.ts'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  summary.harness_sha256 = Object.fromEntries(['scripts/run-playback-direct.mjs', 'tests/playback-direct/worker.mjs', 'tests/playback-direct/report.mjs', 'tests/playback-direct/build.mjs', 'tests/playback-c/instrument.mjs', 'tests/playback-d/instrument.mjs'].map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
  const buildDir = path.join(out, 'build');
  await buildHarness(buildDir);
  const auth = await import(pathToFileURL(path.join(buildDir, 'auth.mjs')));
  const { measureMp3PlayablePrefix } = await import(pathToFileURL(path.join(buildDir, 'mp3.mjs')));
  const login = await http('/auth/login', { identifier: `stage1.${process.env.STAGE1_COHORT_ID}.${account}@beatgaler.test`, password: process.env.STAGE1_COHORT_PASSWORD });
  token = login.token || '';
  let rawMediaPrepared = false;
  for (let i = 1; i <= runs; i++) {
    runId = `setup-${i}`; intentId = null;
    if (!worker || mode === 'cold') await initialize(auth, path.join(buildDir, 'worker.mjs'));
    if (mode === 'test-d-raw' && !rawMediaPrepared) {
      await request('prefetch_batch', { input: { inputs: [96, 101].map(id =>
        ({ messageId: id, mimeType: 'audio/mpeg', offsetBytes: 0 })), maxBytesPerFile: 65536,
        targetPlayableSeconds: Infinity, maxConcurrency: 7 } }, 90000).promise;
      rawMediaPrepared = true;
      if (!events.some(event => event.stage === 'TARGET_IDENTITY' && event.filename_matches))
        throw new Error('Target filename was not verified against Telegram');
    }
    runId = `${mode}-${String(i).padStart(3, '0')}`; intentId = i;
    const row = { run_id: runId, intent_id: i, route, session_setup_ms: sessionSetupMs, status: 'OK' };
    sessionSetupMs = null;
    try {
      if (mode === 'test-d-raw') {
        if (i === testEReconnectBefore) await request('test_e_reconnect', {}, 30000).promise;
        record({ stage: 'START', mode, message_id: 96 });
        let writerMode = testEAlternate ? (i % 2 ? 'shared' : 'fresh') : testEWriter;
        if (testESchedule.length) {
          let remaining = i;
          for (const block of testESchedule) { if (remaining <= block.count) { writerMode = block.writer; break; }
            remaining -= block.count; }
        }
        const cpuBefore = process.cpuUsage();
        const rssBefore = process.memoryUsage().rss;
        const result = await request('test_d_raw_pair', { input: {
          include101: testDInclude101, firstMessageId: testDFirst,
          offsetMs: testDOffsetMs, sequential: testDSequential,
          timing: testETiming, messageIds: testEMessageIds.length ? testEMessageIds : null,
          writerMode } }, testEMessageIds.length >= 7 ? 120000 : testEMessageIds.length >= 3 ? 90000 : 45000).promise;
        const cpu = process.cpuUsage(cpuBefore);
        record({ stage: 'E_RESOURCE', cpu_user_us: cpu.user, cpu_system_us: cpu.system,
          rss_before_bytes: rssBefore, rss_after_bytes: process.memoryUsage().rss });
        record({ stage: 'END', bytes_by_message: result });
        rows.push(summarizeRun(events, row)); save();
        console.log(JSON.stringify(rows.at(-1)));
        await new Promise(resolve => setTimeout(resolve, 300));
        continue;
      }
      const input = { messageId, mimeType: 'audio/mpeg', traceIntentId: i };
      let warm, adoptedPrefix = null;
      if (mode === 'warm-adopt') {
        let resolveTarget, rejectTarget;
        const targetPrefix = new Promise((resolve, reject) => { resolveTarget = resolve; rejectTarget = reject; });
        void targetPrefix.catch(() => {});
        let prefix = Buffer.alloc(0), settled = false;
        const inputs = [input, ...warmMessageIds.filter(id => id !== messageId).map(id => ({ messageId: id, mimeType: 'audio/mpeg', offsetBytes: 0 }))];
        warm = request('prefetch_batch', { input: { inputs, maxBytesPerFile: 65536, targetPlayableSeconds: Infinity, maxConcurrency: 7 } }, testCWarmTimeoutMs, undefined,
          progress => {
            if (progress.messageId !== messageId || settled) return;
            if (Number(progress.offsetBytes) !== prefix.length) { settled = true; rejectTarget(new Error('WARM target prefix has a gap')); return; }
            if (prefix.length === 0) record({ stage: 'FIRST_BYTES', bytes: progress.chunk.byteLength });
            prefix = Buffer.concat([prefix, Buffer.from(progress.chunk)]);
            if (prefix.length >= progress.totalBytes || prefix.length >= 65536) {
              settled = true;
              const measurement = measureMp3PlayablePrefix(prefix);
              if (measurement.completeFrames >= 2) record({ stage: 'FIRST_USEFUL_RANGE', bytes: prefix.length, ...measurement });
              resolveTarget(prefix);
            }
          },
          terminal => { if (terminal.messageId === messageId && terminal.status === 'FAILED' && !settled) { settled = true; rejectTarget(Object.assign(new Error('WARM target failed'), { name: terminal.code || 'WarmError' })); } });
        void warm.promise.then(result => {
          if (settled) return;
          const item = result.results.find(candidate => (candidate.ok ? candidate.result.messageId : candidate.messageId) === messageId);
          settled = true;
          item?.ok ? resolveTarget(Buffer.from(item.result.prefix)) : rejectTarget(new Error('WARM target was unavailable'));
        }, rejectTarget);
        adoptedPrefix = targetPrefix;
        await new Promise(resolve => setTimeout(resolve, warmLeadMs));
      }
      record({ stage: 'START', mode, route, message_id: messageId });
      if (mode === 'warm') {
        warm = request('prefetch_batch', { input: { inputs: [input], maxBytesPerFile: 65536, targetPlayableSeconds: Infinity, maxConcurrency: 7 } }).promise;
        void warm.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await request('playback_focus', { messageId, traceIntentId: i }).promise;
      const foreground = async (primary) => {
        if (route === 'stream') return readStream(input, measureMp3PlayablePrefix, primary);
        const result = await request('prefetch', { input }).promise;
        if (primary) record({ stage: 'FIRST_BYTES', bytes: result.prefix.byteLength });
        return Buffer.from(result.prefix);
      };
      const primary = adoptedPrefix || foreground(true);
      let duplicate;
      if (mode === 'duplicate') { duplicate = foreground(false); void duplicate.catch(() => {}); }
      let bytes = await primary;
      let measurement = measureMp3PlayablePrefix(bytes);
      // If the fixed production prefix cannot hold frames, consume the real
      // stream from its exact offset. This is an observation, not prefix tuning.
      if (measurement.completeFrames < 2) {
        record({ stage: 'PREFIX_NO_USEFUL_FRAMES', ...measurement });
        bytes = await readStream(input, measureMp3PlayablePrefix, true, bytes);
        measurement = measureMp3PlayablePrefix(bytes);
      }
      if (measurement.completeFrames < 2) throw new Error('No useful MPEG frames in bounded sample');
      const target = events.findLast(e => e.stage === 'TARGET_IDENTITY');
      if (!target?.filename_matches) throw new Error('Target filename was not verified against Telegram');
      if (!events.some(event => event.run_id === runId && event.stage === 'FIRST_USEFUL_RANGE')) record({ stage: 'FIRST_USEFUL_RANGE', bytes: bytes.length, ...measurement });
      await decode(bytes);
      if (mode === 'warm-adopt') await request('playback_stable', { messageId, traceIntentId: i }).promise;
      await Promise.all([mode === 'warm-adopt' ? warm?.promise : warm, duplicate]);
      await request('playback_release', { messageId, traceIntentId: i }).promise;
      record({ stage: 'END' });
    } catch (error) {
      row.status = 'ERROR'; row.error_name = error.name; record({ stage: 'RUN_ERROR', error_name: error.name });
      await stopWorker();
      if (mode === 'test-d-raw') rawMediaPrepared = false;
    }
    rows.push(summarizeRun(events, row)); save();
    console.log(JSON.stringify(rows.at(-1)));
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  summary.status = rows.every(row => row.status === 'OK') ? 'COMPLETE' : 'PARTIAL';
} catch (error) {
  summary.status = 'BLOCKED'; summary.error_name = error.name;
  record({ stage: 'HARNESS_ERROR', error_name: error.name });
  console.error(`Harness blocked: ${error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  runId = 'cleanup'; intentId = null;
  await stopWorker();
  if (session) await http('/transport/session/stop', { sessionId: session.session_id, generation: session.generation }).catch(error => record({ stage: 'CLEANUP_ERROR', error_name: error.name }));
  save(); console.info = realInfo;
  console.log(`Results: ${out}`);
}
// Production temp-auth timeout races leave timer handles; all owned network
// resources and evidence have already been closed/flushed above.
process.exit(process.exitCode || (summary.status === 'COMPLETE' ? 0 : 1));
