import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { remote } from 'webdriverio';
import { buildHarness, root } from '../tests/playback-direct/build.mjs';
import { summarize, metrics, csv, markdown } from '../tests/playback-b/report.mjs';

function option(name, fallback) { const at = process.argv.indexOf(`--${name}`); return at < 0 ? fallback : process.argv[at + 1]; }
if (process.argv.includes('--help')) {
  console.log('node scripts/run-playback-b.mjs [--runs 20] [--mode source-cold|repeat|warm|cold|index|overlap] [--warm-message-ids 101] [--warm-lead-ms 10] [--mime audio/mpeg] [--out directory]\nRequires .env.stage1, Cloud/PostgreSQL, Chrome and WebdriverIO. Target is account 03 / message 96. Runs real browser worker, source manager, MSE and audio; no React.');
  process.exit(0);
}
const runs = Number(option('runs', '20'));
const mode = option('mode', 'source-cold');
const warmMessageIds = String(option('warm-message-ids', '')).split(',').filter(Boolean).map(Number);
const warmLeadMs = Number(option('warm-lead-ms', '10'));
const mimeType = option('mime', 'audio/mpeg');
if (!Number.isInteger(runs) || runs < 1 || runs > 100 || !['source-cold', 'repeat', 'warm', 'cold', 'index', 'overlap'].includes(mode) || !Number.isFinite(warmLeadMs) || warmLeadMs < 0 || warmMessageIds.some(id => !Number.isSafeInteger(id) || id < 1) || !/^audio\/[a-z0-9.+-]{1,40}$/i.test(mimeType)) throw new Error('Invalid arguments; see --help');
const experimentId = `test-b-${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}`;
const out = path.resolve(root, option('out', `tmp/playback-harness/${experimentId}`));
fs.mkdirSync(out, { recursive: true });
if (fs.existsSync(path.join(out, 'trace.jsonl'))) throw new Error('Output directory already has a trace');
if (fs.existsSync(path.join(root, '.env.stage1'))) process.loadEnvFile(path.join(root, '.env.stage1'));
if (!process.env.STAGE1_COHORT_ID || !process.env.STAGE1_COHORT_PASSWORD) throw new Error('Existing Stage1 credentials required');
const cloud = String(process.env.STAGE1_CLOUD_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
const installation = `playback-b-${crypto.randomUUID()}`;
let token = '', cookie = '', csrf = '', browser = null, vite = null, lastSession = null;
let activeRun = 'setup', activeIntent = null;
const events = [], rows = [];
const ts = () => performance.timeOrigin + performance.now();
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/auth_key|access.?hash|cookie|token|binding|salt|vault_chat_id|channel_id|user_id|bot_id|session_id|error_message/i.test(key)).map(([key, item]) => [key, sanitize(item)]));
}
function record(event) {
  const row = sanitize({ run_id: activeRun, intent_id: activeIntent, ts_ms: ts(), ...event });
  events.push(row);
  fs.appendFileSync(path.join(out, 'trace.jsonl'), JSON.stringify(row) + '\n');
}
const originalInfo = console.info;
console.info = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[play-trace] ')) {
    try { record(JSON.parse(args[0].slice(13))); } catch { /* Observation only. */ }
    return;
  }
  originalInfo(...args);
};
function takeBrowserEvents(items) { for (const item of items || []) record(item); }
async function http(route, body = {}) {
  const start = ts(); record({ stage: 'CONTROL_BEGIN', route });
  const response = await fetch(cloud + route, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-BeatGaler-Client': 'web',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-BeatGaler-CSRF': csrf } : {}),
  }, body: JSON.stringify({ ...body, beatgalerUserId: installation }), signal: AbortSignal.timeout(90000) });
  const payload = await response.json();
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
  if (payload.csrf_token) csrf = payload.csrf_token;
  record({ stage: 'CONTROL_END', route, status: response.status, elapsed_ms: ts() - start });
  if (!response.ok) throw Object.assign(new Error(`Control HTTP ${response.status}: ${route}: ${String(payload.code || payload.error || 'unknown').slice(0, 180)}`), { name: 'ControlError' });
  return payload;
}
async function createSession(auth) {
  record({ stage: 'SESSION_SETUP_BEGIN' });
  const bootstrap = await http('/transport/session/start', { browserClientId: installation });
  let bound, imported, tempSessionId;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let prepared;
    try {
      record({ stage: 'SESSION_TEMP_AUTH_ATTEMPT', attempt });
      prepared = await auth.prepareWebTempAuth(bootstrap.temp_auth.dc_id);
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
  const input = { ...bound, temp_auth_key: Array.from(imported.authKey), temp_session_id: tempSessionId,
    temp_session_state: imported.sessionState, temp_primary_dcs: imported.primaryDcs };
  imported.authKey.fill(0);
  record({ stage: 'SESSION_AUTH_BOUND', dc_id: bootstrap.temp_auth.dc_id,
    transport_tag: crypto.createHash('sha256').update(String(bound.transport_id)).digest('hex').slice(0, 12),
    session_tag: crypto.createHash('sha256').update(String(bound.session_id)).digest('hex').slice(0, 12) });
  lastSession = bound;
  return input;
}
async function activate(session) {
  return http('/transport/session/activate', { sessionId: session.session_id, generation: session.generation, credentialVersion: session.credential_version });
}
async function browserCall(method, input) {
  return browser.executeAsync(async (name, argument, done) => {
    try {
      const module = await import('/tests/playback-b/browser.ts');
      done({ ok: true, result: await module[name](argument) });
    } catch (error) { done({ ok: false, error_name: error?.name || 'unknown', message: String(error?.message || error) }); }
  }, method, input);
}
function check(result, operation) {
  if (!result.ok) throw Object.assign(new Error(`${operation}: ${result.message}`), { name: result.error_name });
  return result.result;
}
const summary = { schema_version: 1, experiment_id: experimentId, target: { account: '03', message_id: 96, filename: 'Stage1 Playback v2 03.mp3' }, mode, mime_type: mimeType, requested_runs: runs, warm_message_ids: warmMessageIds, rows, status: 'RUNNING',
  limits: ['Headless Chrome is muted with autoplay enabled; currentTime proves browser playback progress, not audible speaker output.', 'No React, IntersectionObserver, startup coordinator or full INDEX unless explicitly represented by competing warm IDs.', 'Session binding uses the real control plane and temp auth but runs in Node before passing session to the production browser worker.', 'Browser test transport delegates to production WebTransportWorkerClient and keeps peer verified; WebGalerCloudTransport controller is not loaded.'] };
function save() {
  fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ ...summary, metrics: metrics(rows) }, null, 2));
  fs.writeFileSync(path.join(out, 'runs.csv'), csv(rows));
  fs.writeFileSync(path.join(out, 'report.md'), markdown(summary, events));
}
try {
  const buildDir = path.join(out, 'build');
  await buildHarness(buildDir);
  const auth = await import(pathToFileURL(path.join(buildDir, 'auth.mjs')));
  const login = await http('/auth/login', { identifier: `stage1.${process.env.STAGE1_COHORT_ID}.03@beatgaler.test`, password: process.env.STAGE1_COHORT_PASSWORD });
  token = login.token || '';
  vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'web', '--host', '127.0.0.1', '--port', '4188', '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { ready = (await fetch('http://127.0.0.1:4188/package.json', { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    if (vite.exitCode !== null) throw new Error('Vite exited before browser startup');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('Vite did not become ready');
  browser = await remote({ logLevel: 'error', capabilities: { browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] } } });
  await browser.url('http://127.0.0.1:4188/package.json');
  await browser.setTimeout({ script: 95000 });
  let prepared = false;
  let identityVerified = false;
  for (let index = 1; index <= runs; index++) {
    activeRun = `${mode}-${String(index).padStart(3, '0')}`; activeIntent = index;
    const runStart = ts();
    record({ stage: 'INTENT_BEGIN', session_state: prepared && mode !== 'cold' ? 'ready' : 'new', peer_state: prepared && mode !== 'cold' ? 'ready' : 'unknown' });
    try {
      if (!prepared || mode === 'cold') {
        if (prepared) takeBrowserEvents(check(await browserCall('close'), 'browser close'));
        identityVerified = false;
        const session = await createSession(auth);
        const result = check(await browserCall('setup', { session, run_id: activeRun }), 'browser setup');
        takeBrowserEvents(result.events);
        const activation = await activate(session);
        record({ stage: 'SESSION_ACTIVE' });
        const verification = check(await browserCall('verify', { membership: activation.membership || null }), 'browser peer verify');
        takeBrowserEvents(verification.events);
        prepared = true;
      }
      const result = check(await browserCall('run', { run_id: activeRun, intent_id: index, mode: mode === 'cold' ? 'source-cold' : mode, mime_type: mimeType, warm_message_ids: warmMessageIds, warm_lead_ms: warmLeadMs, timeout_ms: 45000 }), 'browser run');
      takeBrowserEvents(result.events);
      if (result.status !== 'OK') throw Object.assign(new Error('Browser playback failed'), { name: result.error_name || 'BrowserRunError' });
      const identity = events.findLast(event => event.run_id === activeRun && event.stage === 'TARGET_IDENTITY');
      if (identity && identity.filename_matches === false) throw new Error('Telegram target filename mismatch');
      if (identity?.filename_matches === true) identityVerified = true;
      if (!identityVerified) throw new Error('Telegram target filename was not verified');
      record({ stage: 'RUN_DONE', elapsed_ms: ts() - runStart });
    } catch (error) {
      record({ stage: 'RUN_ERROR', error_name: error.name || 'unknown' });
      prepared = false;
    }
    const row = summarize(events.filter(event => event.run_id === activeRun), { run_id: activeRun, intent_id: index, mode });
    rows.push(row); save(); console.log(JSON.stringify(row));
    if (mode === 'cold' && prepared) {
      takeBrowserEvents(check(await browserCall('close'), 'browser close'));
      prepared = false;
      if (lastSession) {
        await http('/transport/session/stop', { sessionId: lastSession.session_id, generation: lastSession.generation }).catch(() => {});
        lastSession = null;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  summary.status = rows.every(row => row.status === 'OK') ? 'COMPLETE' : 'PARTIAL';
} catch (error) {
  summary.status = 'BLOCKED'; summary.error_name = error.name || 'unknown';
  record({ stage: 'HARNESS_ERROR', error_name: summary.error_name });
  console.error(`Test B blocked: ${error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (browser) {
    try { const closed = await browserCall('close'); if (closed.ok) takeBrowserEvents(closed.result); } catch {}
    await browser.deleteSession().catch(() => {});
  }
  if (vite) vite.kill();
  if (lastSession) await http('/transport/session/stop', { sessionId: lastSession.session_id, generation: lastSession.generation }).catch(() => {});
  save(); console.log(`Results: ${out}`);
}
process.exit(process.exitCode || (summary.status === 'COMPLETE' ? 0 : 1));
