'use strict';

// Automatic welcome grants are disabled. Historic grants remain in the access resolver.

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

async function issueWelcomeAfterActivation(_userId) {
  // Intentionally do not create an entitlement on account activation.
  return null;
}

module.exports = { configure, setLegacyProjectionUpdater, usesPostgresAccess, issueWelcomeAfterActivation };
