'use strict';

function createPlanCatalogHandler({ usesPostgresAccess, webPlanCatalog, legacyPlanCatalog, codePolicy }) {
  return (_req, res) => res.json({
    ok: true,
    plans: usesPostgresAccess() ? webPlanCatalog() : legacyPlanCatalog(),
    code_policy: {
      existing_user_default_days: codePolicy.existing_user_default_days,
      welcome: codePolicy.welcome,
      code_types: codePolicy.code_types,
    },
  });
}

module.exports = { createPlanCatalogHandler };
