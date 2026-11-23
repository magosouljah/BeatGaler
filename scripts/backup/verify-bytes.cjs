'use strict';
// E77 — Herramienta LOCAL de operador: verifica por SHA-256 los bytes de cada parte PRIMARY conocida leyéndolos de Telegram con la sesión del
// bot asignado a cada biblioteca. Es independiente del Cloud: el servidor y el worker nunca descargan archivos. Solo lectura (no borra ni envía).
//   DATABASE_URL_VERIFY=postgres://… TELEGRAM_API_ID=… TELEGRAM_API_HASH=… node scripts/backup/verify-bytes.cjs [--restore-id ID] [--user USER_ID]
// Con --restore-id los hallazgos (BYTES_MISSING / BYTES_MISMATCH) quedan registrados en esa corrida de restore. Requiere el pool de bots del
// operador (mismas credenciales que el Cloud; nunca se imprimen). No ejecutado todavía contra Telegram real: validar en sandbox autorizado.
const path = require('path');
const CLOUD = path.join(__dirname, '..', '..', 'cloud-server');
const { Pool } = require(path.join(CLOUD, 'node_modules', 'pg'));
const { createCatalogBackup } = require(path.join(CLOUD, 'catalog', 'backup'));
const { createRealBotClientProvider } = require(path.join(CLOUD, 'catalog-gateway-runtime'));
const { createTelegramFileIo } = require(path.join(CLOUD, 'operator', 'telegram-file-io'));

/** Lector de bytes por chat: resuelve el bot de la biblioteca en SQL y abre su sesión una sola vez. */
function createOperatorReader({ pool, clientProvider, sdk }) {
  const byBot = new Map(); const byChat = new Map();
  async function ioForChat(chatId) {
    const key = String(chatId);
    if (!byChat.has(key)) {
      const r = (await pool.query('SELECT transport_bot_id AS bot_id FROM vaults WHERE telegram_chat_id = $1', [key])).rows[0];
      if (!r || !r.bot_id) throw Object.assign(new Error(`no transport bot is assigned to chat ${key}`), { code: 'CHAT_BOT_UNRESOLVED' });
      byChat.set(key, String(r.bot_id));
    }
    const botId = byChat.get(key);
    if (!byBot.has(botId)) {
      byBot.set(botId, (async () => {
        const opened = await clientProvider.open(botId); const client = opened.client;
        const resolvePeer = async (id) => {
          let peer = null;
          if (typeof client.getInputEntity === 'function') { try { peer = await client.getInputEntity(id); } catch (_) { peer = null; } }
          if (!peer) peer = new sdk.Api.InputPeerChannel({ channelId: sdk.bigInt(String(id).replace(/^-100/, '')), accessHash: sdk.bigInt(0) });
          return { peer, channel: true };
        };
        return createTelegramFileIo({ client, sdk, senderId: String(opened.telegramUserId), resolvePeer });
      })());
    }
    return byBot.get(botId);
  }
  return { downloadPart: async (args) => (await ioForChat(args.chatId)).downloadPart(args) };
}

async function main() {
  const argv = process.argv.slice(2); const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const url = process.env.DATABASE_URL_VERIFY || '';
  if (!url) { console.error('uso: DATABASE_URL_VERIFY=… TELEGRAM_API_ID=… TELEGRAM_API_HASH=… node scripts/backup/verify-bytes.cjs [--restore-id ID] [--user USER_ID]'); process.exit(2); }
  const apiId = Number(process.env.TELEGRAM_API_ID); const apiHash = String(process.env.TELEGRAM_API_HASH || '');
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash) { console.error('STOP-ENV: TELEGRAM_API_ID / TELEGRAM_API_HASH requeridos'); process.exit(4); }
  const sdk = { Api: require(path.join(CLOUD, 'node_modules', 'telegram')).Api, bigInt: require(path.join(CLOUD, 'node_modules', 'big-integer')) };
  const pool = new Pool({ connectionString: url, max: 2 });
  const clientProvider = createRealBotClientProvider({ credentialFor: (botId) => require(path.join(CLOUD, 'catalog-telegram-transport')).getCatalogTelegramTransport().catalogBotCredential(botId), apiCredentials: () => ({ apiId, apiHash }) });
  try {
    const report = await createCatalogBackup({ pool, log: (e, d) => console.error('[verify-bytes]', e, JSON.stringify(d || {})) }).verifyBytes({ reader: createOperatorReader({ pool, clientProvider, sdk }), restoreId: arg('--restore-id'), userId: arg('--user') });
    console.log(JSON.stringify({ checked: report.checked, ok: report.ok, mismatches: report.mismatches.length, missing: report.missing.length }));
    process.exitCode = report.mismatches.length || report.missing.length ? 3 : 0;
  } finally { await clientProvider.close().catch(() => {}); await pool.end(); }
}
if (require.main === module) main().catch((e) => { console.error(e.code || 'ERROR', e.message); process.exit(1); });
module.exports = { createOperatorReader };
