'use strict';

// Web catalog compatibility. Historic grants are resolved by billing-access-resolver.js.
let postgres = null;

function configure({ pool = null, authRuntime = null } = {}) {
  postgres = pool && authRuntime ? { pool, authRuntime } : null;
}

function usesPostgresAccess() {
  return Boolean(postgres);
}

module.exports = { configure, usesPostgresAccess };
