'use strict';

const { createCatalogRouter } = require('./catalog/routes');

// server-core consumes this handoff when it mounts its Express instance.
let pendingCatalog;

async function assertVaultRebindAllowedIfConfigured(authority, input) {
  if (!authority) return { native: false, configured: false };
  return authority.assertVaultRebindAllowed(input);
}

function configureCatalogBoot(services, assertVaultRebindAllowed) {
  pendingCatalog = { services, assertVaultRebindAllowed };
}

function mountCatalog(app, authenticate) {
  const catalog = pendingCatalog;
  app.use(createCatalogRouter({ ...catalog?.services, authenticate, log: console.warn }));
  pendingCatalog = undefined;
  return catalog?.assertVaultRebindAllowed ?? (input => assertVaultRebindAllowedIfConfigured(null, input));
}

module.exports = { configureCatalogBoot, mountCatalog, assertVaultRebindAllowedIfConfigured };
