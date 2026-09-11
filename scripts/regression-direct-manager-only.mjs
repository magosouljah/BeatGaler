import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => { throw new Error(message); };

// Parse real function/block boundaries: missing/renamed boundaries must fail,
// and comments or strings that merely mention a call must not satisfy it.
const nodes = (node, predicate) => {
  const found = [];
  const visit = current => { if (predicate(current)) found.push(current); ts.forEachChild(current, visit); };
  visit(node);
  return found;
};
const parse = (name, source) => {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) fail(`${name} cannot be parsed for architecture guards.`);
  return ast;
};
const one = (matches, label) => {
  if (matches.length !== 1) fail(`Expected exactly one ${label}; found ${matches.length}.`);
  return matches[0];
};
const functionNode = (ast, name) => one(nodes(ast, node =>
  ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText() === name && node.body) ||
  (ts.isVariableDeclaration(node) && node.name.getText() === name && node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && node.initializer.body)
), `function boundary ${name}`);
const bodyOf = node => node.body || node.initializer.body;
const block = (ast, name) => bodyOf(functionNode(ast, name));
const calls = (node, name) => nodes(node, item => ts.isCallExpression(item) && item.expression.getText() === name);
const requireCall = (node, name) => one(calls(node, name), `call ${name}`);
const compact = node => node.getText().replace(/\s+/g, '');
const withoutSqlComments = source => source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
const querySql = (node, receiver) => withoutSqlComments(calls(node, `${receiver}.query`).map(call => call.arguments[0]?.getText() || '').join('\n'));
const branch = (node, condition) => one(nodes(node, item => ts.isIfStatement(item) && compact(item.expression) === condition), `branch ${condition}`);
const before = (left, right, message) => { if (left.end > right.pos) fail(message); };
const noCalls = (node, forbidden, label) => {
  for (const call of nodes(node, item => ts.isCallExpression(item) || ts.isNewExpression(item))) {
    if (forbidden.test(call.expression.getText())) fail(`${label} reaches ${call.expression.getText()}.`);
  }
};
const noLocalReachability = (ast, entry, forbidden, label, seen = new Set()) => {
  noCalls(entry, forbidden, label);
  for (const call of nodes(entry, ts.isCallExpression)) {
    if (!ts.isIdentifier(call.expression) || seen.has(call.expression.text)) continue;
    const name = call.expression.text;
    const local = nodes(ast, node => ts.isFunctionDeclaration(node) && node.name?.text === name && node.body);
    if (!local.length) continue;
    seen.add(name);
    noLocalReachability(ast, bodyOf(one(local, `local function ${name}`)), forbidden, label, seen);
  }
};
const boundedSection = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end <= start || source.indexOf(startMarker, start + 1) >= 0 || source.indexOf(endMarker, end + 1) >= 0) {
    fail(`Missing or ambiguous source boundaries: ${startMarker} -> ${endMarker}.`);
  }
  return source.slice(start, end);
};

