'use strict';

const { createDirectVaultAssignmentStore } = require('./direct-vault-assignment');

let assignmentStore = null;

function assignmentError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function configure({ pool = null, store = null } = {}) {
  if (store) {
    for (const method of [
      'syncTransportBots',
      'assignIfMissing',
      'getAssignment',
      'withMembershipLock',
      'markMembershipReady',
      'markMembershipRepairNeeded',
    ]) {
      if (typeof store[method] !== 'function') {
        throw new Error(`Persistent Direct assignment store must implement ${method}().`);
      }
    }
    assignmentStore = store;
    return assignmentStore;
  }
  assignmentStore = pool ? createDirectVaultAssignmentStore(pool) : null;
  return assignmentStore;
}

function requiredStore() {
  if (!assignmentStore) {
    throw assignmentError(
      'Persistent Direct vault assignment requires PostgreSQL.',
      'TRANSPORT_ASSIGNMENT_POSTGRES_REQUIRED',
    );
  }
  return assignmentStore;
}

function publicPoolState(pool, state) {
  return (pool || []).map(bot => ({
    id: String(bot.id),
    quarantined: Boolean(state?.bots?.[bot.id]?.quarantined),
    rotationPending: Boolean(state?.bots?.[bot.id]?.rotation_pending),
  }));
}

async function resolveForVault({ pool, state, chatId }) {
  const vaultId = String(chatId || '').trim();
  if (!vaultId) throw new Error('chatId is required for persistent Direct assignment.');
  const store = requiredStore();

  // The JSON/config pool still owns runtime credentials. PostgreSQL receives
  // only public operational identity/state so it can choose persistent
  // ownership without ever storing tokens or other transport secrets.
  await store.syncTransportBots(publicPoolState(pool, state));
  const assignment = await store.assignIfMissing({ chatId: vaultId });
  const assignedId = String(assignment?.transportBotId || '').trim();
  if (!assignedId) {
    throw assignmentError(
      `Vault ${vaultId} has no persistent transport assignment.`,
      'TRANSPORT_ASSIGNMENT_MISSING',
    );
  }

  const bot = (pool || []).find(item => String(item.id) === assignedId) || null;
  if (!bot) {
    // Existing ownership is never rewritten just because its configured bot is
    // temporarily absent. A later repair/decommission path must decide that.
    throw assignmentError(
      `Assigned transport bot ${assignedId} is not present in the configured pool.`,
      'TRANSPORT_ASSIGNMENT_BOT_UNAVAILABLE',
    );
  }
  return Object.freeze({ assignment, bot });
}

async function getAssignment(chatId) {
  const vaultId = String(chatId || '').trim();
  if (!vaultId) throw new Error('chatId is required for persistent Direct assignment.');
  return requiredStore().getAssignment({ chatId: vaultId });
}

async function withMembershipLock(chatId, callback) {
  const vaultId = String(chatId || '').trim();
  if (!vaultId) throw new Error('chatId is required for Direct membership lock.');
  return requiredStore().withMembershipLock({ chatId: vaultId }, callback);
}

async function markMembershipReady(chatId, expectedTransportBotId) {
  const vaultId = String(chatId || '').trim();
  if (!vaultId) throw new Error('chatId is required to mark Direct membership ready.');
  return requiredStore().markMembershipReady({ chatId: vaultId }, expectedTransportBotId);
}

async function markMembershipRepairNeeded(chatId, expectedTransportBotId) {
  const vaultId = String(chatId || '').trim();
  if (!vaultId) throw new Error('chatId is required to mark Direct membership repair.');
  return requiredStore().markMembershipRepairNeeded({ chatId: vaultId }, expectedTransportBotId);
}

function _resetForTests() {
  assignmentStore = null;
}

module.exports = {
  configure,
  resolveForVault,
  getAssignment,
  withMembershipLock,
  markMembershipReady,
  markMembershipRepairNeeded,
  publicPoolState,
  _resetForTests,
};
