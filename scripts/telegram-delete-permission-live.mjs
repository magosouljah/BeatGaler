import assert from 'node:assert/strict';

// Task 5.1 M0-F permission probe only.
// Uses an isolated non-user supergroup with two dedicated bots.
// It does not alter product runtime, vaults, files, roles, tokens or sessions.

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

const memberA = assertOk(await botApi(botAToken, 'getChatMember', { chat_id: chatId, user_id: meA.id }), 'bot A membership');
const memberB = assertOk(await botApi(botBToken, 'getChatMember', { chat_id: chatId, user_id: meB.id }), 'bot B membership');
const privilegedStatuses = new Set(['administrator', 'creator']);
assert.equal(privilegedStatuses.has(String(memberA.status)), false, 'Bot A must be a plain member; otherwise cross-bot denial is not meaningful.');
assert.equal(privilegedStatuses.has(String(memberB.status)), false, 'Bot B must be a plain member for the isolated baseline probe.');

const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let ownMessageId = 0;
let otherMessageId = 0;
let ownDeleted = false;
let otherDeletedByB = false;

try {
  const ownMessage = assertOk(await botApi(botAToken, 'sendMessage', {
    chat_id: chatId,
    text: `BeatGaler M0-F own-delete probe ${nonce}`,
    disable_notification: true,
  }), 'bot A sendMessage');
  ownMessageId = Number(ownMessage.message_id || 0);
  assert.ok(ownMessageId > 0, 'Bot A message id is missing.');

  const otherMessage = assertOk(await botApi(botBToken, 'sendMessage', {
    chat_id: chatId,
    text: `BeatGaler M0-F cross-delete probe ${nonce}`,
    disable_notification: true,
  }), 'bot B sendMessage');
  otherMessageId = Number(otherMessage.message_id || 0);
  assert.ok(otherMessageId > 0, 'Bot B message id is missing.');

  const ownDelete = await botApi(botAToken, 'deleteMessage', { chat_id: chatId, message_id: ownMessageId });
  assert.equal(ownDelete.ok, true, `Plain-member bot must delete its own outgoing message: ${ownDelete.description || ownDelete.http}`);
  ownDeleted = true;

  const crossDelete = await botApi(botAToken, 'deleteMessage', { chat_id: chatId, message_id: otherMessageId });
  assert.equal(crossDelete.ok, false, 'Plain-member bot unexpectedly deleted another bot message; isolated baseline assumptions changed.');
  assert.match(String(crossDelete.description || ''), /delete|rights|administrator|not enough|forbidden/i, 'Cross-bot denial did not look permission-related.');

  console.log('PASS M0-F delete permission proof: plain-member bot deletes own message but cannot delete another bot message');
  console.log(JSON.stringify({
    mode: 'M0-F isolated two-bot delete permission proof',
    own_delete_without_admin_proven: true,
    cross_bot_delete_without_admin_denied: true,
    bot_a_admin: false,
    bot_b_admin: false,
    user_vault_used: false,
    file_bytes_used: false,
    permission_churn_used: false,
    token_rotation_or_revoke: false,
    production_runtime_changed: false,
    next_gate: 'Decide whether runtime can enforce uploader-owned cleanup; otherwise cross-bot deletion requires a stable privileged baseline and separate positive proof.',
  }));
} finally {
  if (ownMessageId > 0 && !ownDeleted) await botApi(botAToken, 'deleteMessage', { chat_id: chatId, message_id: ownMessageId }).catch(() => {});
  if (otherMessageId > 0 && !otherDeletedByB) {
    const cleanup = await botApi(botBToken, 'deleteMessage', { chat_id: chatId, message_id: otherMessageId }).catch(() => null);
    otherDeletedByB = cleanup?.ok === true;
  }
}
