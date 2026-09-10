import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const fail = (message) => { console.error(`FAIL direct shared-pool guard: ${message}`); process.exit(1); };

const serverEntry = read('cloud-server', 'server.js');
const serverCore = read('cloud-server', 'server-core.js');
const server = `${serverEntry}\n${serverCore}`;
const master = read('cloud-server', 'master-storage.js');
const control = read('cloud-server', 'direct-transport-control.js');
const helper = read('src-tauri', 'direct-transport', 'transport-helper.source.mjs');
const rust = read('src-tauri', 'src', 'commands.rs');
const envExample = read('cloud-server', '.env.example');
const docs = read('cloud-server', 'TELEGRAM-DIRECT-V5-BOTAPI.md');
const packageJson = JSON.parse(read('cloud-server', 'package.json'));

// 001BeatGaler is manager-only.
if (packageJson.dependencies?.['node-telegram-bot-api']) fail('node-telegram-bot-api returned to runtime dependencies.');
if (/TELEGRAM_BOT_TOKEN\s*=/.test(envExample)) fail('A service/data-plane bot token is still requested in .env.example.');
if (!envExample.includes('MANAGER_BOT_TOKEN_1=')) fail('Managed-bot manager credential is missing from .env.example.');
if (!envExample.includes('BEATGALER_DIRECT_REQUIRED=true')) fail('Direct fail-closed mode is not documented as required.');
if (!serverEntry.includes('require("./server-core")')) fail('server.js no longer boots the contained server core.');
if (server.includes('new TelegramBot(') || server.includes('.startPolling(') || server.includes('bot.on("message"')) fail('001BeatGaler polling/command runtime returned.');
if (/\bTELEGRAM_BOT_TOKEN\b|\bconst\s+BOT_TOKEN\b/.test(server)) fail('Cloud server still contains a permanent service/data-plane bot token variable.');
if (!server.includes('001BeatGaler manager-only: no polling, no commands, no vault membership, no data plane')) fail('Manager-only invariant marker disappeared.');
if (!server.includes('ensurePrivateUserStorageBotAbsent')) fail('Old vault migration no longer removes 001BeatGaler.');

// MASTER owns only vault/control responsibilities.
const createStart = master.indexOf('async function createPrivateUserStorageGroup');
const createEnd = master.indexOf('async function findStorageChannelByBotApiId', createStart);
const createBlock = master.slice(createStart, createEnd);
if (!createBlock.includes('new Api.channels.CreateChannel')) fail('MASTER no longer creates vaults.');
if (/InviteToChannel|EditAdmin/.test(createBlock)) fail('Vault creation adds/promotes a permanent bot again.');
if (!master.includes('ensurePrivateUserStorageBotAbsent')) fail('MASTER cannot remove 001BeatGaler from old vaults.');
if (!server.includes('async function ensureEmptyIndexForStorage(_account)')) fail('New vault setup no longer suppresses MASTER index creation.');
if (!server.includes('MASTER intentionally creates NO index')) fail('MASTER may have regained the normal index path.');

// Shared pool: load-level FIFO + heartbeat. Token rotation is intentionally OFF in V5 test mode.
if (!control.includes("getManagedBotToken")) fail('001BeatGaler no longer has its manager-only token role.');
if (!control.includes("DIRECT_TOKEN_ROTATION_ENABLED || 'false'")) fail('Token rotation is not disabled by default for V5 testing.');
if (!envExample.includes('DIRECT_TOKEN_ROTATION_ENABLED=false')) fail('V5 test-mode no-revoke setting is missing from .env.example.');
if (!control.includes('DIRECT_HEARTBEAT_INTERVAL_MS || 60_000')) fail('Heartbeat default is no longer 60 seconds.');
if (!control.includes('DIRECT_HEARTBEAT_TIMEOUT_MS || 5 * 60_000')) fail('Heartbeat timeout default is no longer 5 minutes.');
if (!control.includes('const minLoad = Math.min(...loads.values())')) fail('Minimum-load tier scheduler is missing.');
if (!control.includes('state.queue.push(nextId)')) fail('Selected bot no longer moves to the end of FIFO.');
if (!control.includes('await inviteAndPromote(masterInfo.client, masterInfo.vault, botEntity)')) fail('MASTER no longer adds the selected transport bot.');
if (!control.includes('await kickAndUnban(masterInfo.client, masterInfo.vault, botEntity)')) fail('MASTER no longer removes the transport bot from the ending vault.');
if (!control.includes('active_vaults: leasesForBot(state, bot.id).length')) fail('Shared active-vault load is no longer exposed.');
if (!control.includes("normalizedKind === 'replace_index'")) fail('Per-vault single-index swaps are no longer serialized across installations.');
if (!control.includes("reason: 'index_busy'")) fail('Concurrent index writers no longer wait instead of racing index replacement.');