export function verifyDirectArchitecture(read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8')) {

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
const assignmentRuntime = parse('direct-persistent-assignment-runtime.js', read('cloud-server', 'direct-persistent-assignment-runtime.js'));
const assignmentStore = parse('direct-vault-assignment.js', read('cloud-server', 'direct-vault-assignment.js'));
const sessionRuntime = parse('direct-persistent-session-runtime.js', read('cloud-server', 'direct-persistent-session-runtime.js'));
const membershipRuntime = parse('direct-persistent-membership-runtime.js', read('cloud-server', 'direct-persistent-membership-runtime.js'));
const controlAst = parse('direct-transport-control.js', control);
const serverAst = parse('server.js', serverEntry);
const coreAst = parse('server-core.js', serverCore);
const helperAst = parse('transport-helper.source.mjs', helper);
const migration = withoutSqlComments(read('cloud-server', 'migrations', '0010_persistent_transport_assignment.sql'));

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
const createBlock = block(parse('master-storage.js', master), 'createPrivateUserStorageGroup').getText();
if (!createBlock.includes('new Api.channels.CreateChannel')) fail('MASTER no longer creates vaults.');
if (/InviteToChannel|EditAdmin/.test(createBlock)) fail('Vault creation adds/promotes a permanent bot again.');
if (!master.includes('ensurePrivateUserStorageBotAbsent')) fail('MASTER cannot remove 001BeatGaler from old vaults.');
if (!server.includes('async function ensureEmptyIndexForStorage(_account)')) fail('New vault setup no longer suppresses MASTER index creation.');
if (!server.includes('MASTER intentionally creates NO index')) fail('MASTER may have regained the normal index path.');

// Heartbeats/optional token rotation concern ephemeral leases, never ownership.
if (!control.includes("getManagedBotToken")) fail('001BeatGaler no longer has its manager-only token role.');
if (!control.includes("DIRECT_TOKEN_ROTATION_ENABLED || 'false'")) fail('Token rotation is not disabled by default for V5 testing.');
if (!envExample.includes('DIRECT_TOKEN_ROTATION_ENABLED=false')) fail('V5 test-mode no-revoke setting is missing from .env.example.');
if (!control.includes('DIRECT_HEARTBEAT_INTERVAL_MS || 60_000')) fail('Heartbeat default is no longer 60 seconds.');
if (!control.includes('DIRECT_HEARTBEAT_TIMEOUT_MS || 5 * 60_000')) fail('Heartbeat timeout default is no longer 5 minutes.');
if (!control.includes("normalizedKind === 'replace_index'")) fail('Per-vault single-index swaps are no longer serialized across installations.');
if (!control.includes("reason: 'index_busy'")) fail('Concurrent index writers no longer wait instead of racing index replacement.');

// PostgreSQL is the sole authority. First access is lazy; an existing assignment
// returns before candidate selection even if the bot is unavailable/quarantined.
const boot = block(serverAst, 'start');
const configure = requireCall(boot, 'directPersistentAssignments.configure');
if (compact(configure.arguments[0]) !== '{pool}') fail('Persistent assignment runtime must receive the PostgreSQL pool.');
const installStart = requireCall(boot, 'installPersistentDirectSessionStart');
const installMembership = requireCall(boot, 'installPersistentDirectMembershipActivation');
for (const install of [installStart, installMembership]) {
  if (compact(install.arguments[0]) !== '{directTransport,persistentAssignments:directPersistentAssignments,}') fail('Direct runtime wrapper is not wired to the PostgreSQL assignment runtime.');
  before(configure, install, 'PostgreSQL assignment must be configured before installing Direct wrappers.');
  if (!ts.isExpressionStatement(install.parent) || install.parent.parent !== boot) fail('Persistent Direct wrappers must install unconditionally during server startup.');
}
const requiredStore = block(assignmentRuntime, 'requiredStore');
if (!requiredStore.getText().includes('TRANSPORT_ASSIGNMENT_POSTGRES_REQUIRED') || !nodes(branch(requiredStore, '!assignmentStore').thenStatement, ts.isThrowStatement).length) fail('Missing PostgreSQL must fail closed.');
const resolve = block(assignmentRuntime, 'resolveForVault');
requireCall(resolve, 'requiredStore');
requireCall(resolve, 'store.assignIfMissing');
if (compact(requireCall(resolve, 'store.syncTransportBots').arguments[0]) !== 'publicPoolState(pool,state)') fail('PostgreSQL must receive only public bot state.');
for (const [ast, name] of [[assignmentRuntime, 'publicPoolState'], [assignmentStore, 'normalizeTransportBot']]) {
  const fields = nodes(block(ast, name), node => ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)).map(node => node.name.getText());
  if (fields.sort().join(',') !== 'id,quarantined,rotationPending') fail(`${name} must whitelist public identity/state without transport secrets.`);
}
const assign = block(assignmentStore, 'assignIfMissing');
const existing = branch(assign, 'current.transport_bot_id');
requireCall(existing.thenStatement, 'assignmentFromRow');
if (!ts.isReturnStatement(existing.thenStatement.statements?.at(-1))) fail('Existing ownership must return before selecting a candidate.');
const candidate = one(nodes(assign, node => ts.isVariableDeclaration(node) && node.name.getText() === 'candidateResult'), 'persistent candidate query');
before(existing, candidate, 'Existing ownership must win before candidate selection.');
const assignText = querySql(assign, 'client');
for (const sql of ['pg_advisory_xact_lock', 'FOR UPDATE', 'v.transport_bot_id=tb.id', 'tb.quarantined=false AND tb.rotation_pending=false', 'ORDER BY COUNT(v.id) ASC,tb.id ASC', "transport_membership_state='pending'"]) {
  if (!assignText.includes(sql)) fail(`Persistent assignment lost ${sql}.`);
}
if (/direct_leases|leasesForBot|leaseNextBot|state\.queue/.test(assignText)) fail('Ephemeral sessions/FIFO must not decide PostgreSQL ownership.');
const setMembership = querySql(block(assignmentStore, 'setMembershipState'), 'this.pool');
if (/SET\s+transport_bot_id/i.test(setMembership)) fail('Membership transitions must not reassign ownership.');
const expectedBotGuard = one(nodes(block(assignmentStore, 'setMembershipState'), node => ts.isBinaryExpression(node) && node.left.getText() === 'botGuard'), 'same-bot membership update guard');
if (!expectedBotGuard.right.getText().includes('AND transport_bot_id=$') || !setMembership.includes('${botGuard}')) fail('Membership transitions must guard the expected transport bot.');
if (!/ADD COLUMN transport_bot_id text REFERENCES transport_bots\(id\)\s*,/i.test(migration) || /UPDATE\s+vaults\s+SET\s+transport_bot_id/i.test(migration)) fail('Legacy ownership must stay nullable without a default or bulk assignment.');
if (!migration.includes('DROP TRIGGER IF EXISTS direct_leases_active_cap_trigger') || !migration.includes('DROP FUNCTION IF EXISTS enforce_transport_bot_active_lease_cap()')) fail('The obsolete four-active-lease cap must remain retired.');

