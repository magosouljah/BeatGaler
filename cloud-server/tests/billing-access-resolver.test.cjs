'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  BILLING_V1_ACCESS_CATALOG,
  BillingAccessInputError,
  resolveBillingAccess,
} = require('../billing-access-resolver');

const at = value => Date.parse(value);
const NOW = at('2026-09-11T18:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function resolve(overrides = {}) {
  return resolveBillingAccess({ now: NOW, ...overrides });
}

test('V1 access catalog matches approved policy and removes historical commercial device/session limits', () => {
  const free = BILLING_V1_ACCESS_CATALOG.free;
  const paid = BILLING_V1_ACCESS_CATALOG.paid_entry;
  const highest = BILLING_V1_ACCESS_CATALOG.highest_paid;

  assert.equal(free.quotas.max_beats, 20);
  assert.equal(free.capabilities.upload_project, false);
  assert.equal(free.quotas.max_project_zip_bytes, 0);
  assert.equal(free.quotas.youtube_uploads_per_day, 3);
  assert.equal(free.quotas.youtube_uploads_per_month, 31);

  assert.equal(paid.quotas.max_beats, 100);
  assert.equal(paid.capabilities.upload_project, true);
  assert.equal(paid.quotas.max_project_zip_bytes, 1_000_000_000);
  assert.equal(paid.capabilities.bulk_youtube_upload, 'limited');

  assert.equal(highest.quotas.max_beats, null);
  assert.equal(highest.quotas.max_project_zip_bytes, 1_900_000_000);
  assert.equal(highest.quotas.youtube_uploads_per_day, null);
  assert.equal(highest.quotas.youtube_uploads_per_month, null);
  assert.equal(highest.capabilities.bulk_youtube_upload, 'full');
  assert.equal(highest.capabilities.early_access, true);

  for (const plan of [free, paid, highest]) {
    assert.equal(Object.hasOwn(plan.quotas, 'max_active_devices'), false);
    assert.equal(Object.hasOwn(plan.quotas, 'max_simultaneous_sessions'), false);
  }
});

test('provider status and current_period_end alone never prove paid access', () => {
  const result = resolve({
    subscription: {
      plan_id: 'highest_paid',
      status: 'active',
      current_period_end: NOW + 30 * DAY,
    },
  });

  assert.equal(result.commercialPlanId, 'highest_paid');
  assert.equal(result.commercialAccessPlanId, null);
  assert.equal(result.commercialAccessState, 'unverified');
  assert.equal(result.effectivePlanId, 'free');
  assert.equal(result.quotas.max_beats, 20);
});

test('confirmed paid_through grants the paid tier even when cancellation is scheduled', () => {
  const paidThrough = NOW + 10 * DAY;
  const result = resolve({
    subscription: {
      plan_id: 'paid_entry',
      status: 'canceled',
      paid_through: paidThrough,
      cancel_at_period_end: true,
      current_period_end: paidThrough,
    },
  });

  assert.equal(result.commercialAccessState, 'paid');
  assert.equal(result.commercialAccessPlanId, 'paid_entry');
  assert.equal(result.effectivePlanId, 'paid_entry');
  assert.equal(result.billing.cancelAtPeriodEnd, true);
  assert.equal(result.nextRecalculationAt, paidThrough);
});

test('paid access ends exactly at paid_through when there is no valid grace or grant', () => {
  const paidThrough = NOW;
  const result = resolve({
    subscription: {
      plan_id: 'paid_entry',
      status: 'canceled',
      paid_through: paidThrough,
      cancel_at_period_end: true,
    },
  });

  assert.equal(result.commercialAccessPlanId, null);
  assert.equal(result.commercialAccessState, 'unverified');
  assert.equal(result.effectivePlanId, 'free');
});

test('welcome grant gives Paid Entry only while its server-time window is active', () => {
  const startsAt = NOW - DAY;
  const expiresAt = NOW + 6 * DAY;
  const grant = {
    id: 'welcome-user-1',
    source: 'welcome',
    source_key: 'welcome-v1',
    plan_id: 'paid_entry',
    starts_at: startsAt,
    expires_at: expiresAt,
  };

  const active = resolve({ grants: [grant] });
  assert.equal(active.effectivePlanId, 'paid_entry');
  assert.equal(active.accessSources.some(source => source.type === 'grant' && source.source === 'welcome'), true);
  assert.equal(active.nextRecalculationAt, expiresAt);

  const expired = resolveBillingAccess({ now: expiresAt, grants: [grant] });
  assert.equal(expired.effectivePlanId, 'free');
  assert.equal(expired.accessSources.length, 1);
});

test('a future grant does not grant access early and schedules recalculation at its start', () => {
  const startsAt = NOW + DAY;
  const expiresAt = NOW + 8 * DAY;
  const result = resolve({
    grants: [{
      source: 'promotion',
      planId: 'highest_paid',
      startsAt,
      expiresAt,
    }],
  });

  assert.equal(result.effectivePlanId, 'free');
  assert.equal(result.nextRecalculationAt, startsAt);
});

