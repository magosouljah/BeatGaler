'use strict';

const { BILLING_V1_ACCESS_CATALOG, resolveBillingAccess } = require('./billing-access-resolver');
const { publicPlanState, publicPlanCatalog } = require('./plans');

function publicPlanFromAccess(access) {
  const source = access.accessSources
    .filter(item => item.planId === access.effectivePlanId)
    .reduce((longest, item) => item.validUntil > longest.validUntil ? item : longest, access.accessSources[0]);
  const publicAccess = {
    commercialPlanId: access.commercialPlanId,
    commercialAccessPlanId: access.commercialAccessPlanId,
    commercialAccessState: access.commercialAccessState,
    effectivePlanId: access.effectivePlanId,
    label: access.label,
    capabilities: access.capabilities,
    quotas: access.quotas,
    // Access keeps grant IDs and source keys internally. Account only needs
    // the applied source and its access window.
    accessSources: access.accessSources.map(item => ({
      type: item.type, mode: item.mode, planId: item.planId,
      source: item.source || null, validUntil: item.validUntil,
    })),
    nextRecalculationAt: access.nextRecalculationAt,
    billing: {
      providerStatus: access.billing.providerStatus,
      paidThrough: access.billing.paidThrough,
      pastDueAt: access.billing.pastDueAt,
      graceUntil: access.billing.graceUntil,
      currentPeriodEnd: access.billing.currentPeriodEnd,
      endedAt: access.billing.endedAt,
      cancelAtPeriodEnd: access.billing.cancelAtPeriodEnd,
      nextPlanId: access.billing.nextPlanId,
      nextInterval: access.billing.nextInterval,
      nextPlanEffectiveAt: access.billing.nextPlanEffectiveAt,
    },
  };
  return {
    // These aliases preserve the existing Account and Settings response shape.
    // The commercial plan comes from the subscription projection, never Auth planState.
    base_plan_id: access.commercialPlanId,
    effective_plan_id: access.effectivePlanId,
    label: access.label,
    effective_until: source.validUntil,
    access_source: source.source || source.mode,
    entitlements: access.capabilities,
    quotas: access.quotas,
    access: publicAccess,
  };
}

function createAccessRuntime({ pool = null, now = Date.now } = {}) {
  async function resolveUserAccess(user) {
    if (!pool) return null;
    const userId = String(user?.id || '').trim();
    if (!userId) throw new Error('Access requires an authenticated user.');
    const [subscriptionResult, grantsResult] = await Promise.all([
      pool.query('SELECT * FROM billing_subscription_state WHERE user_id=$1', [userId]),
      pool.query('SELECT * FROM entitlements WHERE user_id=$1 ORDER BY starts_at,id', [userId]),
    ]);
    return resolveBillingAccess({
      subscription: subscriptionResult.rows[0] || null,
      grants: grantsResult.rows,
      now: now(),
    });
  }

  async function resolveUserPlan(user) {
    if (!pool) return publicPlanState(user); // JSON-only legacy development mode.
    return publicPlanFromAccess(await resolveUserAccess(user));
  }

  function planCatalog() {
    if (!pool) return publicPlanCatalog(); // JSON-only legacy development mode.
    return Object.values(BILLING_V1_ACCESS_CATALOG).map(plan => ({
      id: plan.id,
      label: plan.label,
      entitlements: plan.capabilities,
      quotas: plan.quotas,
    }));
  }

  return Object.freeze({ resolveUserAccess, resolveUserPlan, planCatalog });
}

let runtime = createAccessRuntime();

function configure({ pool = null } = {}) {
  runtime = createAccessRuntime({ pool });
}

module.exports = {
  createAccessRuntime,
  configure,
  resolveUserAccess: user => runtime.resolveUserAccess(user),
  resolveUserPlan: user => runtime.resolveUserPlan(user),
  planCatalog: () => runtime.planCatalog(),
};
