'use strict';

const { issueWelcomeGrant } = require('./access-grant-store');

let postgres = null;
let updateLegacyProjection = null;

function configure({ pool = null, authRuntime = null } = {}) {
  postgres = pool && authRuntime ? { pool, authRuntime } : null;
  updateLegacyProjection = null;
}

function setLegacyProjectionUpdater(update) {
  updateLegacyProjection = typeof update === 'function' ? update : null;
}

function usesPostgresAccess() {
  return Boolean(postgres);
}

async function issueWelcomeAfterActivation(userId) {
  if (!postgres) return null;
  // New users are first persisted by Auth. Wait for that durable user row
  // before the Access-owned insert with its foreign key to users.
  await postgres.authRuntime.flush();
  const grant = await issueWelcomeGrant(postgres.pool, userId);
  if (!grant.revoked_at) updateLegacyProjection?.(userId, grant);
  return grant;
}

module.exports = { configure, setLegacyProjectionUpdater, usesPostgresAccess, issueWelcomeAfterActivation };
