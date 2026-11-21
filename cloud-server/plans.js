// Legacy JSON/rollback plan projection; preserve already-issued grants.
// PostgreSQL Web commerce and runtime access use billing-access-resolver.js.

const { PLAN_DEFINITIONS } = require("./plan-definitions");

const PLAN_CATALOG = Object.freeze(Object.fromEntries(
  Object.entries(PLAN_DEFINITIONS).map(([id, plan]) => [id, Object.freeze({
    id: plan.id,
    label: plan.label,
    quotas: Object.freeze({ ...plan.quotas, ...plan.jsonQuotas }),
    entitlements: plan.capabilities,
  })]),
));

const PLAN_RANKS = Object.freeze(Object.fromEntries(
  Object.entries(PLAN_DEFINITIONS).map(([id, plan]) => [id, plan.rank]),
));

// Growth architecture only. Redemption/generation endpoints come later.
// Both code families grant DAYS of plan access. "unlock" is a collectible / special
// distribution mechanism, not a permanent feature unlock.
const CODE_POLICY = Object.freeze({
  code_types: Object.freeze(["time", "unlock"]),
  existing_user_default_days: 3,
  referral: Object.freeze({
    free: Object.freeze({ rewarded_referrals_per_month: 1, reward_plan_id: "paid_entry", reward_days: 3 }),
    paid_entry: Object.freeze({ rewarded_referrals_per_month: 2, reward_plan_id: "highest_paid", reward_days: 3 }),
    highest_paid: Object.freeze({ rewarded_referrals_per_month: 5, reward_plan_id: "highest_paid", reward_days: 3 }),
  }),
});

function normalizePlanId(value) {
  const id = String(value || "free");
  return PLAN_CATALOG[id] ? id : "free";
}

function ensurePlanState(user) {
  if (!user.planState || typeof user.planState !== "object") {
    user.planState = { basePlanId: "free", grants: [] };
  }
  user.planState.basePlanId = normalizePlanId(user.planState.basePlanId);
  if (!Array.isArray(user.planState.grants)) user.planState.grants = [];
  return user.planState;
}

function planRank(planId) {
  return PLAN_RANKS[normalizePlanId(planId)] || 0;
}

function effectivePlanForUser(user, now = Date.now()) {
  const state = ensurePlanState(user);
  let effectiveId = state.basePlanId;
  let effectiveUntil = null;
  let source = "base_plan";
  for (const grant of state.grants) {
    const startsAt = Number(grant?.startsAt || 0);
    const expiresAt = Number(grant?.expiresAt || 0);
    const grantPlanId = normalizePlanId(grant?.planId);
    if (startsAt > now || expiresAt <= now) continue;
    if (planRank(grantPlanId) > planRank(effectiveId) || (grantPlanId === effectiveId && expiresAt > Number(effectiveUntil || 0))) {
      effectiveId = grantPlanId;
      effectiveUntil = expiresAt;
      source = String(grant?.source || "temporary_grant");
    }
  }
  return { plan: PLAN_CATALOG[effectiveId], effectiveUntil, source };
}

function publicPlanState(user, now = Date.now()) {
  const state = ensurePlanState(user);
  const effective = effectivePlanForUser(user, now);
  return {
    base_plan_id: state.basePlanId,
    effective_plan_id: effective.plan.id,
    label: effective.plan.label,
    effective_until: effective.effectiveUntil,
    access_source: effective.source,
    entitlements: effective.plan.entitlements,
    quotas: effective.plan.quotas,
    referral: CODE_POLICY.referral[state.basePlanId],
  };
}

function publicPlanCatalog() {
  return Object.values(PLAN_CATALOG).map(plan => ({
    id: plan.id,
    label: plan.label,
    entitlements: plan.entitlements,
    quotas: plan.quotas,
  }));
}

module.exports = {
  PLAN_CATALOG,
  CODE_POLICY,
  ensurePlanState,
  publicPlanState,
  publicPlanCatalog,
};
