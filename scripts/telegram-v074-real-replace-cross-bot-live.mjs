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

class HelperSession {
  constructor(label, token) {
    this.label = label;
    this.pending = new Map();
    this.buffer = '';
    this.child = spawn(process.execPath, [helperPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => process.stderr.write(`[${label}:stderr] ${chunk}`));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.#onStdout(chunk));
    this.child.on('exit', (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new Error(`${label} helper exited code=${code} signal=${signal}`));
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
      if (payload.ok === false) waiter.reject(new Error(String(payload.error || 'helper operation failed')));
      else waiter.resolve(payload);
    }
  }

  request(op, extra = {}) {
    const requestId = `${this.label}-${op}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const promise = new Promise((resolve, reject) => this.pending.set(requestId, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ request_id: requestId, op, ...extra })}\n`);
    return promise;
  }

  async close() {
    try { await this.request('shutdown'); } catch {}
    try { this.child.stdin.end(); } catch {}
  }
}

async function rawDelete(token, messageId) {
  const r = await fetch(`${botApiBase}/bot${token}/deleteMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  const body = await r.json().catch(() => null);
  return { http_ok: r.ok, ok: body?.ok === true, result: body?.result, description: body?.description || null };
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
  // Session A: exact v0.7.4 helper uploads the original slot payload.
  a = new HelperSession('A', tokenA);
  const oldUpload = await a.request('upload', {
    path: oldPath,
    filename: 'm0f-v074-slot-old.bin',
    caption: '[BeatGaler M0-F] v0.7.4 real helper old slot',
  });
  oldMessageId = Number(oldUpload.message_id || 0);
  assert.ok(Number.isInteger(oldMessageId) && oldMessageId > 0, 'Session A upload must return message_id.');
  console.log(JSON.stringify({ event: 'v074-session-a-upload', message_id: oldMessageId, api_base: botApiBase }));
  await a.close();
  a = null;

  // Session B: exact v0.7.4 helper uploads the replacement, then executes the
  // exact delete_messages operation used by BeatGaler cleanup for obsolete media.
  b = new HelperSession('B', tokenB);
  const newUpload = await b.request('upload', {
    path: newPath,
    filename: 'm0f-v074-slot-new.bin',
    caption: '[BeatGaler M0-F] v0.7.4 real helper replacement slot',
  });
  newMessageId = Number(newUpload.message_id || 0);
  assert.ok(Number.isInteger(newMessageId) && newMessageId > 0, 'Session B upload must return message_id.');
  console.log(JSON.stringify({ event: 'v074-session-b-replacement-upload', message_id: newMessageId, previous_message_id: oldMessageId }));

  const deletion = await b.request('delete_messages', { message_ids: [oldMessageId] });
  console.log(JSON.stringify({ event: 'v074-session-b-delete-old-via-helper', previous_message_id: oldMessageId, helper_result: deletion }));

  // Independent verification: if B really deleted A's old message, A must no
  // longer be able to delete that same server message. If B failed silently,
  // A's own-token delete would still return true here.
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
  if (a) await a.close().catch(() => {});
  if (b) {
    if (newMessageId > 0) await b.request('delete_messages', { message_ids: [newMessageId] }).catch(() => {});
    await b.close().catch(() => {});
  }
  if (oldMessageId > 0) await rawDelete(tokenA, oldMessageId).catch(() => {});
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
