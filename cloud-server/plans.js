// BeatGaler Plans architecture v1.
// Server-side authority for plan capabilities, quotas and time-based access grants.
// Prices/billing are intentionally out of scope for v0.4.0.

const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

const PLAN_CATALOG = Object.freeze({
  free: Object.freeze({
    id: "free",
    label: "Free",
    quotas: Object.freeze({
      max_beats: 20,
      max_project_zip_bytes: 500 * MB,
      youtube_uploads_per_day: 3,
      youtube_uploads_per_month: 31,
      max_active_devices: 2,
      max_simultaneous_sessions: 1,
    }),
    entitlements: Object.freeze({
      upload_project: false,
      bulk_youtube_upload: "none",
      early_access: false,
    }),
  }),
  paid_entry: Object.freeze({
    id: "paid_entry",
    label: "Paid Entry",
    quotas: Object.freeze({
      max_beats: 100,
      max_project_zip_bytes: 1024 * MB,
      youtube_uploads_per_day: 10,
      youtube_uploads_per_month: 60,
      max_active_devices: 3,
      max_simultaneous_sessions: 2,
    }),
    entitlements: Object.freeze({
      upload_project: true,
      bulk_youtube_upload: "limited",
      early_access: false,
    }),
  }),
  highest_paid: Object.freeze({
    id: "highest_paid",
    label: "Highest Paid",
    quotas: Object.freeze({
      // null is the API representation of "Unlimited". Enforcement may still
      // apply private anti-abuse hard caps that are not a marketed quota.
      max_beats: null,
      max_project_zip_bytes: 1900 * MB,
      youtube_uploads_per_day: null,
      youtube_uploads_per_month: null,
      max_active_devices: null,
      max_simultaneous_sessions: 2,
    }),
    entitlements: Object.freeze({
      upload_project: true,
      bulk_youtube_upload: "full",
      early_access: true,
    }),
  }),
});

// Growth architecture only. Redemption/generation endpoints come later.
// Both code families grant DAYS of plan access. "unlock" is a collectible / special
// distribution mechanism, not a permanent feature unlock.
const CODE_POLICY = Object.freeze({
  code_types: Object.freeze(["time", "unlock"]),
  existing_user_default_days: 3,
  welcome: Object.freeze({ plan_id: "paid_entry", days: 7 }),
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

function setBasePlanForUser(user, planId) {
  const id = String(planId || "");
  if (!PLAN_CATALOG[id]) throw new Error("Unknown BeatGaler plan.");
  const state = ensurePlanState(user);
  state.basePlanId = id;
  return publicPlanState(user);
}

function createWelcomeGrant(now = Date.now()) {
  return {
    id: `welcome_${now}`,
    source: "welcome",
    planId: CODE_POLICY.welcome.plan_id,
    startsAt: now,
    expiresAt: now + CODE_POLICY.welcome.days * DAY_MS,
  };
}

function ensurePlanState(user, { newAccount = false, now = Date.now() } = {}) {
  if (!user.planState || typeof user.planState !== "object") {
    user.planState = { basePlanId: "free", grants: [] };
    if (newAccount) user.planState.grants.push(createWelcomeGrant(now));
  }
  user.planState.basePlanId = normalizePlanId(user.planState.basePlanId);
  if (!Array.isArray(user.planState.grants)) user.planState.grants = [];
  return user.planState;
}

function planRank(planId) {
  return ({ free: 0, paid_entry: 1, highest_paid: 2 })[normalizePlanId(planId)] || 0;
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
  setBasePlanForUser,
};
