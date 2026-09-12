'use strict';

// BeatGaler Billing V1 access resolver.
// Pure domain module only: no database, provider, Auth, transport or clock I/O.
// Callers must provide the server instant explicitly through `now`.

function freezePlan(plan) {
  return Object.freeze({
    ...plan,
    capabilities: Object.freeze({ ...plan.capabilities }),
    quotas: Object.freeze({ ...plan.quotas }),
  });
}

const BILLING_V1_ACCESS_CATALOG = Object.freeze({
  free: freezePlan({
    id: 'free',
    label: 'Free',
    rank: 0,
    capabilities: {
      upload_project: false,
      bulk_youtube_upload: 'none',
      early_access: false,
    },
    quotas: {
      max_beats: 20,
      // V1 Free cannot write PROJECT content. Zero is the fail-closed byte ceiling;
      // callers must still enforce upload_project=false as the capability check.
      max_project_zip_bytes: 0,
      youtube_uploads_per_day: 3,
      youtube_uploads_per_month: 31,
    },
  }),
  paid_entry: freezePlan({
    id: 'paid_entry',
    label: 'Paid Entry',
    rank: 1,
    capabilities: {
      upload_project: true,
      bulk_youtube_upload: 'limited',
      early_access: false,
    },
    quotas: {
      max_beats: 100,
      max_project_zip_bytes: 1_000_000_000,
      youtube_uploads_per_day: 10,
      youtube_uploads_per_month: 60,
    },
  }),
  highest_paid: freezePlan({
    id: 'highest_paid',
    label: 'Highest Paid',
    rank: 2,
    capabilities: {
      upload_project: true,
      bulk_youtube_upload: 'full',
      early_access: true,
    },
    quotas: {
      // null means no commercial plan limit. Separate anti-abuse controls may exist.
      max_beats: null,
      max_project_zip_bytes: 1_900_000_000,
      youtube_uploads_per_day: null,
      youtube_uploads_per_month: null,
    },
  }),
});

class BillingAccessInputError extends Error {
  constructor(message, code = 'BILLING_ACCESS_INVALID_INPUT') {
    super(message);
    this.name = 'BillingAccessInputError';
    this.code = code;
  }
}

function firstDefined(record, names) {
  for (const name of names) {
    if (record && record[name] !== undefined && record[name] !== null) return record[name];
  }
  return null;
}

function timestamp(value, fieldName, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BillingAccessInputError(`${fieldName} is required.`);
    return null;
  }

  let result;
  if (value instanceof Date) result = value.getTime();
  else if (typeof value === 'number') result = value;
  else result = Date.parse(String(value));

  if (!Number.isFinite(result)) {
    throw new BillingAccessInputError(`${fieldName} must be a valid timestamp.`);
  }
  return result;
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new BillingAccessInputError('Access catalog is required.');
  }
  if (!catalog.free || catalog.free.id !== 'free' || Number(catalog.free.rank) !== 0) {
    throw new BillingAccessInputError('Access catalog requires the Free baseline.');
  }

  const ranks = new Set();
  for (const [id, plan] of Object.entries(catalog)) {
    if (!plan || plan.id !== id || !Number.isInteger(plan.rank) || plan.rank < 0) {
      throw new BillingAccessInputError(`Access catalog plan ${id} is invalid.`);
    }
    if (ranks.has(plan.rank)) {
      throw new BillingAccessInputError('Access catalog plan ranks must be unique.');
    }
    if (!plan.capabilities || typeof plan.capabilities !== 'object' || !plan.quotas || typeof plan.quotas !== 'object') {
      throw new BillingAccessInputError(`Access catalog plan ${id} requires capabilities and quotas.`);
    }
    ranks.add(plan.rank);
  }
  return catalog;
}

function knownPlanId(catalog, value) {
  const id = String(value || '').trim();
  return catalog[id] ? id : null;
}

