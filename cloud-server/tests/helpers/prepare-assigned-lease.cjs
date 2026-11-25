'use strict';

const crypto = require('crypto');

// Seed the legacy Direct state for tests that exercise its lease primitives.
function codedError(message, code, transportBotId = null) {
  const error = new Error(message);
  error.code = code;
  if (transportBotId) error.transportBotId = String(transportBotId);
  return error;
}

function leaseExpired(lease, heartbeatTimeoutMs) {
  const lastHeartbeat = Date.parse(String(lease?.last_heartbeat_at || lease?.started_at || ''));
  if (!Number.isFinite(lastHeartbeat)) return true;
  return Date.now() - lastHeartbeat >= Number(heartbeatTimeoutMs || 0);
}

function retireLeaseLocal(state, lease) {
  if (!lease?.session_id) return;
  const sessionId = String(lease.session_id);
  for (const [operationId, operation] of Object.entries(state.operations || {})) {
    if (String(operation?.session_id || '') === sessionId) delete state.operations[operationId];
  }
  delete state.leases[sessionId];
}

function ensureAssignedBotAdmissible(state, transportBotId) {
  const botId = String(transportBotId || '').trim();
  const botState = state?.bots?.[botId];
  if (!botState) {
    throw codedError(
      `Assigned transport bot ${botId || '<missing>'} is not present in runtime state.`,
      'TRANSPORT_ASSIGNMENT_BOT_UNAVAILABLE',
      botId,
    );
  }
  if (botState.quarantined) {
    throw codedError(
      `Assigned transport bot ${botId} is quarantined; persistent ownership will not fall back to another bot.`,
      'TRANSPORT_ASSIGNMENT_BOT_QUARANTINED',
      botId,
    );
  }
  if (botState.rotation_pending) {
    throw codedError(
      `Assigned transport bot ${botId} is waiting for credential rotation; persistent ownership will not fall back to another bot.`,
      'TRANSPORT_ASSIGNMENT_BOT_ROTATING',
      botId,
    );
  }
  return botState;
}

function prepareAssignedLease({ directTransport, status, transportBotId, installationId, chatId }) {
  const hooks = directTransport?.__test;
  if (typeof hooks?.mutateState !== 'function') {
    throw new Error('Direct transport persistent-session adapter requires mutateState().');
  }

  const installation = String(installationId || '').trim();
  const vaultId = String(chatId || '').trim();
  const botId = String(transportBotId || '').trim();
  if (!installation || !vaultId || !botId) throw new Error('installationId, chatId and transportBotId are required.');

  const bots = Array.isArray(status?.bots) ? status.bots : [];
  const pool = bots.map(bot => ({ id: String(bot?.id || '').trim() })).filter(bot => bot.id);
  if (!pool.some(bot => bot.id === botId)) {
    throw codedError(
      `Assigned transport bot ${botId} is not present in the configured pool.`,
      'TRANSPORT_ASSIGNMENT_BOT_UNAVAILABLE',
      botId,
    );
  }

  const heartbeatTimeoutMs = Number(status?.heartbeat_timeout_ms || 5 * 60_000);
  const prepared = hooks.mutateState(pool, state => {
    const botState = ensureAssignedBotAdmissible(state, botId);
    const existing = Object.values(state.leases || {}).find(lease =>
      String(lease?.installation_id || '') === installation && String(lease?.status || '') !== 'CLEANED'
    ) || null;

    if (
      existing &&
      String(existing.chat_id || '') === vaultId &&
      String(existing.bot_id || '') === botId &&
      String(existing.status || '') !== 'STOPPING' &&
      !leaseExpired(existing, heartbeatTimeoutMs)
    ) {
      existing.last_heartbeat_at = new Date().toISOString();
      return {
        lease: { ...existing },
        reused: true,
        retiredSessionId: null,
      };
    }

    const retiredSessionId = existing?.session_id ? String(existing.session_id) : null;
    if (existing) retireLeaseLocal(state, existing);

    botState.generation = Number(botState.generation || 0) + 1;
    botState.last_assigned_at = new Date().toISOString();
    const timestamp = new Date().toISOString();
    const sessionId = `dts_${crypto.randomBytes(16).toString('hex')}`;
    const lease = {
      session_id: sessionId,
      bot_id: botId,
      installation_id: installation,
      chat_id: vaultId,
      generation: botState.generation,
      credential_version: Math.max(1, Number(botState.credential_version || 1)),
      status: 'ASSIGNING',
      started_at: timestamp,
      last_heartbeat_at: timestamp,
      owner_instance: 'persistent-assignment-wrapper',
    };
    state.leases[sessionId] = lease;
    return {
      lease: { ...lease },
      reused: false,
      retiredSessionId,
    };
  });

  return { ...prepared, pool };
}

module.exports = { prepareAssignedLease };
