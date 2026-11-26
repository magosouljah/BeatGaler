'use strict';

const { createGuardContext } = require('./account-route-guards');

// Explicit handoff from server.js (which prepares the boot) to server-core (which creates the Express app once at load).
let pending;

function prepareCloudBoot({ guards } = {}) {
  pending = { guards: guards || createGuardContext() };
}

// Consumed exactly once. Without a prepared boot: an empty context (guards pass through) and a single warning.
function takeCloudBoot() {
  const boot = pending;
  pending = undefined;
  if (boot) return boot;
  console.warn('[boot] server-core sin contexto de arranque');
  return { guards: createGuardContext() };
}

module.exports = { prepareCloudBoot, takeCloudBoot };