// The wrapper resolves ownership, installs that exact lease, then invokes the
// legacy session primitive. Runtime tests exercise the branch that bypasses FIFO.
const wrappedStart = block(sessionRuntime, 'wrappedStartSession');
const resolveCall = requireCall(wrappedStart, 'persistentAssignments.resolveForVault');
const prepareCall = requireCall(wrappedStart, 'prepareAssignedLease');
const legacyStart = one(calls(wrappedStart, 'originalStartSession').filter(call => ts.isAwaitExpression(call.parent)), 'prepared legacy start');
const earlyStarts = calls(wrappedStart, 'originalStartSession').filter(call => call !== legacyStart);
if (earlyStarts.length !== 2 || earlyStarts.some(call => !ts.isReturnStatement(call.parent) || !ts.isIfStatement(call.parent.parent) ||
  !['!installationId||!chatId', '!status?.configured'].includes(compact(call.parent.parent.expression)))) fail('Legacy start may bypass PostgreSQL only for invalid input or an unconfigured pool.');
before(resolveCall, prepareCall, 'Resolve PostgreSQL assignment before preparing a lease.');
before(prepareCall, legacyStart, 'The assigned lease must exist before entering legacy start.');
if (!compact(prepareCall.arguments[0]).includes('transportBotId:assignedBotId,')) fail('Session preparation must use the assigned bot.');
const invariant = branch(wrappedStart, "String(session?.transport_id||'')!==assignedBotId");
if (!nodes(invariant.thenStatement, ts.isThrowStatement).length) fail('Mismatched session transport must fail closed.');
const prepareLease = block(sessionRuntime, 'prepareAssignedLease');
requireCall(prepareLease, 'ensureAssignedBotAdmissible');
if (!nodes(prepareLease, node => ts.isPropertyAssignment(node) && node.name.getText() === 'bot_id' && node.initializer.getText() === 'botId').length) fail('Prepared lease no longer belongs to the assigned bot.');
const admissible = block(sessionRuntime, 'ensureAssignedBotAdmissible');
for (const condition of ['!botState', 'botState.quarantined', 'botState.rotation_pending']) {
  if (!nodes(branch(admissible, condition).thenStatement, ts.isThrowStatement).length) fail(`Assigned bot ${condition} must fail without fallback.`);
}
noCalls(wrappedStart, /leaseNextBot|waitForAssignableTransport|repairMembership|rotateManagedToken/, 'Assigned session start');
const installStartBody = block(sessionRuntime, 'installPersistentDirectSessionStart');
if (compact(requireCall(installStartBody, 'directTransport.startSession.bind').arguments[0]) !== 'directTransport') fail('Persistent start must wrap the original live Direct session primitive.');
if (!nodes(installStartBody, node => ts.isBinaryExpression(node) && compact(node) === 'directTransport.startSession=wrappedStartSession').length) fail('Persistent start wrapper is not installed on the live Direct module.');