function normalizedSubscription(subscription, catalog) {
  const source = subscription && typeof subscription === 'object' ? subscription : {};
  const rawPlanId = firstDefined(source, ['planId', 'plan_id']);
  const planId = knownPlanId(catalog, rawPlanId);
  const nextPlanId = knownPlanId(catalog, firstDefined(source, ['nextPlanId', 'next_plan_id', 'pendingPlanId', 'pending_plan_id']));

  return Object.freeze({
    planId,
    rawPlanId: rawPlanId == null ? null : String(rawPlanId),
    providerStatus: String(firstDefined(source, ['status', 'providerStatus', 'provider_status']) || 'inactive'),
    paidThrough: timestamp(firstDefined(source, ['paidThrough', 'paid_through']), 'subscription.paidThrough'),
    pastDueAt: timestamp(firstDefined(source, ['pastDueAt', 'past_due_at']), 'subscription.pastDueAt'),
    graceUntil: timestamp(firstDefined(source, ['graceUntil', 'grace_until']), 'subscription.graceUntil'),
    accessInvalidatedAt: timestamp(
      firstDefined(source, ['accessInvalidatedAt', 'access_invalidated_at', 'invalidatedAt', 'invalidated_at']),
      'subscription.accessInvalidatedAt',
    ),
    invalidationReason: firstDefined(source, ['invalidationReason', 'invalidation_reason']),
    currentPeriodEnd: timestamp(firstDefined(source, ['currentPeriodEnd', 'current_period_end']), 'subscription.currentPeriodEnd'),
    endedAt: timestamp(firstDefined(source, ['endedAt', 'ended_at']), 'subscription.endedAt'),
    cancelAtPeriodEnd: Boolean(firstDefined(source, ['cancelAtPeriodEnd', 'cancel_at_period_end'])),
    nextPlanId,
    nextInterval: firstDefined(source, ['nextInterval', 'next_interval', 'pendingInterval', 'pending_interval']),
    nextPlanEffectiveAt: timestamp(
      firstDefined(source, ['nextPlanEffectiveAt', 'next_plan_effective_at', 'pendingPlanEffectiveAt', 'pending_plan_effective_at']),
      'subscription.nextPlanEffectiveAt',
    ),
  });
}

function minFuture(...values) {
  const future = values.filter(value => Number.isFinite(value));
  return future.length ? Math.min(...future) : null;
}

function commercialSource(subscription, catalog, now) {
  const planId = subscription.planId;
  if (!planId || planId === 'free') return null;

  if (subscription.accessInvalidatedAt !== null && subscription.accessInvalidatedAt <= now) return null;

  const invalidationLimit = subscription.accessInvalidatedAt !== null && subscription.accessInvalidatedAt > now
    ? subscription.accessInvalidatedAt
    : null;

  if (subscription.paidThrough !== null && now < subscription.paidThrough) {
    return Object.freeze({
      type: 'commercial',
      mode: 'paid',
      planId,
      validUntil: minFuture(subscription.paidThrough, invalidationLimit),
    });
  }

  const graceStarted = subscription.pastDueAt !== null && subscription.pastDueAt <= now;
  const graceActive = graceStarted && subscription.graceUntil !== null && now < subscription.graceUntil;
  if (graceActive) {
    return Object.freeze({
      type: 'commercial',
      mode: 'grace',
      planId,
      validUntil: minFuture(subscription.graceUntil, invalidationLimit),
    });
  }

  return null;
}

function normalizeGrant(grant, catalog, index) {
  if (!grant || typeof grant !== 'object') return null;
  const planId = knownPlanId(catalog, firstDefined(grant, ['planId', 'plan_id']));
  if (!planId) return null;

  const startsAt = timestamp(firstDefined(grant, ['startsAt', 'starts_at']), `grants[${index}].startsAt`);
  const expiresAt = timestamp(firstDefined(grant, ['expiresAt', 'expires_at']), `grants[${index}].expiresAt`);
  const revokedAt = timestamp(firstDefined(grant, ['revokedAt', 'revoked_at']), `grants[${index}].revokedAt`);
  if (startsAt === null || expiresAt === null || expiresAt <= startsAt) return null;

  return Object.freeze({
    id: firstDefined(grant, ['id', 'grantId', 'grant_id']),
    type: 'grant',
    planId,
    source: String(firstDefined(grant, ['source']) || 'temporary_grant'),
    sourceKey: firstDefined(grant, ['sourceKey', 'source_key']),
    startsAt,
    expiresAt,
    revokedAt,
  });
}

function activeGrantSource(grant, now) {
  if (!grant || grant.startsAt > now || grant.expiresAt <= now) return null;
  if (grant.revokedAt !== null && grant.revokedAt <= now) return null;

  return Object.freeze({
    type: 'grant',
    mode: 'grant',
    id: grant.id,
    planId: grant.planId,
    source: grant.source,
    sourceKey: grant.sourceKey,
    validUntil: minFuture(
      grant.expiresAt,
      grant.revokedAt !== null && grant.revokedAt > now ? grant.revokedAt : null,
    ),
  });
}

