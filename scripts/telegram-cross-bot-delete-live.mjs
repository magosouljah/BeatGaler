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

async function sendMarker(token, actor, label) {
  const message = await botApi(token, 'sendMessage', {
    chat_id: chatId,
    text: `[BeatGaler isolated M0-F probe] ${runMarker} ${label}`,
    disable_notification: true,
  });
  console.log(JSON.stringify({
    event: 'sendMessage',
    actor,
    label,
    requested_chat_id: String(chatId),
    returned_chat_id: String(message?.chat?.id),
    message_id: message?.message_id,
    sender_bot_id: String(message?.from?.id),
  }));
  assert.equal(String(message?.chat?.id), String(chatId), `${actor} sendMessage must return the configured test chat.`);
  assert.ok(Number.isInteger(message?.message_id), `${actor} sendMessage must return an integer message_id.`);
  return message;
}

async function deleteMessage(token, actor, origin, message) {
  console.log(JSON.stringify({
    event: 'deleteMessage-attempt',
    actor,
    origin,
    requested_chat_id: String(chatId),
    source_chat_id: String(message?.chat?.id),
    message_id: message?.message_id,
    source_sender_bot_id: String(message?.from?.id),
  }));
  try {
    const result = await botApi(token, 'deleteMessage', {
      chat_id: chatId,
      message_id: message.message_id,
    });
    console.log(JSON.stringify({
      event: 'deleteMessage-result',
      actor,
      origin,
      message_id: message.message_id,
      deleted: result,
    }));
    assert.equal(result, true, 'deleteMessage must return true.');
  } catch (error) {
    console.error(JSON.stringify({
      event: 'deleteMessage-error',
      actor,
      origin,
      requested_chat_id: String(chatId),
      source_chat_id: String(message?.chat?.id),
      message_id: message?.message_id,
      source_sender_bot_id: String(message?.from?.id),
      error: String(error?.message || error),
    }));
    throw error;
  }
}

async function safeDelete(token, actor, origin, message) {
  if (!message?.message_id) return;
  try { await deleteMessage(token, actor, origin, message); } catch {}
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

  const [memberA, memberB, chatA, chatB] = await Promise.all([
    botApi(botAToken, 'getChatMember', { chat_id: chatId, user_id: botA.id }),
    botApi(botBToken, 'getChatMember', { chat_id: chatId, user_id: botB.id }),
    botApi(botAToken, 'getChat', { chat_id: chatId }),
    botApi(botBToken, 'getChat', { chat_id: chatId }),
  ]);
  assert.notEqual(memberA?.status, 'left', 'Bot A must be present in the test chat.');
  assert.notEqual(memberA?.status, 'kicked', 'Bot A must not be banned from the test chat.');
  assert.notEqual(memberB?.status, 'left', 'Bot B must be present in the test chat.');
  assert.notEqual(memberB?.status, 'kicked', 'Bot B must not be banned from the test chat.');
  assert.equal(String(chatA?.id), String(chatId), 'Bot A must resolve the configured test chat id.');
  assert.equal(String(chatB?.id), String(chatId), 'Bot B must resolve the configured test chat id.');

  console.log(JSON.stringify({
    event: 'preflight',
    configured_chat_id: String(chatId),
    bot_a_id: String(botA.id),
    bot_b_id: String(botB.id),
    bot_a_status: memberA.status,
    bot_b_status: memberB.status,
    bot_a_can_delete_messages: memberA.can_delete_messages ?? null,
    bot_b_can_delete_messages: memberB.can_delete_messages ?? null,
    bot_a_resolved_chat_id: String(chatA.id),
    bot_b_resolved_chat_id: String(chatB.id),
  }));

  // Own-delete A.
  const aOwn = await sendMarker(botAToken, 'A', 'A-own');
  created.push({ origin: 'A', message: aOwn });
  await deleteMessage(botAToken, 'A', 'A', aOwn);
  created.pop();

  // Own-delete B.
  const bOwn = await sendMarker(botBToken, 'B', 'B-own');
  created.push({ origin: 'B', message: bOwn });
  await deleteMessage(botBToken, 'B', 'B', bOwn);
  created.pop();

  // Cross-delete: A deletes B's message.
  const bForA = await sendMarker(botBToken, 'B', 'B-cross-deleted-by-A');
  created.push({ origin: 'B', message: bForA });
  await deleteMessage(botAToken, 'A', 'B', bForA);
  created.pop();

  // Cross-delete: B deletes A's message.
  const aForB = await sendMarker(botAToken, 'A', 'A-cross-deleted-by-B');
  created.push({ origin: 'A', message: aForB });
  await deleteMessage(botBToken, 'B', 'A', aForB);
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
    bot_a_can_delete_messages: memberA.can_delete_messages ?? null,
    bot_b_can_delete_messages: memberB.can_delete_messages ?? null,
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
    await safeDelete(item.origin === 'A' ? botAToken : botBToken, item.origin, item.origin, item.message);
    await safeDelete(item.origin === 'A' ? botBToken : botAToken, item.origin === 'A' ? 'B' : 'A', item.origin, item.message);
  }
}
