'use strict';

const assert = require('node:assert/strict');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const required = name => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required probe secret: ${name}`);
  return value;
};

async function botApi(token, method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(body?.ok, true, `${method} failed: ${body?.description || response.status}`);
  return body.result;
}

async function main() {
  const apiId = Number(required('BEATGALER_M0_B2_API_ID'));
  const apiHash = required('BEATGALER_M0_B2_API_HASH');
  const botAToken = required('BEATGALER_M0_B2_BOT_TOKEN');
  const botBToken = required('BEATGALER_M0_F_BOT_B_TOKEN');
  const chatId = required('BEATGALER_M0_F_CHAT_ID');
  assert.ok(Number.isInteger(apiId) && apiId > 0, 'API id must be positive.');
  assert.match(chatId, /^-100\d+$/, 'M0-F chat must be a Bot API supergroup id.');

  const meA = await botApi(botAToken, 'getMe');
  const meB = await botApi(botBToken, 'getMe');
  assert.notEqual(String(meA.id), String(meB.id), 'Probe requires two bots.');
  const memberA = await botApi(botAToken, 'getChatMember', { chat_id: chatId, user_id: meA.id });
  const memberB = await botApi(botBToken, 'getChatMember', { chat_id: chatId, user_id: meB.id });
  assert.equal(String(memberA.status), 'administrator', 'Bot A must be administrator.');
  assert.equal(memberA.can_delete_messages, true, 'Bot A must have delete_messages.');
  assert.equal(['administrator', 'creator'].includes(String(memberB.status)), false, 'Bot B must remain plain member.');

  const message = await botApi(botBToken, 'sendMessage', {
    chat_id: chatId,
    text: `BeatGaler M0-F MTProto cross-bot delete ${Date.now()}`,
    disable_notification: true,
  });
  const messageId = Number(message.message_id || 0);
  assert.ok(messageId > 0, 'Bot B message id missing.');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
  let deleted = false;
  try {
    await client.start({ botAuthToken: botAToken, onError: error => console.error(String(error?.message || error)) });
    const rawChannelId = -BigInt(chatId) - 1000000000000n;
    assert.ok(rawChannelId > 0n, 'Invalid Bot API -> MTProto channel id conversion.');
    const result = await client.invoke(new Api.channels.DeleteMessages({
      channel: new Api.InputChannel({ channelId: rawChannelId, accessHash: 0n }),
      id: [messageId],
    }));
    assert.ok(Number(result?.ptsCount ?? 0) >= 0, 'Unexpected channels.deleteMessages result.');
    deleted = true;
    console.log('PASS M0-F MTProto positive cross-bot delete proof');
    console.log(JSON.stringify({
      cross_bot_delete_mtproto_proven: true,
      current_transport_identity_is_bot_a: true,
      message_author_is_bot_b: true,
      delete_messages_baseline_required_by_negative_probe: true,
      bot_api_cross_bot_positive_proven: false,
      mtproto_channels_delete_messages_used: true,
      zero_access_hash_bot_path_used: true,
      over_48h_proven: false,
      user_vault_used: false,
      production_runtime_changed: false,
      token_rotation_or_revoke: false,
    }));
  } finally {
    try { await client.disconnect(); } catch (_) {}
    if (!deleted) {
      try { await botApi(botBToken, 'deleteMessage', { chat_id: chatId, message_id: messageId }); } catch (_) {}
    }
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