// Temporary MTProto data plane: no permanent credentials or Local Bot API.
if (/iterDialogs\s*\(|getDialogs\s*\(|GetDialogs/.test(helper)) fail('Transport helper enumerates dialogs.');
if (!helper.includes('TelegramClient')) fail('Desktop helper no longer uses the temporary MTProto client.');
if (!helper.includes('apiHash: ""')) fail('Temporary MTProto client must keep apiHash empty.');
if (!helper.includes('next.getMe()')) fail('Temporary MTProto getMe identity verification is missing.');
if (!helper.includes('getChat(Number(session.chat_id))')) fail('Temporary MTProto vault verification is missing.');
if (!helper.includes('temp_auth_metadata') || !helper.includes('temp_auth_binding')) fail('Temporary auth metadata/binding handshake is missing.');
if (!helper.includes('applyBoundTempSessionState')) fail('Bound MTProto session continuity is missing.');
if (!/authKey:\s*imported\.authKey\.slice\(\)/.test(helper)) fail('Desktop helper must give mtcute its own temporary-auth key buffer before zeroing the handoff buffer.');
if (/authKey:\s*imported\.authKey\s*,/.test(helper)) fail('Desktop helper reintroduced the aliased temporary-auth key that becomes zeroed after importSession.');
if (!helper.includes('imported.authKey.fill(0)')) fail('Desktop helper no longer clears the temporary handoff auth-key buffer after importing a safe copy.');
if (!helper.includes('Readable.toWeb(nodeStream)')) fail('Desktop helper passes a Node ReadStream to the @mtcute/web IReadable path, which can spin forever without consuming bytes.');
if (!helper.includes('abortSignal: controller.signal')) fail('Desktop helper upload no longer has an abortable Telegram deadline.');
for (const forbidden of ['bot_token', 'telegram_api_id', 'telegram_api_hash', 'credential_envelope', 'bot_api_base']) {
  if (!helper.includes(`"${forbidden}"`)) fail(`Desktop helper no longer rejects ${forbidden}.`);
}
if (/handshake_marker|session\.marker|BEATGALER_HANDSHAKE_|beatgaler_transport@/.test(helper.replace(/\/\/.*$/gm, ''))) fail('Visible-message handshake returned to helper runtime.');
if (/sendMessage\s*\([^\n]*beatgaler_(transport|ready)|handshakeMarker|handshake_marker/.test(control)) fail('Control plane still creates visible Telegram handshake messages.');

// Single pinned index + delete-replaced-media semantics.
if (!helper.includes('case "replace_index"')) fail('Transport helper no longer owns index replacement.');
if (!helper.includes('ensureIndex()')) fail('A brand-new vault no longer creates one empty index automatically.');
if (!helper.includes('pinMessage')) fail('New Direct index is not pinned.');
if (!helper.includes('deleteMessagesById')) fail('Old index/media deletion is missing.');
if (!helper.includes('mergeDeleted(previous?.manifest, next)')) fail('Single-index swaps no longer inherit permanent-delete tombstones.');
if (!helper.includes('previousRefs')) fail('Unreferenced replaced media deletion is missing.');
if (!docs.includes('single library index')) fail('Single-index invariant is missing from V5 Direct docs.');
if (!control.includes('recordIndexPointer')) fail('Control plane no longer records the tiny current-index pointer.');

// Desktop must use the control plane gates and never fall back to legacy media transport.
if (rust.includes('fallback=legacy') || rust.includes('HELPER_UNAVAILABLE')) fail('Desktop can silently fall back to the old data plane.');
for (const route of ['/beats/upload', '/projects/upload', '/cloud-files/upload', '/beats/download', '/beats/stream', '/metadata/artwork', '/metadata/upsert']) {
  if (rust.includes(route)) fail(`Desktop still contains legacy media route ${route}.`);
}
if (!rust.includes('DIRECT_HEARTBEAT_SECONDS: u64 = 60')) fail('Desktop heartbeat is no longer one minute.');
if (!rust.includes('recv_timeout(remaining)')) fail('Desktop helper response wait can block forever again.');
if (!rust.includes('direct_terminate_unresponsive_helper(runtime)')) fail('Desktop does not terminate and reap an unresponsive helper after its response deadline.');
const shutdownBlock = rust.slice(rust.indexOf('fn kill_direct_runtime_without_releasing'), rust.indexOf('fn replace_direct_runtime_from_session'));
if (shutdownBlock.includes('direct_send_helper_command')) fail('Desktop shutdown waits for a helper acknowledgement and can deadlock behind an upload.');
if (!rust.includes('DIRECT_TRANSPORT_LEASE_META')) fail('Heartbeat metadata is no longer separated from long helper I/O operations.');
if (!rust.includes('using that lock here would suppress heartbeats during')) fail('Long transfers can silently block the one-minute heartbeat again.');
if (!rust.includes('/transport/session/heartbeat')) fail('Desktop heartbeat route is missing.');
if (!rust.includes('/transport/session/activate')) fail('Desktop membership-update activation is missing.');
if (!rust.includes('/transport/operation/begin') || !rust.includes('/transport/operation/end')) fail('Desktop no longer gates every Direct operation.');
if (!rust.includes('galer-direct-temp-mtproto')) fail('Desktop does not require temporary MTProto transport mode.');
if (rust.slice(rust.indexOf('fn spawn_direct_helper'), rust.indexOf('fn kill_direct_runtime_without_releasing')).includes('ensure_local_bot_api')) fail('Desktop helper startup still launches Local Bot API.');
if (rust.slice(rust.indexOf('fn spawn_direct_helper'), rust.indexOf('fn kill_direct_runtime_without_releasing')).includes('bot_api_base')) fail('Desktop bootstrap still injects bot_api_base.');
if (!rust.includes('fn direct_bind_helper_temp_auth') || !rust.includes('"tempAuthMetadata": metadata')) fail('Rust metadata-to-binding bridge is missing.');
if (!rust.includes('DirectBeginDisposition::TempAuthRequired') || !rust.includes('"op": "renew_temp_auth"')) fail('Temporary-auth renewal without credential_refresh is missing.');
if (!rust.includes('HEARTBEAT_TEMP_AUTH_RENEWED')) fail('Heartbeat does not drive idle temporary-auth renewal.');
if (!rust.includes('Galer Storage is unavailable:')) fail('Direct fail-closed invariant disappeared.');
if (!rust.includes('DATA_PLANE_READY')) fail('Direct data-plane readiness diagnostic disappeared.');
if (!rust.includes('"op": "replace_index"') || !rust.includes('"op": "get_index"')) fail('Desktop index path is no longer Direct.');
if (!rust.includes('fn direct_move_beats_to_trash')) fail('Offline Trash no longer mutates the current index through the transport bot.');
if (!rust.includes('fn direct_permanently_delete_beats')) fail('Permanent Trash delete no longer mutates the current index through the transport bot.');
if (!server.includes('Legacy server-side library index upload is disabled')) fail('Server-side MASTER library upsert was re-enabled.');
if (!server.includes('Legacy server-side library index download is disabled')) fail('Server-side MASTER library reads were re-enabled for normal clients.');

// Control-plane routes must be authenticated and expose the shared-session lifecycle.
for (const route of ['/transport/session/start', '/transport/session/activate', '/transport/session/heartbeat', '/transport/session/stop', '/transport/operation/begin', '/transport/operation/end', '/transport/index/commit']) {
  if (!server.includes(`app.post("${route}"`)) fail(`Missing control-plane route ${route}.`);
}
const stopBlock = server.slice(server.indexOf('app.post("/transport/session/stop"'), server.indexOf('app.post("/transport/operation/begin"'));
if (!stopBlock.includes('authenticatedTransportAccount(req, res)')) fail('Session stop is not authenticated.');

console.log('PASS direct shared-pool guard: temporary MTProto bootstrap/binding/renewal, bound-session continuity, no Desktop permanent credentials, shared leases, and Direct INDEX operations are present.');
