import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDirectArchitecture } from './regression-direct-manager-only.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = new Map();
const read = (...parts) => {
  const name = parts.join('/');
  if (!cache.has(name)) cache.set(name, readFileSync(path.join(root, ...parts), 'utf8'));
  return cache.get(name);
};
verifyDirectArchitecture(read);

// In-memory mutations: prove the guards reject plausible regressions without
// ever modifying runtime sources or contacting Telegram/PostgreSQL.
const mutations = [
  ['missing MASTER creation boundary', 'cloud-server/master-storage.js',
    'async function createPrivateUserStorageGroup(', 'async function renamedVaultCreation(', /function boundary createPrivateUserStorageGroup/],
  ['comment cannot install ownership wrapper', 'cloud-server/server.js',
    '  installPersistentDirectSessionStart({\n    directTransport,\n    persistentAssignments: directPersistentAssignments,\n  });',
    '  // installPersistentDirectSessionStart({ directTransport, persistentAssignments: directPersistentAssignments });', /call installPersistentDirectSessionStart/],
  ['conditional membership installation', 'cloud-server/server.js',
    '  installPersistentDirectMembershipActivation({', '  if (false) installPersistentDirectMembershipActivation({', /unconditionally/],
  ['permanent token in PostgreSQL public bot state', 'cloud-server/direct-persistent-assignment-runtime.js',
    'id: String(bot.id),', 'id: String(bot.id), token: bot.token,', /whitelist public identity\/state/],
  ['existing ownership falls through', 'cloud-server/direct-vault-assignment.js',
    "        return assignmentFromRow(current);", "        assignmentFromRow(current);", /Existing ownership must return/],
  ['lease load replaces persistent counts', 'cloud-server/direct-vault-assignment.js',
    'LEFT JOIN vaults v ON v.transport_bot_id=tb.id', 'LEFT JOIN direct_leases v ON v.bot_id=tb.id', /Persistent assignment lost/],
  ['SQL comment cannot preserve candidate ordering', 'cloud-server/direct-vault-assignment.js',
    'ORDER BY COUNT(v.id) ASC,tb.id ASC', 'ORDER BY tb.id DESC /* ORDER BY COUNT(v.id) ASC,tb.id ASC */', /Persistent assignment lost ORDER BY/],
  ['legacy migration bulk assigns ownership', 'cloud-server/migrations/0010_persistent_transport_assignment.sql',
    'COMMIT;', "UPDATE vaults SET transport_bot_id='Bot01';\nCOMMIT;", /nullable without a default or bulk assignment/],
  ['legacy start bypasses assignment', 'cloud-server/direct-persistent-session-runtime.js',
    'if (!status?.configured) return originalStartSession(args);', 'return originalStartSession(args);', /bypass PostgreSQL only/],
  ['prepared lease uses a fallback bot', 'cloud-server/direct-persistent-session-runtime.js',
    'transportBotId: assignedBotId,', "transportBotId: 'Bot01',", /preparation must use the assigned bot/],
  ['missing READY branch fails closed', 'cloud-server/direct-persistent-membership-runtime.js',
    "if (String(initial.membershipState) === 'ready')", "if (String(initial.membershipState) === 'pending')", /branch String\(initial.membershipState\)/],
  ['READY opens MASTER before local return', 'cloud-server/direct-persistent-membership-runtime.js',
    'const initial = await persistentAssignments.getAssignment(chatId);', 'await masterForVault(chatId);\n    const initial = await persistentAssignments.getAssignment(chatId);', /READY activation reaches masterForVault/],
  ['READY local helper opens MASTER indirectly', 'cloud-server/direct-persistent-membership-runtime.js',
    'function readyResult(finalized) {', 'function readyResult(finalized) {\n  masterForVault(finalized.chat_id);', /READY activation reaches masterForVault/],
  ['cleanup reaches a membership-removing helper', 'cloud-server/direct-transport-control.js',
    'function deleteLease(sessionId) {', 'function deleteLease(sessionId) {\n  decommissionVaultMembership({ sessionId });', /Ephemeral cleanup .* reaches decommissionVaultMembership/],
  ['kick moves into normal cleanup', 'cloud-server/direct-transport-control.js',
    "async function cleanupLease(leaseInput, { reason = 'session_end' } = {}) {",
    "async function cleanupLease(leaseInput, { reason = 'session_end' } = {}) {\n  await kickAndUnban(master, vault, bot);", /Ephemeral cleanup .* reaches kickAndUnban/],
  ['repair holds a transaction during Telegram', 'cloud-server/direct-vault-assignment.js',
    "await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);", "await client.query('BEGIN');\n      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);", /without an open SQL transaction/],
  ['repair becomes implicit', 'cloud-server/server-core.js',
    'req.body?.repairMembership === true ? "repairMembership" : "activateSession"', 'req.body?.repairMembership !== false ? "repairMembership" : "activateSession"', /requested explicitly/],
  ['pin permission removed', 'cloud-server/direct-transport-control.js',
    'pinMessages: true,', 'pinMessages: false,', /pinMessages .* is required/],
  ['delete permission removed', 'cloud-server/direct-transport-control.js',
    'deleteMessages: true,', 'deleteMessages: false,', /deleteMessages .* is required/],
  ['participant verification becomes a comment', 'cloud-server/direct-transport-control.js',
    'new Api.channels.GetParticipant({', 'new Api.channels.GetFullChannel(/* new Api.channels.GetParticipant */ {', /verify participant membership/],
  ['INDEX upload call becomes a comment', 'src-tauri/direct-transport/transport-helper.source.mjs',
    'const sent = await sendDocument(filePath, "beatgaler-library.json", INDEX_CAPTION);', 'const sent = fakeUpload(filePath); /* sendDocument(filePath, "beatgaler-library.json", INDEX_CAPTION) */', /call sendDocument/],
  ['permanent token crosses HTTP boundary', 'cloud-server/productive-temp-auth-boundary.js',
    '    bot_token: _botToken,', '    // bot_token: _botToken,', /must strip bot_token/],
  ['stop skips authentication', 'cloud-server/server-core.js',
    'app.post("/transport/session/stop", async (req, res) => {\n  const auth = authenticatedTransportAccount(req, res);',
    'app.post("/transport/session/stop", async (req, res) => {\n  const auth = { beatgalerUserId: "untrusted" }; // authenticatedTransportAccount(req, res)', /call authenticatedTransportAccount/],
  ['missing Rust shutdown boundary', 'src-tauri/src/commands.rs',
    'fn kill_direct_runtime_without_releasing(', 'fn renamed_shutdown(', /Missing or ambiguous source boundaries/],
];

for (const [label, filename, original, replacement, expected] of mutations) {
  const source = read(...filename.split('/'));
  assert.ok(source.includes(original), `${label}: mutation anchor must exist`);
  const changed = source.replace(original, replacement);
  assert.throws(() => verifyDirectArchitecture((...parts) => parts.join('/') === filename ? changed : read(...parts)), expected, label);
}
console.log(`PASS Direct persistent guard mutation checks: ${mutations.length} unsafe changes rejected; original sources pass.`);
