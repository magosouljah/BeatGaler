import assert from 'node:assert/strict';

// Task 5.1 M0-F live proof only.
//
// Purpose: prove own-message and cross-bot message deletion semantics in one
// explicitly configured disposable Telegram test chat. This probe does not use
// BeatGaler production runtime, vault migration, user files, token rotation or
// revoke. Bot tokens remain only in the GitHub Actions runner environment.

const API_BASE = 'https://api.telegram.org';
const REQUIRED = [
  'BEATGALER_M0_F_BOT_A_TOKEN',
  'BEATGALER_M0_F_BOT_B_TOKEN',
  'BEATGALER_M0_F_CHAT_ID',
];

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required M0-F secret: ${name}`);
  return value;
}

for (const name of REQUIRED) required(name);

const botAToken = required('BEATGALER_M0_F_BOT_A_TOKEN');
const botBToken = required('BEATGALER_M0_F_BOT_B_TOKEN');
const chatId = required('BEATGALER_M0_F_CHAT_ID');
const runMarker = `beatgaler-m0-f-${Date.now()}-${Math.random().toString(16).slice(2)}`;

async function botApi(token, method, body = {}) {
  const response = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const description = payload?.description || `HTTP ${response.status}`;
    throw new Error(`${method} failed: ${description}`);
  }
  return payload.result;
}

async function sendMarker(token, label) {
  return botApi(token, 'sendMessage', {
    chat_id: chatId,
    text: `[BeatGaler isolated M0-F probe] ${runMarker} ${label}`,
    disable_notification: true,
  });
}

async function deleteMessage(token, messageId) {
  const result = await botApi(token, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
  assert.equal(result, true, 'deleteMessage must return true.');
}

async function safeDelete(token, messageId) {
  if (!messageId) return;
  try { await deleteMessage(token, messageId); } catch {}
}

const created = [];

try {
  const [botA, botB] = await Promise.all([
    botApi(botAToken, 'getMe'),
    botApi(botBToken, 'getMe'),
  ]);
  assert.equal(botA?.is_bot, true, 'Bot A token must identify a bot.');
  assert.equal(botB?.is_bot, true, 'Bot B token must identify a bot.');
  assert.notEqual(String(botA.id), String(botB.id), 'M0-F requires two distinct bots.');

  const [memberA, memberB] = await Promise.all([
    botApi(botAToken, 'getChatMember', { chat_id: chatId, user_id: botA.id }),
    botApi(botBToken, 'getChatMember', { chat_id: chatId, user_id: botB.id }),
  ]);
  assert.notEqual(memberA?.status, 'left', 'Bot A must be present in the test chat.');
  assert.notEqual(memberA?.status, 'kicked', 'Bot A must not be banned from the test chat.');
  assert.notEqual(memberB?.status, 'left', 'Bot B must be present in the test chat.');
  assert.notEqual(memberB?.status, 'kicked', 'Bot B must not be banned from the test chat.');

  // Own-delete A.
  const aOwn = await sendMarker(botAToken, 'A-own');
  created.push({ origin: 'A', id: aOwn.message_id });
  await deleteMessage(botAToken, aOwn.message_id);
  created.pop();

  // Own-delete B.
  const bOwn = await sendMarker(botBToken, 'B-own');
  created.push({ origin: 'B', id: bOwn.message_id });
  await deleteMessage(botBToken, bOwn.message_id);
  created.pop();

  // Cross-delete: A deletes B's message.
  const bForA = await sendMarker(botBToken, 'B-cross-deleted-by-A');
  created.push({ origin: 'B', id: bForA.message_id });
  await deleteMessage(botAToken, bForA.message_id);
  created.pop();

  // Cross-delete: B deletes A's message.
  const aForB = await sendMarker(botAToken, 'A-cross-deleted-by-B');
  created.push({ origin: 'A', id: aForB.message_id });
  await deleteMessage(botBToken, aForB.message_id);
  created.pop();

  console.log('PASS M0-F own/cross-bot delete proof');
  console.log(JSON.stringify({
    mode: 'M0-F isolated own/cross-bot delete proof',
    bot_a_id: String(botA.id),
    bot_b_id: String(botB.id),
    distinct_bots_proven: true,
    own_delete_bot_a_proven: true,
    own_delete_bot_b_proven: true,
    cross_delete_a_deletes_b_proven: true,
    cross_delete_b_deletes_a_proven: true,
    same_test_chat_proven: true,
    bot_a_status: memberA.status,
    bot_b_status: memberB.status,
    user_file_bytes: 0,
    galer_cloud_file_bytes: 0,
    vault_migration_used: false,
    token_rotation_or_revoke: false,
    production_runtime_changed: false,
    note: 'Only four disposable text marker messages are created and immediately deleted in the explicitly configured test chat.',
  }));
} finally {
  // Best-effort cleanup only for probe marker messages that survived a failed assertion.
  for (const item of created.reverse()) {
    await safeDelete(item.origin === 'A' ? botAToken : botBToken, item.id);
    await safeDelete(item.origin === 'A' ? botBToken : botAToken, item.id);
  }
}
