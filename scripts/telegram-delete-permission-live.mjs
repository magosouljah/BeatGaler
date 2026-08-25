import assert from 'node:assert/strict';

const required = name => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required M0-F secret: ${name}`);
  return value;
};

const chatId = required('BEATGALER_M0_F_CHAT_ID');
const botAToken = required('BEATGALER_M0_B2_BOT_TOKEN');
const botBToken = required('BEATGALER_M0_F_BOT_B_TOKEN');

async function botApi(token, method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { http: response.status, ...body };
}

function assertOk(result, label) {
  assert.equal(result?.ok, true, `${label} failed: ${result?.description || result?.http || 'unknown error'}`);
  return result.result;
}

const meA = assertOk(await botApi(botAToken, 'getMe'), 'bot A getMe');
const meB = assertOk(await botApi(botBToken, 'getMe'), 'bot B getMe');
assert.notEqual(String(meA.id), String(meB.id), 'M0-F requires two distinct bot identities.');

const memberAResult = await botApi(botAToken, 'getChatMember', { chat_id: chatId, user_id: meA.id });
if (memberAResult.ok !== true) {
  console.log('SKIP M0-F Bot API positive proof: bot A intentionally starts outside the group for the private-vault MTProto learn probe.');
  console.log(JSON.stringify({
    bot_api_positive_probe_skipped_for_mtproto_join_order: true,
    production_runtime_changed: false,
    token_rotation_or_revoke: false,
  }));
  process.exit(0);
}

const memberA = memberAResult.result;
const memberB = assertOk(await botApi(botBToken, 'getChatMember', { chat_id: chatId, user_id: meB.id }), 'bot B membership');
if (!['administrator', 'creator'].includes(String(memberA.status))) {
  console.log('SKIP M0-F Bot API positive proof: bot A is not yet admin because the MTProto-first join-order probe is active.');
  process.exit(0);
}
assert.equal(memberA.can_delete_messages, true, 'Bot A must have can_delete_messages=true.');
assert.equal(['administrator', 'creator'].includes(String(memberB.status)), false, 'Bot B must remain a plain member.');

const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let messageId = 0;
let deletedByA = false;
try {
  const msg = assertOk(await botApi(botBToken, 'sendMessage', {
    chat_id: chatId,
    text: `BeatGaler M0-F positive cross-bot delete ${nonce}`,
    disable_notification: true,
  }), 'bot B sendMessage');
  messageId = Number(msg.message_id || 0);
  assert.ok(messageId > 0, 'Bot B message id is missing.');

  const crossDelete = await botApi(botAToken, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  assert.equal(crossDelete.ok, true, `Admin bot A with delete_messages must delete bot B message: ${crossDelete.description || crossDelete.http}`);
  deletedByA = true;

  console.log('PASS M0-F positive cross-bot delete proof');
  console.log(JSON.stringify({
    mode: 'M0-F positive cross-bot delete permission proof',
    cross_bot_delete_with_stable_admin_proven: true,
    bot_a_admin: true,
    bot_a_can_delete_messages: true,
    bot_b_admin: false,
    message_author_is_other_bot: true,
    user_vault_used: false,
    file_bytes_used: false,
    permission_churn_used: false,
    token_rotation_or_revoke: false,
    production_runtime_changed: false,
    over_48h_proven: false,
    mtproto_delete_proven: false,
    next_gate: 'Prove the same cross-bot delete through MTProto channels.deleteMessages; separately retain >48h historical proof as pending.',
  }));
} finally {
  if (messageId > 0 && !deletedByA) {
    await botApi(botBToken, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
  }
}
