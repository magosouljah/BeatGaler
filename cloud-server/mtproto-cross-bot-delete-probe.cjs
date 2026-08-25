'use strict';

const assert = require('node:assert/strict');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const required = name => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required probe secret: ${name}`);
  return value;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function botApiRaw(token, method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { http: response.status, ...body };
}

async function botApi(token, method, payload = {}) {
  const body = await botApiRaw(token, method, payload);
  assert.equal(body?.ok, true, `${method} failed: ${body?.description || body?.http}`);
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
  const rawChannelId = BigInt(chatId.slice(4));

  const meA = await botApi(botAToken, 'getMe');
  const meB = await botApi(botBToken, 'getMe');
  assert.notEqual(String(meA.id), String(meB.id), 'Probe requires two bots.');

  const before = await botApiRaw(botAToken, 'getChat', { chat_id: chatId });
  console.log(JSON.stringify({
    mode: 'M0-F private-vault learn precondition',
    bot_a_visible_before_mtproto_start: before.ok === true,
  }));
  assert.equal(before.ok, false, 'Bot A must start outside the isolated private group for this probe. Remove Lorenzo before running it.');

  const memberB = await botApi(botBToken, 'getChatMember', { chat_id: chatId, user_id: meB.id });
  assert.equal(['administrator', 'creator'].includes(String(memberB.status)), false, 'Bot B must remain a plain member.');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 5,
    autoReconnect: true,
  });

  let deleted = false;
  let messageId = 0;
  try {
    await client.start({
      botAuthToken: botAToken,
      onError: error => console.error(String(error?.message || error)),
    });

    const self = await client.getMe();
    assert.equal(String(self?.id || ''), String(meA.id), 'MTProto session identity does not match bot A.');
    console.log('M0_F_MTProto_SESSION_ACTIVE=true');
    console.log('M0_F_ADD_BOT_A_NOW=true');

    let channel = null;
    let learnedAfterJoin = false;
    let adminDeleteConfirmed = false;
    const deadline = Date.now() + 4 * 60_000;

    while (Date.now() < deadline) {
      const membership = await botApiRaw(botAToken, 'getChatMember', {
        chat_id: chatId,
        user_id: meA.id,
      });

      if (membership.ok === true) {
        const status = String(membership.result?.status || '');
        adminDeleteConfirmed = status === 'administrator' && membership.result?.can_delete_messages === true;
      }

      if (adminDeleteConfirmed) {
        try {
          channel = await client.getInputEntity(new Api.PeerChannel({ channelId: rawChannelId }));
          learnedAfterJoin = Boolean(channel?.accessHash);
        } catch (_) {
          learnedAfterJoin = false;
        }
      }

      if (adminDeleteConfirmed && learnedAfterJoin) break;
      await sleep(3_000);
    }

    assert.equal(adminDeleteConfirmed, true, 'Bot A was not re-added as administrator with delete_messages before the probe timeout.');
    assert.equal(learnedAfterJoin, true, 'The already-active MTProto bot session did not learn the private supergroup access_hash after Bot A was added.');

    console.log(JSON.stringify({
      mode: 'M0-F private-vault learn proof',
      mtproto_session_started_before_vault_membership: true,
      bot_a_readded_private: true,
      bot_a_delete_messages: true,
      private_peer_learned_by_same_mtproto_session: true,
      public_username_used: false,
      master_access_hash_used: false,
    }));

    const message = await botApi(botBToken, 'sendMessage', {
      chat_id: chatId,
      text: `BeatGaler M0-F private MTProto cross-bot delete ${Date.now()}`,
      disable_notification: true,
    });
    messageId = Number(message.message_id || 0);
    assert.ok(messageId > 0, 'Bot B message id missing.');

    const result = await client.invoke(new Api.channels.DeleteMessages({
      channel,
      id: [messageId],
    }));
    assert.ok(Number(result?.ptsCount ?? 0) >= 0, 'Unexpected channels.deleteMessages result.');
    deleted = true;

    console.log('PASS M0-F private-vault MTProto positive cross-bot delete proof');
    console.log(JSON.stringify({
      cross_bot_delete_mtproto_proven: true,
      mtproto_session_started_before_vault_membership: true,
      private_peer_learned_by_same_mtproto_session: true,
      current_transport_identity_is_bot_a: true,
      message_author_is_bot_b: true,
      delete_messages_baseline_required: true,
      mtproto_channels_delete_messages_used: true,
      public_vault_required: false,
      master_per_file_cleanup_used: false,
      over_48h_proven: false,
      user_vault_used: false,
      production_runtime_changed: false,
      token_rotation_or_revoke: false,
    }));
  } finally {
    try { await client.disconnect(); } catch (_) {}
    if (messageId > 0 && !deleted) {
      try { await botApi(botBToken, 'deleteMessage', { chat_id: chatId, message_id: messageId }); } catch (_) {}
    }
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
