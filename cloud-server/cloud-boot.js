'use strict';

const { createGuardContext } = require('./account-route-guards');
const { serverEnv } = require('./runtime-env');

// Explicit handoff from server.js (which prepares the boot) to server-core (which creates the Express app once at load).
let pending;

// Guard entries server.js installs unconditionally before loading server-core. In production (NODE_ENV=production) a
// boot without them fails closed: server-core would otherwise mount guards that let every request through.
const REQUIRED_PRODUCTION_ENTRIES = Object.freeze([
  'runtime', 'securityHeaders', 'legacyMediaUploadDisable', 'authPublicRegistrationHardening', 'pendingSignupBoundary',
  'accountLifecycle', 'sessionSecurity', 'httpContainment', 'directCapability', 'authAbuse', 'tempAuthBoundary',
]);

function failClosed(message) {
  throw new Error(`STOP: ${message}; refusing to start in production (server.js must prepare the boot).`);
}

function prepareCloudBoot({ guards, catalog } = {}) {
  pending = { guards: guards || createGuardContext(), catalog };
}

// Catalog services are assembled after the boot is prepared: attach them to the pending context.
// Without a prepared boot: in production an error; otherwise default (pass-through) guards and a warning.
function prepareCloudCatalog(services, assertVaultRebindAllowed) {
  if (!pending) {
    if (serverEnv.isProduction()) failClosed('catalog prepared without a prepared cloud boot');
    console.warn('[boot] catálogo preparado sin contexto de arranque');
  }
  pending = { ...pending, guards: pending?.guards || createGuardContext(), catalog: { services, assertVaultRebindAllowed } };
}

// Consumed exactly once. Without a prepared boot (or, in production, without the required guard entries): in production
// an error thrown while server-core loads, before it can listen; otherwise an empty context (guards pass through) and a
// single warning.
function takeCloudBoot() {
  const boot = pending;
  pending = undefined;
  if (serverEnv.isProduction()) {
    if (!boot) failClosed('server-core loaded without a prepared cloud boot');
    const missing = REQUIRED_PRODUCTION_ENTRIES.filter(name => !boot.guards?.entries?.[name]);
    if (missing.length) failClosed(`cloud boot without required guard entries (${missing.join(', ')})`);
  }
  if (boot) return boot;
  console.warn('[boot] server-core sin contexto de arranque');
  return { guards: createGuardContext(), catalog: undefined };
}

module.exports = { prepareCloudBoot, prepareCloudCatalog, takeCloudBoot, REQUIRED_PRODUCTION_ENTRIES };
