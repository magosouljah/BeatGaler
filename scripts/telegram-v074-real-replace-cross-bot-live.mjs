import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REQUIRED = [
  'BEATGALER_M0_F_BOT_A_TOKEN',
  'BEATGALER_M0_F_BOT_B_TOKEN',
  'BEATGALER_M0_F_CHAT_ID',
  'BEATGALER_M0_F_API_BASE',
  'BEATGALER_M0_F_V074_HELPER',
];
const OP_TIMEOUT_MS = 60_000;
const PREWARM_TIMEOUT_MS = 90_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}
for (const name of REQUIRED) required(name);

const tokenA = required('BEATGALER_M0_F_BOT_A_TOKEN');
const tokenB = required('BEATGALER_M0_F_BOT_B_TOKEN');
const chatId = required('BEATGALER_M0_F_CHAT_ID');
const botApiBase = required('BEATGALER_M0_F_API_BASE').replace(/\/$/, '');
const helperPath = path.resolve(required('BEATGALER_M0_F_V074_HELPER'));
const OUT = '__BEATGALER_DIRECT_JSON__';
const BOOT = '__BEATGALER_DIRECT_BOOTSTRAP__';

assert.ok(fs.existsSync(helperPath), `v0.7.4 helper missing: ${helperPath}`);

function phase(name, fields = {}) {
  console.log(JSON.stringify({ event: 'phase', name, at: new Date().toISOString(), ...fields }));
}