test('a lower active grant never reduces or shortens a higher paid plan', () => {
  const paidThrough = NOW + 30 * DAY;
  const grantExpires = NOW + DAY;
  const result = resolve({
    subscription: {
      plan_id: 'highest_paid',
      status: 'active',
      paid_through: paidThrough,
    },
    grants: [{
      source: 'welcome',
      plan_id: 'paid_entry',
      starts_at: NOW - DAY,
      expires_at: grantExpires,
    }],
  });

  assert.equal(result.effectivePlanId, 'highest_paid');
  assert.equal(result.commercialAccessState, 'paid');
  assert.equal(result.accessSources.filter(source => source.planId === 'paid_entry').length, 1);
  assert.equal(result.nextRecalculationAt, grantExpires);
});

test('simultaneous grants choose the highest tier and never add quotas together', () => {
  const result = resolve({
    grants: [
      {
        id: 'g-paid',
        source: 'welcome',
        plan_id: 'paid_entry',
        starts_at: NOW - DAY,
        expires_at: NOW + 6 * DAY,
      },
      {
        id: 'g-high',
        source: 'admin',
        plan_id: 'highest_paid',
        starts_at: NOW - DAY,
        expires_at: NOW + 2 * DAY,
      },
    ],
  });

  assert.equal(result.effectivePlanId, 'highest_paid');
  assert.equal(result.quotas.max_beats, null);
  assert.equal(result.quotas.youtube_uploads_per_day, null);
  assert.equal(result.accessSources.filter(source => source.type === 'grant').length, 2);
});

test('failed first payment does not grant Paid access', () => {
  const result = resolve({
    subscription: {
      plan_id: 'paid_entry',
      status: 'past_due',
      past_due_at: NOW - DAY,
      grace_until: null,
      paid_through: null,
    },
  });

  assert.equal(result.commercialAccessState, 'unverified');
  assert.equal(result.effectivePlanId, 'free');
});

test('failed renewal grace preserves only the last paid tier, never a pending upgrade', () => {
  const graceUntil = NOW + 4 * DAY;
  const subscription = {
    plan_id: 'paid_entry',
    status: 'past_due',
    paid_through: NOW - 2 * DAY,
    past_due_at: NOW - DAY,
    grace_until: graceUntil,
    next_plan_id: 'highest_paid',
    next_plan_effective_at: NOW - 2 * DAY,
  };

  const duringGrace = resolve({ subscription });
  assert.equal(duringGrace.commercialAccessState, 'grace');
  assert.equal(duringGrace.effectivePlanId, 'paid_entry');
  assert.equal(duringGrace.billing.nextPlanId, 'highest_paid');
  assert.equal(duringGrace.nextRecalculationAt, graceUntil);

  const afterGrace = resolveBillingAccess({ now: graceUntil, subscription });
  assert.equal(afterGrace.commercialAccessPlanId, null);
  assert.equal(afterGrace.effectivePlanId, 'free');
});

test('confirmed refund invalidation removes current commercial access without revoking independent grants', () => {
  const result = resolve({
    subscription: {
      plan_id: 'highest_paid',
      status: 'active',
      paid_through: NOW + 20 * DAY,
      access_invalidated_at: NOW - 1,
      invalidation_reason: 'CURRENT_PERIOD_PAYMENT_REFUNDED',
    },
    grants: [{
      id: 'welcome-survives-refund',
      source: 'welcome',
      plan_id: 'paid_entry',
      starts_at: NOW - DAY,
      expires_at: NOW + 3 * DAY,
    }],
  });

  assert.equal(result.commercialAccessState, 'invalidated');
  assert.equal(result.commercialAccessPlanId, null);
  assert.equal(result.effectivePlanId, 'paid_entry');
  assert.equal(result.billing.invalidationReason, 'CURRENT_PERIOD_PAYMENT_REFUNDED');
});

test('future administrative invalidation becomes the next commercial recalculation boundary', () => {
  const invalidatedAt = NOW + 2 * DAY;
  const result = resolve({
    subscription: {
      plan_id: 'highest_paid',
      status: 'active',
      paid_through: NOW + 30 * DAY,
      access_invalidated_at: invalidatedAt,
      invalidation_reason: 'ADMIN_TERMINATION_SCHEDULED',
    },
  });

  assert.equal(result.effectivePlanId, 'highest_paid');
  assert.equal(result.nextRecalculationAt, invalidatedAt);
});

test('Highest Paid represents unlimited commercial beat and YouTube quotas with null', () => {
  const result = resolve({
    subscription: {
      plan_id: 'highest_paid',
      status: 'active',
      paid_through: NOW + DAY,
    },
  });

  assert.equal(result.effectivePlanId, 'highest_paid');
  assert.equal(result.quotas.max_beats, null);
  assert.equal(result.quotas.youtube_uploads_per_day, null);
  assert.equal(result.quotas.youtube_uploads_per_month, null);
  assert.equal(result.quotas.max_project_zip_bytes, 1_900_000_000);
});

test('invalid resolver inputs fail closed instead of silently inventing access', () => {
  assert.throws(
    () => resolveBillingAccess({ now: 'not-a-date' }),
    error => error instanceof BillingAccessInputError,
  );
  assert.throws(
    () => resolveBillingAccess({ now: NOW, grants: {} }),
    error => error instanceof BillingAccessInputError,
  );
});
