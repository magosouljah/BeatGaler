#!/usr/bin/env node
'use strict';
// Read-only Telegram preflight for existing Bot01/02/03, no bot creation,
// token rotation, chat mutation, send/delete or token printing.
const { createRealBotClientProvider } = require('../catalog-gateway-runtime.js');
const { catalogBotCredential } = require('../direct-transport-control.js');

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = String(process.env.TELEGRAM_API_HASH || '');
  if (!Number.isInteger(apiId) || apiId < 1 || !apiHash) throw new Error('TELEGRAM_API_ENV_MISSING');
  const ids = ['Bot01', 'Bot02', 'Bot03'];
  const provider = createRealBotClientProvider({
    credentialFor: catalogBotCredential,
    apiCredentials: () => ({ apiId, apiHash }),
  });
  let ok = 0;
  try {
    for (const id of ids) {
      let opened;
      try {
        opened = await provider.open(id);
        const me = await opened.client.getMe();
        if (!me || !me.bot) throw new Error('NOT_BOT_IDENTITY');
        if (opened.telegramUserId !== String(me.id)) throw new Error('BOT_ID_CHANGED');
        console.log(id + ': AUTH_IDENTITY_PASS');
        ok++;
      } catch (err) {
        console.log(id + ': FAIL_' + String(err.code || 'TELEGRAM_ERROR').replace(/[^A-Z0-9_]/gi, '_').slice(0,60));
        throw new Error('PREFLIGHT_BOT_FAILED');
      }
    }
    console.log('READ_ONLY_BOT_IDENTITY_PASS=' + ok + '/3');
    console.log('G2_MEDIA_SMOKE=NOT_PROVEN');
  } finally {
    await provider.close();
  }
}
main().catch(e => { console.error('STOP:', e.message); process.exitCode=3; });
