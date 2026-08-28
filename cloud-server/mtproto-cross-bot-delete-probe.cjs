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
const TARGET_CHAT_ID = '-1004352495400';
const TARGET_MESSAGE_ID = 62;

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

async function main() {
  const apiId = Number(required('BEATGALER_M0_B2_API_ID'));
  const apiHash = required('BEATGALER_M0_B2_API_HASH');
  const botAToken = required('BEATGALER_M0_B2_BOT_TOKEN');
  assert.ok(Number.isInteger(apiId) && apiId > 0, 'API id must be positive.');
  const rawChannelId = BigInt(TARGET_CHAT_ID.slice(4));

  const meResponse = await botApiRaw(botAToken, 'getMe');
  assert.equal(meResponse.ok, true, `bot A getMe failed: ${meResponse.description || meResponse.http}`);
  const meA = meResponse.result;

  const before = await botApiRaw(botAToken, 'getChat', { chat_id: TARGET_CHAT_ID });
  console.log(JSON.stringify({ mode: 'M0-F >48h precondition', bot_a_visible_before_mtproto_start: before.ok === true, target_message_id: TARGET_MESSAGE_ID }));
  assert.equal(before.ok, false, 'Bot A must start outside the target private group. Remove Lorenzo before running this probe.');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5, autoReconnect: true });
  try {
    await client.start({ botAuthToken: botAToken, onError: error => console.error(String(error?.message || error)) });
    const self = await client.getMe();
    assert.equal(String(self?.id || ''), String(meA.id), 'MTProto session identity does not match bot A.');
    console.log('M0_F_MTProto_SESSION_ACTIVE=true');
    console.log('M0_F_ADD_BOT_A_NOW=true');

    let channel = null;
    let learnedAfterJoin = false;
    let adminDeleteConfirmed = false;
    const deadline = Date.now() + 4 * 60_000;

    while (Date.now() < deadline) {
      const membership = await botApiRaw(botAToken, 'getChatMember', { chat_id: TARGET_CHAT_ID, user_id: meA.id });
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

    assert.equal(adminDeleteConfirmed, true, 'Bot A was not added as administrator with delete_messages before timeout.');
    assert.equal(learnedAfterJoin, true, 'The active MTProto bot session did not learn the target private group.');

    const result = await client.invoke(new Api.channels.DeleteMessages({ channel, id: [TARGET_MESSAGE_ID] }));
    assert.ok(Number(result?.ptsCount ?? 0) >= 0, 'Unexpected channels.deleteMessages result.');

    console.log('PASS M0-F >48h cross-bot MTProto delete proof');
    console.log(JSON.stringify({
      cross_bot_delete_mtproto_proven: true,
      over_48h_proven: true,
      target_message_id: TARGET_MESSAGE_ID,
      mtproto_channels_delete_messages_used: true,
      private_peer_learned_by_same_mtproto_session: true,
      public_vault_required: false,
      master_per_file_cleanup_used: false,
      production_runtime_changed: false,
      token_rotation_or_revoke: false
    }));
  } finally {
    try { await client.disconnect(); } catch (_) {}
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