// READY is an early local return; provisioning remains behind the per-vault
// lock. Inspect its prefix and reachable helpers, not the whole mixed function.
const wrappedActivate = block(membershipRuntime, 'wrappedActivateSession');
const ready = branch(wrappedActivate, "String(initial.membershipState)==='ready'");
const readyReturn = one(ready.thenStatement.statements || [], 'READY local return');
if (!ts.isReturnStatement(readyReturn) || compact(readyReturn.expression) !== 'readyResult(finalizeReadyLease({directTransport,pool:checked.pool,lease:checked.lease,}))') fail('READY activation must return the local ACTIVE lease transition.');
const forbiddenMembership = /master|Master|InviteToChannel|EditAdmin|GetParticipant|EditBanned|kickAndUnban|decommissionVaultMembership|originalActivateSession|provisionCurrentLease|withMembershipLock|markMembership|repairMembership/;
for (const statement of wrappedActivate.statements) {
  if (statement.pos >= ready.end) break;
  noLocalReachability(membershipRuntime, statement === ready ? ready.thenStatement : statement, forbiddenMembership, 'READY activation');
}
const pendingLock = requireCall(wrappedActivate, 'persistentAssignments.withMembershipLock');
before(ready, pendingLock, 'READY activation must return before membership provisioning lock.');
const pendingCallback = pendingLock.arguments[1];
requireCall(pendingCallback, 'assertAssignmentMatches');
requireCall(pendingCallback, 'provisionCurrentLease');
const provision = block(membershipRuntime, 'provisionCurrentLease');
before(requireCall(provision, 'originalActivateSession'), requireCall(provision, 'persistentAssignments.markMembershipReady'), 'Membership can become READY only after successful provisioning.');
const repair = block(membershipRuntime, 'repairMembership');
const repairLock = requireCall(repair, 'persistentAssignments.withMembershipLock');
const repairCallback = repairLock.arguments[1];
requireCall(repairCallback, 'assertAssignmentMatches');
before(requireCall(repairCallback, 'persistentAssignments.markMembershipRepairNeeded'), requireCall(repairCallback, 'provisionCurrentLease'), 'Explicit same-bot repair must mark REPAIR before provisioning.');
noCalls(repair, /assignIfMissing|resolveForVault|leaseNextBot|rotateManagedToken/, 'Explicit repair');
if (nodes(repair, node => ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)).length) fail('Explicit repair must not internally retry provisioning.');
const membershipLock = block(assignmentStore, 'withMembershipLock');
const lockSql = querySql(membershipLock, 'client');
if (!lockSql.includes('pg_advisory_lock(') || !lockSql.includes('pg_advisory_unlock(') || /['"`]BEGIN['"`]|pg_advisory_xact_lock/.test(lockSql)) fail('Membership network work must use a session advisory lock without an open SQL transaction.');
requireCall(membershipLock, 'callback');
const membershipInstall = block(membershipRuntime, 'installPersistentDirectMembershipActivation');
if (compact(requireCall(membershipInstall, 'directTransport.activateSession.bind').arguments[0]) !== 'directTransport') fail('Persistent membership must wrap the original live provisioning primitive.');
for (const assignment of ['directTransport.activateSession=wrappedActivateSession', 'directTransport.repairMembership=repairMembership']) {
  if (!nodes(membershipInstall, node => ts.isBinaryExpression(node) && compact(node) === assignment).length) fail(`Missing live membership wrapper: ${assignment}.`);
}
const resolver = block(controlAst, 'ensureBotApiResolverChat');
const persistedResolver = branch(resolver, 'existingId');
if (!nodes(persistedResolver.thenStatement, node => ts.isReturnStatement(node) && node.expression?.getText() === 'existingId').length) fail('Persisted resolver must return without MASTER bootstrap.');
noLocalReachability(controlAst, persistedResolver.thenStatement, forbiddenMembership, 'Persisted resolver');

// Normal cleanup keeps membership. Walk local callees to catch indirect churn;
// kick/unban remains an explicit decommission primitive with one allowed caller.
const forbiddenCleanup = /master|Master|InviteToChannel|EditAdmin|GetParticipant|EditBanned|kickAndUnban|decommissionVaultMembership|\.getEntity|markMembership/;
for (const name of ['cleanupLease', 'cleanupLeaseSingleflight', 'stopSession', 'cleanupExpiredSessions']) {
  noLocalReachability(controlAst, block(controlAst, name), forbiddenCleanup, `Ephemeral cleanup ${name}`);
}
noLocalReachability(sessionRuntime, block(sessionRuntime, 'retireLeaseLocal'), forbiddenCleanup, 'Mismatched legacy lease retirement');
const cleanup = block(controlAst, 'cleanupLease');
requireCall(cleanup, 'deleteLease');
requireCall(cleanup, 'runtimeSessions.delete');
const decommission = block(controlAst, 'decommissionVaultMembership');
requireCall(decommission, 'masterForVault');
const kick = requireCall(controlAst, 'kickAndUnban');
if (kick.pos < decommission.pos || kick.end > decommission.end) fail('kickAndUnban must be reachable only from explicit decommission.');
const activation = block(controlAst, 'activateSession');
requireCall(activation, 'masterForVault');
requireCall(activation, 'inviteAndPromote');
if (!nodes(activation, node => ts.isNewExpression(node) && node.expression.getText() === 'Api.channels.GetParticipant').length) fail('Exceptional provisioning must verify participant membership.');
const invite = block(controlAst, 'inviteAndPromote');
for (const rpc of ['Api.channels.InviteToChannel', 'Api.channels.EditAdmin']) {
  one(nodes(invite, node => ts.isNewExpression(node) && node.expression.getText() === rpc), `exceptional provisioning ${rpc}`);
}
const rights = one(nodes(invite, node => ts.isNewExpression(node) && node.expression.getText() === 'Api.ChatAdminRights'), 'transport admin rights');
for (const right of ['pinMessages', 'deleteMessages']) {
  const field = one(nodes(rights, node => ts.isPropertyAssignment(node) && node.name.getText() === right), `required ${right} permission`);
  if (field.initializer.kind !== ts.SyntaxKind.TrueKeyword) fail(`${right} (pin_messages/delete_messages) is required for Direct INDEX/media maintenance.`);
}

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
for (const [name, requiredCalls] of [
  ['getCurrentIndex', ['active.downloadAsBuffer']],
  ['sendDocument', ['active.sendMedia', 'Readable.toWeb']],
  ['upload', ['sendDocument', 'getMessage']],
  ['downloadToPath', ['active.downloadAsIterable']],
  ['downloadRange', ['active.downloadAsIterable']],
  ['ensureIndex', ['sendDocument']],
  ['replaceIndex', ['sendDocument', 'active.pinMessage', 'active.getFullChat', 'getMessage', 'mergeDeleted']],
]) {
  const operation = block(helperAst, name);
  for (const call of requiredCalls) requireCall(operation, call);
  noCalls(operation, /fetch|axios|https?\.(?:request|post|get)/, `Direct helper ${name}`);
}
const replace = block(helperAst, 'replaceIndex');
if (calls(replace, 'active.deleteMessagesById').length !== 2) fail('INDEX replacement must retain old-index and replaced-media deletion.');
before(requireCall(replace, 'active.pinMessage'), requireCall(replace, 'active.getFullChat'), 'INDEX pin must be verified after pinning.');

// Desktop must use the control plane gates and never fall back to legacy media transport.
if (rust.includes('fallback=legacy') || rust.includes('HELPER_UNAVAILABLE')) fail('Desktop can silently fall back to the old data plane.');
for (const route of ['/beats/upload', '/projects/upload', '/cloud-files/upload', '/beats/download', '/beats/stream', '/metadata/artwork', '/metadata/upsert']) {
  if (rust.includes(route)) fail(`Desktop still contains legacy media route ${route}.`);
}
if (!rust.includes('DIRECT_HEARTBEAT_SECONDS: u64 = 60')) fail('Desktop heartbeat is no longer one minute.');
if (!rust.includes('recv_timeout(remaining)')) fail('Desktop helper response wait can block forever again.');
if (!rust.includes('direct_terminate_unresponsive_helper(runtime)')) fail('Desktop does not terminate and reap an unresponsive helper after its response deadline.');
const shutdownBlock = boundedSection(rust, 'fn kill_direct_runtime_without_releasing', 'fn replace_direct_runtime_from_session');
if (shutdownBlock.includes('direct_send_helper_command')) fail('Desktop shutdown waits for a helper acknowledgement and can deadlock behind an upload.');
if (!rust.includes('DIRECT_TRANSPORT_LEASE_META')) fail('Heartbeat metadata is no longer separated from long helper I/O operations.');
if (!rust.includes('using that lock here would suppress heartbeats during')) fail('Long transfers can silently block the one-minute heartbeat again.');
if (!rust.includes('/transport/session/heartbeat')) fail('Desktop heartbeat route is missing.');
if (!rust.includes('/transport/session/activate')) fail('Desktop membership-update activation is missing.');
if (!rust.includes('/transport/operation/begin') || !rust.includes('/transport/operation/end')) fail('Desktop no longer gates every Direct operation.');
if (!rust.includes('galer-direct-temp-mtproto')) fail('Desktop does not require temporary MTProto transport mode.');
const spawnBlock = boundedSection(rust, 'fn spawn_direct_helper', 'fn kill_direct_runtime_without_releasing');
if (spawnBlock.includes('ensure_local_bot_api')) fail('Desktop helper startup still launches Local Bot API.');
if (spawnBlock.includes('bot_api_base')) fail('Desktop bootstrap still injects bot_api_base.');
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

// Control-plane routes authenticate before touching leases or membership.
const routeBlock = route => {
  const registration = one(calls(coreAst, 'app.post').filter(call => call.arguments[0]?.text === route), `route ${route}`);
  const handler = registration.arguments.at(-1);
  if (!handler || (!ts.isArrowFunction(handler) && !ts.isFunctionExpression(handler)) || !ts.isBlock(handler.body)) fail(`Missing route handler boundary ${route}.`);
  return handler.body;
};
for (const route of ['/transport/session/start', '/transport/session/activate', '/transport/session/heartbeat', '/transport/session/stop', '/transport/operation/begin', '/transport/operation/end', '/transport/index/commit']) {
  const handler = routeBlock(route);
  const authCall = requireCall(handler.statements[0], 'authenticatedTransportAccount');
  const authGuard = handler.statements[1];
  if (!ts.isIfStatement(authGuard) || compact(authGuard.expression) !== '!auth' || !ts.isReturnStatement(authGuard.thenStatement)) fail(`Unauthenticated ${route} must return before doing work.`);
  before(authCall, authGuard, `${route} must authenticate before checking authorization.`);
}
const activateRoute = routeBlock('/transport/session/activate');
const choice = one(nodes(activateRoute, node => ts.isVariableDeclaration(node) && node.name.getText() === 'activationMethod'), 'explicit repair routing');
if (!ts.isConditionalExpression(choice.initializer) || compact(choice.initializer.condition) !== 'req.body?.repairMembership===true' || choice.initializer.whenTrue.text !== 'repairMembership' || choice.initializer.whenFalse.text !== 'activateSession') fail('Membership repair must be requested explicitly with repairMembership === true.');
requireCall(activateRoute, 'directTransport[activationMethod]');

// The control module keeps credentials internally; the installed HTTP boundary
// must strip permanent secrets before returning temporary authorization.
const tempBoundary = parse('productive-temp-auth-boundary.js', read('cloud-server', 'productive-temp-auth-boundary.js'));
const installTemp = requireCall(boot, 'installProductiveTempAuthBoundary');
const loadCore = one(calls(boot, 'require').filter(call => call.arguments[0]?.text === './server-core'), 'contained core bootstrap');
before(installTemp, loadCore, 'Temporary-auth boundary must install before registering HTTP routes.');
const strip = block(tempBoundary, 'stripPermanentSecrets');
const strippedNames = nodes(strip, ts.isBindingElement).map(node => node.propertyName?.getText()).filter(Boolean);
for (const secret of ['bot_token', 'telegram_api_id', 'telegram_api_hash', 'credential_envelope']) {
  if (!strippedNames.includes(secret)) fail(`HTTP temporary-auth boundary must strip ${secret}.`);
}
const transform = block(tempBoundary, 'transformSession');
requireCall(transform, 'stripPermanentSecrets');
if (nodes(transform, node => ts.isSpreadAssignment(node) && node.expression.getText() === 'session').length) fail('Temporary-auth responses must not spread permanent session credentials.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyDirectArchitecture();
    console.log('PASS Direct persistent guard: PostgreSQL ownership/lazy rollout, assigned sessions, READY without MASTER, ephemeral cleanup, explicit same-bot repair/decommission, secret/temp-auth boundary and Direct INDEX/media with pin/delete rights.');
  } catch (error) {
    console.error(`FAIL Direct persistent guard: ${error.message}`);
    process.exitCode = 1;
  }
}
