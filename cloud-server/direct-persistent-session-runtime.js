'use strict';

const crypto = require('crypto');

const INSTALL_MARK = Symbol.for('beatgaler.direct.persistent-session-start');

function codedError(message, code, transportBotId = null) {
  const error = new Error(message);
  error.code = code;
  if (transportBotId) error.transportBotId = String(transportBotId);
  return error;
}

function publicPoolSnapshot(status) {
  const bots = Array.isArray(status?.bots) ? status.bots : [];
  const pool = bots
    .map(bot => ({ id: String(bot?.id || '').trim() }))
    .filter(bot => bot.id);
  const state = { bots: {} };
  for (const bot of bots) {
    const id = String(bot?.id || '').trim();
    if (!id) continue;
    state.bots[id] = {
      quarantined: Boolean(bot?.quarantined),
      rotation_pending: Boolean(bot?.rotation_pending),
    };
  }
  return { pool, state };
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

  const { pool } = publicPoolSnapshot(status);
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

function rollbackPreparedLease({ directTransport, pool, lease }) {
  if (!lease?.session_id) return;
  directTransport.__test.mutateState(pool, state => {
    const current = state.leases?.[String(lease.session_id)];
    if (!current) return;
    if (
      String(current.bot_id || '') !== String(lease.bot_id || '') ||
      String(current.installation_id || '') !== String(lease.installation_id || '') ||
      String(current.chat_id || '') !== String(lease.chat_id || '')
    ) return;
    retireLeaseLocal(state, current);
  });
}

function installPersistentDirectSessionStart({ directTransport, persistentAssignments } = {}) {
  if (!directTransport || typeof directTransport.startSession !== 'function') {
    throw new Error('Direct transport startSession() is required.');
  }
  if (!persistentAssignments || typeof persistentAssignments.resolveForVault !== 'function') {
    throw new Error('Persistent Direct assignment resolver is required.');
  }
  if (directTransport[INSTALL_MARK]?.wrappedStartSession) return directTransport[INSTALL_MARK];

  const originalStartSession = directTransport.startSession.bind(directTransport);
  const wrappedStartSession = async (args = {}) => {
    const installationId = String(args.installationId || '').trim();
    const chatId = String(args.chatId || '').trim();
    if (!installationId || !chatId) return originalStartSession(args);

    const status = directTransport.poolStatus();
    if (!status?.configured) return originalStartSession(args);

    const { pool, state } = publicPoolSnapshot(status);
    const resolved = await persistentAssignments.resolveForVault({ pool, state, chatId });
    const assignedBotId = String(resolved?.assignment?.transportBotId || resolved?.bot?.id || '').trim();
    if (!assignedBotId) {
      throw codedError(
        `Vault ${chatId} has no persistent transport assignment.`,
        'TRANSPORT_ASSIGNMENT_MISSING',
      );
    }

    const prepared = prepareAssignedLease({
      directTransport,
      status,
      transportBotId: assignedBotId,
      installationId,
      chatId,
    });

    try {
      // The runtime requires this exact PostgreSQL-assigned lease. It has no
      // allocator fallback; unavailable ownership fails without choosing a bot.
      const session = await originalStartSession(args);
      if (String(session?.transport_id || '') !== assignedBotId) {
        throw codedError(
          `Direct session used ${session?.transport_id || '<none>'} but PostgreSQL assigned ${assignedBotId}.`,
          'TRANSPORT_ASSIGNMENT_INVARIANT_VIOLATION',
          assignedBotId,
        );
      }
      return session;
    } catch (error) {
      if (!prepared.reused) rollbackPreparedLease({ directTransport, pool: prepared.pool, lease: prepared.lease });
      throw error;
    }
  };

  directTransport.startSession = wrappedStartSession;
  const installed = Object.freeze({ originalStartSession, wrappedStartSession });
  Object.defineProperty(directTransport, INSTALL_MARK, {
    configurable: true,
    enumerable: false,
    value: installed,
  });
  return installed;
}

module.exports = {
  installPersistentDirectSessionStart,
  publicPoolSnapshot,
  prepareAssignedLease,
  retireLeaseLocal,
};
