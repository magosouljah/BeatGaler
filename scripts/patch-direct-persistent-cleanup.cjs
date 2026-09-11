'use strict';

const fs = require('node:fs');

const file = 'cloud-server/direct-transport-control.js';
const source = fs.readFileSync(file, 'utf8');
const marker = "async function cleanupLease(leaseInput, { reason = 'session_end' } = {}) {";
const start = source.indexOf(marker);
const end = source.indexOf('\n\nasync function cleanupLeaseSingleflight', start);
if (start < 0 || end < 0) throw new Error('Could not locate cleanupLease block exactly.');
if (source.indexOf(marker, start + 1) !== -1) throw new Error('cleanupLease marker is not unique.');

const replacement = `async function cleanupLease(leaseInput, { reason = 'session_end' } = {}) {
  const pool = loadPool();
  const snapshot = stateSnapshot(pool);
  const lease = snapshot.leases[String(leaseInput?.session_id || leaseInput || '')];
  if (!lease) return { ok: true, released: false };

  // Session lifecycle is intentionally membership-neutral. Persistent
  // vault<->transport ownership survives logout, tab close, heartbeat timeout,
  // crash/stale cleanup and session replacement. No MASTER lookup, getEntity,
  // kick, unban or membership probe belongs on this path.
  mutateState(pool, state => {
    const current = state.leases[lease.session_id];
    if (current) current.status = 'STOPPING';
  });

  // deleteLease removes every operation owned by the lease. runtimeSessions is
  // the remaining process-local credential/session material for this lease.
  deleteLease(lease.session_id);
  runtimeSessions.delete(lease.session_id);

  const remaining = leasesForBot(stateSnapshot(pool), lease.bot_id).length;
  let rotation = { rotated: false, pending: false, disabled: !TOKEN_ROTATION_ENABLED };
  if (TOKEN_ROTATION_ENABLED && remaining === 0) {
    mutateState(pool, state => {
      const botState = state.bots[lease.bot_id];
      if (botState && !botState.quarantined) botState.rotation_pending = true;
    });
    rotation = await maybeRotatePendingBot(lease.bot_id);
  }

  if (!TOKEN_ROTATION_ENABLED) {
    diag('SESSION_RELEASE_NO_TOKEN_REVOKE', { session_id: lease.session_id, transport_id: lease.bot_id, reason });
  }
  diag('SESSION_RELEASE_MEMBERSHIP_PRESERVED', {
    session_id: lease.session_id,
    transport_id: lease.bot_id,
    vault: lease.chat_id,
    reason,
    remaining_vaults: remaining,
  });
  console.log('[direct] SESSION_RELEASED installation=' + lease.installation_id.slice(0, 8) + '… transport=' + lease.bot_id + ' reason=' + reason + ' remaining_vaults=' + remaining + ' rotation_pending=' + Boolean(rotation?.pending) + ' membership=preserved');
  return {
    ok: true,
    released: true,
    rotation_pending: Boolean(rotation?.pending),
    transport_id: lease.bot_id,
    membership_preserved: true,
  };
}

async function decommissionVaultMembership({ chatId, transportBotId }) {
  const vaultId = String(chatId || '').trim();
  const botId = String(transportBotId || '').trim();
  if (!vaultId || !botId) throw new Error('chatId and transportBotId are required for explicit Direct membership decommission.');
  const pool = loadPool();
  const bot = pool.find(item => item.id === botId);
  if (!bot) throw new Error('Unknown transport bot ' + botId + '.');

  let username = bot.telegram_username || null;
  let userId = bot.telegram_user_id || null;
  if (!username || !userId) {
    const token = await resolveManagedToken(bot);
    const identity = await resolveBotIdentityViaHttp(token);
    username = username || identity.telegram_username;
    userId = userId || identity.telegram_user_id;
  }

  const masterInfo = await masterForVault(vaultId);
  try {
    const botEntity = username
      ? await masterInfo.client.getEntity('@' + String(username).replace(/^@/, ''))
      : await masterInfo.client.getEntity(userId);
    await kickAndUnban(masterInfo.client, masterInfo.vault, botEntity);
    diag('VAULT_MEMBERSHIP_DECOMMISSIONED', { vault: vaultId, transport_id: botId });
    return { ok: true, decommissioned: true, chat_id: vaultId, transport_id: botId };
  } finally {
    try { await masterInfo.client.disconnect(); } catch (_) {}
  }
}`;

let updated = source.slice(0, start) + replacement + source.slice(end);
const exportNeedle = '  stopSession,\n  verifyMessage,';
if ((updated.split(exportNeedle).length - 1) !== 1) throw new Error('Expected unique stopSession export marker.');
updated = updated.replace(exportNeedle, '  stopSession,\n  decommissionVaultMembership,\n  verifyMessage,');
fs.writeFileSync(file, updated, 'utf8');
