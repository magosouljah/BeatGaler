'use strict';

const { createCatalogRouter } = require('./catalog/routes');

async function assertVaultRebindAllowedIfConfigured(authority, input) {
  if (!authority) return { native: false, configured: false };
  return authority.assertVaultRebindAllowed(input);
}

// `catalog` ({ services, assertVaultRebindAllowed }) comes from the boot context (cloud-boot); absent => empty router (503).
function mountCatalog(app, authenticate, catalog) {
  app.use(createCatalogRouter({ ...catalog?.services, authenticate, log: console.warn }));
  return catalog?.assertVaultRebindAllowed ?? (input => assertVaultRebindAllowedIfConfigured(null, input));
}

module.exports = { mountCatalog, assertVaultRebindAllowedIfConfigured };
