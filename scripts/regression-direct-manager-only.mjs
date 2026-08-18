import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');
const fail = (message) => { console.error(`FAIL direct shared-pool guard: ${message}`); process.exit(1); };

const server = read('cloud-server', 'server.js');
const master = read('cloud-server', 'master-storage.js');
const control = read('cloud-server', 'direct-transport-control.js');
const helper = read('src-tauri', 'direct-transport', 'transport-helper.cjs');
const rust = read('src-tauri', 'src', 'commands.rs');
const envExample = read('cloud-server', '.env.example');
const docs = read('cloud-server', 'TELEGRAM-DIRECT-V5-BOTAPI.md');
const packageJson = JSON.parse(read('cloud-server', 'package.json'));

// 001BeatGaler is manager-only.
if (packageJson.dependencies?.['node-telegram-bot-api']) fail('node-telegram-bot-api returned to runtime dependencies.');
if (/TELEGRAM_BOT_TOKEN\s*=/.test(envExample)) fail('A service/data-plane bot token is still requested in .env.example.');
if (!envExample.includes('MANAGER_BOT_TOKEN_1=')) fail('Managed-bot manager credential is missing from .env.example.');
if (!envExample.includes('BEATGALER_DIRECT_REQUIRED=true')) fail('Direct fail-closed mode is not documented as required.');
if (server.includes('new TelegramBot(') || server.includes('.startPolling(') || server.includes('bot.on("message"')) fail('001BeatGaler polling/command runtime returned.');
if (/\bTELEGRAM_BOT_TOKEN\b|\bconst\s+BOT_TOKEN\b/.test(server)) fail('server.js still contains a permanent service/data-plane bot token variable.');
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

// Local Bot API data plane: zero visible handshake and zero client MTProto bot login.
if (/iterDialogs\s*\(|getDialogs\s*\(|GetDialogs/.test(helper)) fail('Transport helper enumerates dialogs.');
if (/TelegramClient|StringSession|botAuthToken/.test(helper)) fail('Client helper still performs MTProto bot authentication.');
if (!helper.includes("botApi(session, 'getMe'")) fail('Bot API Local getMe readiness check is missing.');
if (!helper.includes("botApi(session, 'getChat'")) fail('Bot API Local getChat vault/index discovery is missing.');
if (!helper.includes("botApi(session, 'sendDocument'")) fail('Bot API Local upload path is missing.');
if (!helper.includes("botApi(session, 'getFile'")) fail('Bot API Local download path is missing.');
if (!helper.includes("botApi(session, 'forwardMessage'")) fail('Cross-bot historical media resolver is missing.');
if (!helper.includes('resolverChatId')) fail('Private resolver channel support is missing.');
if (!control.includes('ensureBotApiResolverChat')) fail('Control plane no longer provisions the private transport resolver.');
if (/handshake_marker|session\.marker|BEATGALER_HANDSHAKE_|beatgaler_transport@/.test(helper.replace(/\/\/.*$/gm, ''))) fail('Visible-message handshake returned to helper runtime.');
if (/sendMessage\s*\([^\n]*beatgaler_(transport|ready)|handshakeMarker|handshake_marker/.test(control)) fail('Control plane still creates visible Telegram handshake messages.');

// Single pinned index + delete-replaced-media semantics.
if (!helper.includes("case 'replace_index'")) fail('Transport helper no longer owns index replacement.');
if (!helper.includes('ensureIndex(session)')) fail('A brand-new vault no longer creates one empty index automatically.');
if (!helper.includes("pinChatMessage")) fail('New Direct index is not pinned.');
if (!helper.includes("deleteMessage")) fail('Old index/media deletion is missing.');
if (!helper.includes('mergeDeletedTombstones(previous?.manifest || null, nextManifest)')) fail('Single-index swaps no longer inherit permanent-delete tombstones.');
if (!helper.includes('previousRefs')) fail('Unreferenced replaced media deletion is missing.');
if (!docs.includes('single library index')) fail('Single-index invariant is missing from V5 Direct docs.');
if (!control.includes('recordIndexPointer')) fail('Control plane no longer records the tiny current-index pointer.');

// Desktop must use the control plane gates and never fall back to legacy media transport.
if (rust.includes('fallback=legacy') || rust.includes('HELPER_UNAVAILABLE')) fail('Desktop can silently fall back to the old data plane.');
for (const route of ['/beats/upload', '/projects/upload', '/cloud-files/upload', '/beats/download', '/beats/stream', '/metadata/artwork', '/metadata/upsert']) {
  if (rust.includes(route)) fail(`Desktop still contains legacy media route ${route}.`);
}
if (!rust.includes('DIRECT_HEARTBEAT_SECONDS: u64 = 60')) fail('Desktop heartbeat is no longer one minute.');
if (!rust.includes('DIRECT_TRANSPORT_LEASE_META')) fail('Heartbeat metadata is no longer separated from long helper I/O operations.');
if (!rust.includes('using that lock here would suppress heartbeats during')) fail('Long transfers can silently block the one-minute heartbeat again.');
if (!rust.includes('/transport/session/heartbeat')) fail('Desktop heartbeat route is missing.');
if (!rust.includes('/transport/session/activate')) fail('Desktop membership-update activation is missing.');
if (!rust.includes('/transport/operation/begin') || !rust.includes('/transport/operation/end')) fail('Desktop no longer gates every Direct operation.');
if (!rust.includes('telegram-direct-botapi-local')) fail('Desktop does not require the Local Bot API transport mode.');
if (!rust.includes('BeatGaler no longer falls back to the manager/service bot')) fail('Direct fail-closed invariant disappeared.');
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

console.log('PASS direct shared-pool guard: load-level FIFO sharing, 60s/5m leases, token revoke disabled for testing, Local Bot API data plane, private cross-bot resolver, single pinned index, diagnostics, and delete-replaced-media semantics are present.');