async function rawBotApi(token, method, payload = {}, timeoutMs = PREWARM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${botApiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await r.json().catch(() => null);
    if (!r.ok || body?.ok !== true) {
      throw new Error(`${method} failed: ${body?.description || `HTTP ${r.status}`}`);
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function prewarmBot(label, token) {
  phase(`${label}:prewarm:getMe:begin`, { timeout_ms: PREWARM_TIMEOUT_MS });
  const me = await rawBotApi(token, 'getMe');
  phase(`${label}:prewarm:getMe:done`, { bot_id: Number(me?.id || 0) });

  phase(`${label}:prewarm:getChat:begin`, { timeout_ms: PREWARM_TIMEOUT_MS });
  const chat = await rawBotApi(token, 'getChat', { chat_id: chatId });
  phase(`${label}:prewarm:getChat:done`, {
    resolved_chat_id: String(chat?.id || ''),
    chat_type: String(chat?.type || ''),
  });
}

class HelperSession {
  constructor(label, token) {
    this.label = label;
    this.pending = new Map();
    this.buffer = '';
    this.closed = false;
    this.child = spawn(process.execPath, [helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => process.stderr.write(`[${label}:stderr] ${chunk}`));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.#onStdout(chunk));
    this.child.on('exit', (code, signal) => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${label} helper exited code=${code} signal=${signal}`));
      }
      this.pending.clear();
    });

    const bootstrap = {
      session_id: `m0f-v074-${label}-${Date.now()}`,
      transport_id: `m0f-v074-${label}`,
      bot_token: token,
      chat_id: chatId,
      bot_api_base: botApiBase,
    };
    this.child.stdin.write(`${BOOT}${Buffer.from(JSON.stringify(bootstrap)).toString('base64')}\n`);
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.startsWith(OUT)) continue;
      let payload;
      try { payload = JSON.parse(line.slice(OUT.length)); }
      catch { continue; }
      const id = payload?.request_id;
      if (!id || !this.pending.has(id)) continue;
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      if (payload.ok === false) waiter.reject(new Error(String(payload.error || 'helper operation failed')));
      else waiter.resolve(payload);
    }
  }

  request(op, extra = {}, timeoutMs = OP_TIMEOUT_MS) {
    if (this.closed || this.child.killed) return Promise.reject(new Error(`${this.label} helper is not running`));
    const requestId = `${this.label}-${op}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    phase(`${this.label}:${op}:begin`, { request_id: requestId, timeout_ms: timeoutMs });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        phase(`${this.label}:${op}:timeout`, { request_id: requestId, timeout_ms: timeoutMs });
        reject(new Error(`${this.label} ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, {
        timer,
        resolve: value => {
          phase(`${this.label}:${op}:done`, { request_id: requestId });
          resolve(value);
        },
        reject,
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ request_id: requestId, op, ...extra })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async close() {
    if (this.closed) return;
    try { await this.request('shutdown', {}, SHUTDOWN_TIMEOUT_MS); } catch (error) {
      phase(`${this.label}:shutdown:forced`, { reason: String(error?.message || error) });
    }
    try { this.child.stdin.end(); } catch {}
    if (!this.closed) {
      try { this.child.kill('SIGKILL'); } catch {}
    }
  }
}

async function rawDelete(token, messageId, timeoutMs = OP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${botApiBase}/bot${token}/deleteMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      signal: controller.signal,
    });
    const body = await r.json().catch(() => null);
    return { http_ok: r.ok, ok: body?.ok === true, result: body?.result, description: body?.description || null };
  } finally {
    clearTimeout(timer);
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beatgaler-m0f-v074-'));
const oldPath = path.join(dir, 'slot-old.bin');
const newPath = path.join(dir, 'slot-new.bin');
fs.writeFileSync(oldPath, Buffer.from(`BeatGaler v0.7.4 M0-F OLD ${Date.now()}\n`));
fs.writeFileSync(newPath, Buffer.from(`BeatGaler v0.7.4 M0-F NEW ${Date.now()}\n`));

let a;
let b;
let oldMessageId = 0;
let newMessageId = 0;
try {
  phase('prewarm:start');
  await prewarmBot('A', tokenA);
  await prewarmBot('B', tokenB);
  phase('prewarm:done');

  phase('session-a:start');
  a = new HelperSession('A', tokenA);
  const oldUpload = await a.request('upload', {
    path: oldPath,
    filename: 'm0f-v074-slot-old.bin',
    caption: '[BeatGaler M0-F] v0.7.4 real helper old slot',
  });
  oldMessageId = Number(oldUpload.message_id || 0);
  assert.ok(Number.isInteger(oldMessageId) && oldMessageId > 0, 'Session A upload must return message_id.');
  console.log(JSON.stringify({ event: 'v074-session-a-upload', message_id: oldMessageId, api_base: botApiBase }));
  phase('session-a:close');
  await a.close();
  a = null;

  phase('session-b:start');
  b = new HelperSession('B', tokenB);
  const newUpload = await b.request('upload', {
    path: newPath,
    filename: 'm0f-v074-slot-new.bin',
    caption: '[BeatGaler M0-F] v0.7.4 real helper replacement slot',
  });
  newMessageId = Number(newUpload.message_id || 0);
  assert.ok(Number.isInteger(newMessageId) && newMessageId > 0, 'Session B upload must return message_id.');
  console.log(JSON.stringify({ event: 'v074-session-b-replacement-upload', message_id: newMessageId, previous_message_id: oldMessageId }));

  phase('session-b:delete-old', { previous_message_id: oldMessageId });
  const deletion = await b.request('delete_messages', { message_ids: [oldMessageId] });
  console.log(JSON.stringify({ event: 'v074-session-b-delete-old-via-helper', previous_message_id: oldMessageId, helper_result: deletion }));

  phase('verify-origin-delete', { previous_message_id: oldMessageId });
  const verification = await rawDelete(tokenA, oldMessageId);
  console.log(JSON.stringify({ event: 'verify-old-message-after-b-delete', previous_message_id: oldMessageId, a_delete_after_b: verification }));

  const deletedCount = Number(deletion.deleted || 0);
  const errors = Array.isArray(deletion.errors) ? deletion.errors : [];
  const helperClaimsCrossDelete = deletedCount === 1 && errors.length === 0;
  const oldGoneForOriginBot = verification.ok === false && /message to delete not found/i.test(String(verification.description || ''));

  console.log(JSON.stringify({
    mode: 'M0-F v0.7.4 exact helper replacement proof',
    old_message_id: oldMessageId,
    replacement_message_id: newMessageId,
    session_a_uploaded_old: true,
    session_b_uploaded_replacement: true,
    session_b_helper_cross_delete_claimed: helperClaimsCrossDelete,
    old_message_gone_for_origin_bot_after_b_delete: oldGoneForOriginBot,
    same_helper_as_galer_cloud_v0_7_4: true,
    same_local_bot_api_mode: true,
    user_file_bytes: fs.statSync(oldPath).size + fs.statSync(newPath).size,
    galer_cloud_file_bytes: 0,
    token_rotation_or_revoke: false,
    production_runtime_changed: false,
  }));

  assert.equal(helperClaimsCrossDelete, true, `v0.7.4 helper did not report cross-bot deletion: ${JSON.stringify(deletion)}`);
  assert.equal(oldGoneForOriginBot, true, `Origin bot could still delete old message after Bot B cleanup: ${JSON.stringify(verification)}`);
  console.log('PASS M0-F v0.7.4 exact helper cross-bot replacement proof');
} finally {
  phase('cleanup:start');
  if (a) await a.close().catch(() => {});
  if (b) {
    if (newMessageId > 0) await b.request('delete_messages', { message_ids: [newMessageId] }, 10_000).catch(() => {});
    await b.close().catch(() => {});
  }
  if (oldMessageId > 0) await rawDelete(tokenA, oldMessageId, 10_000).catch(() => {});
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  phase('cleanup:done');
}
