'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5 * 60_000;

function backendPath(value, fallbackName) {
  const raw = String(value || '').trim();
  if (!raw) return path.join(ROOT, fallbackName);
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

function parseTime(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

function validateCapabilitySessionState(state, input, {
  nowMs = Date.now(),
  heartbeatTimeoutMs = Math.max(60_000, Number(process.env.DIRECT_HEARTBEAT_TIMEOUT_MS || DEFAULT_HEARTBEAT_TIMEOUT_MS)),
} = {}) {
  const sessionId = String(input?.sessionId || '');
  const installationId = String(input?.installationId || '');
  const generation = Number(input?.generation || 0);
  const lease = state?.leases?.[sessionId] || null;
  if (!lease || String(lease.installation_id || '') !== installationId || Number(lease.generation || 0) !== generation) {
    return { ok: false, reason: 'lease_inactive' };
  }

  const status = String(lease.status || '').toUpperCase();
  if (status !== 'ACTIVE') return { ok: false, reason: `lease_${status.toLowerCase() || 'inactive'}` };

  const heartbeatAt = parseTime(lease.last_heartbeat_at || lease.started_at);
  if (!heartbeatAt || nowMs - heartbeatAt >= heartbeatTimeoutMs) {
    return { ok: false, reason: 'lease_expired' };
  }

  const botState = state?.bots?.[String(lease.bot_id || '')] || null;
  if (!botState || botState.quarantined) return { ok: false, reason: 'bot_quarantined' };

  return { ok: true };
}

function readCapabilityState() {
  const stateFile = backendPath(process.env.TRANSPORT_POOL_STATE, 'transport-pool-state.json');
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function validateCapabilitySession(input) {
  const state = readCapabilityState();
  if (!state) return { ok: false, reason: 'state_unavailable' };
  return validateCapabilitySessionState(state, input);
}

function activeOperationIdsForSessionState(state, input, options = {}) {
  const validity = validateCapabilitySessionState(state, input, options);
  if (!validity.ok) return null;
  const sessionId = String(input?.sessionId || '');
  const installationId = String(input?.installationId || '');
  return Object.values(state?.operations || {})
    .filter(operation =>
      String(operation?.session_id || '') === sessionId &&
      String(operation?.installation_id || '') === installationId
    )
    .map(operation => String(operation?.operation_id || '').trim())
    .filter(Boolean);
}

function activeOperationIdsForSession(input) {
  const state = readCapabilityState();
  if (!state) return null;
  return activeOperationIdsForSessionState(state, input);
}

function recordDiagnostic(event, fields = {}) {
  return require('./direct-transport-control').recordDiagnostic(event, fields);
}

async function endOperation(input) {
  return require('./direct-transport-control').endOperation(input);
}

module.exports = {
  activeOperationIdsForSession,
  activeOperationIdsForSessionState,
  endOperation,
  recordDiagnostic,
  validateCapabilitySession,
  validateCapabilitySessionState,
};