function sourceRank(source, catalog) {
  return catalog[source.planId]?.rank ?? -1;
}

function chooseEffectivePlan(accessSources, catalog) {
  let effectivePlanId = 'free';
  for (const source of accessSources) {
    if (sourceRank(source, catalog) > catalog[effectivePlanId].rank) {
      effectivePlanId = source.planId;
    }
  }
  return catalog[effectivePlanId];
}

function nextRecalculationAt({ subscription, grants, activeCommercial, activeGrants, now }) {
  const candidates = [];

  if (activeCommercial?.validUntil > now) candidates.push(activeCommercial.validUntil);
  if (subscription.accessInvalidatedAt !== null && subscription.accessInvalidatedAt > now) {
    candidates.push(subscription.accessInvalidatedAt);
  }
  if (
    !activeCommercial &&
    subscription.pastDueAt !== null &&
    subscription.pastDueAt > now &&
    subscription.graceUntil !== null &&
    subscription.graceUntil > subscription.pastDueAt
  ) {
    candidates.push(subscription.pastDueAt);
  }

  for (const active of activeGrants) {
    if (active.validUntil > now) candidates.push(active.validUntil);
  }
  for (const grant of grants) {
    if (grant.startsAt > now && grant.expiresAt > grant.startsAt) candidates.push(grant.startsAt);
  }

  return candidates.length ? Math.min(...candidates) : null;
}

function resolveBillingAccess({
  subscription = null,
  grants = [],
  now,
  catalog = BILLING_V1_ACCESS_CATALOG,
} = {}) {
  validateCatalog(catalog);
  const instant = timestamp(now, 'now', { required: true });
  if (!Array.isArray(grants)) throw new BillingAccessInputError('grants must be an array.');

  const normalized = normalizedSubscription(subscription, catalog);
  const normalizedGrants = grants
    .map((grant, index) => normalizeGrant(grant, catalog, index))
    .filter(Boolean);

  const activeCommercial = commercialSource(normalized, catalog, instant);
  const activeGrants = normalizedGrants
    .map(grant => activeGrantSource(grant, instant))
    .filter(Boolean);

  const accessSources = [
    Object.freeze({ type: 'baseline', mode: 'free', planId: 'free', validUntil: null }),
    ...(activeCommercial ? [activeCommercial] : []),
    ...activeGrants,
  ];
  const effectivePlan = chooseEffectivePlan(accessSources, catalog);

  let commercialAccessState = 'none';
  if (normalized.accessInvalidatedAt !== null && normalized.accessInvalidatedAt <= instant) {
    commercialAccessState = 'invalidated';
  } else if (activeCommercial) {
    commercialAccessState = activeCommercial.mode;
  } else if (normalized.planId && normalized.planId !== 'free') {
    commercialAccessState = 'unverified';
  }

  const result = {
    commercialPlanId: normalized.planId || 'free',
    commercialAccessPlanId: activeCommercial?.planId || null,
    commercialAccessState,
    effectivePlanId: effectivePlan.id,
    label: effectivePlan.label,
    capabilities: effectivePlan.capabilities,
    quotas: effectivePlan.quotas,
    accessSources: Object.freeze(accessSources),
    nextRecalculationAt: nextRecalculationAt({
      subscription: normalized,
      grants: normalizedGrants,
      activeCommercial,
      activeGrants,
      now: instant,
    }),
    billing: Object.freeze({
      providerStatus: normalized.providerStatus,
      paidThrough: normalized.paidThrough,
      pastDueAt: normalized.pastDueAt,
      graceUntil: normalized.graceUntil,
      accessInvalidatedAt: normalized.accessInvalidatedAt,
      invalidationReason: normalized.invalidationReason,
      currentPeriodEnd: normalized.currentPeriodEnd,
      endedAt: normalized.endedAt,
      cancelAtPeriodEnd: normalized.cancelAtPeriodEnd,
      nextPlanId: normalized.nextPlanId,
      nextInterval: normalized.nextInterval,
      nextPlanEffectiveAt: normalized.nextPlanEffectiveAt,
    }),
  };

  return Object.freeze(result);
}

module.exports = {
  BILLING_V1_ACCESS_CATALOG,
  BillingAccessInputError,
  resolveBillingAccess,
};
