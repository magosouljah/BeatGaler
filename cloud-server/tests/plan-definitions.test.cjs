'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveBillingAccess } = require('../billing-access-resolver');
const { publicPlanCatalog, publicPlanState } = require('../plans');

const plans = [
  {
    id: 'free',
    label: 'Free',
    capabilities: { upload_project: false, bulk_youtube_upload: 'none', early_access: false },
    quotas: { max_beats: 20, max_project_zip_bytes: 0, youtube_uploads_per_day: 3, youtube_uploads_per_month: 31 },
    legacyQuotas: { max_active_devices: 2, max_simultaneous_sessions: 1 },
    referral: { rewarded_referrals_per_month: 1, reward_plan_id: 'paid_entry', reward_days: 3 },
  },
  {
    id: 'paid_entry',
    label: 'Paid Entry',
    capabilities: { upload_project: true, bulk_youtube_upload: 'limited', early_access: false },
    quotas: { max_beats: 100, max_project_zip_bytes: 1_000_000_000, youtube_uploads_per_day: 10, youtube_uploads_per_month: 60 },
    legacyQuotas: { max_active_devices: 3, max_simultaneous_sessions: 2 },
    referral: { rewarded_referrals_per_month: 2, reward_plan_id: 'highest_paid', reward_days: 3 },
  },
  {
    id: 'highest_paid',
    label: 'Highest Paid',
    capabilities: { upload_project: true, bulk_youtube_upload: 'full', early_access: true },
    quotas: { max_beats: null, max_project_zip_bytes: 1_900_000_000, youtube_uploads_per_day: null, youtube_uploads_per_month: null },
    legacyQuotas: { max_active_devices: null, max_simultaneous_sessions: 2 },
    referral: { rewarded_referrals_per_month: 5, reward_plan_id: 'highest_paid', reward_days: 3 },
  },
];

const now = 1000;
const paidThrough = 2000;

for (const { id, label, capabilities, quotas, legacyQuotas, referral } of plans) {
  test(`producción: acceso completo de ${id}`, () => {
    const paid = id !== 'free';
    const subscription = paid ? { planId: id, status: 'active', paidThrough } : null;
    const accessSources = [{ type: 'baseline', mode: 'free', planId: 'free', validUntil: null }];
    if (paid) accessSources.push({ type: 'commercial', mode: 'paid', planId: id, validUntil: paidThrough });

    assert.deepStrictEqual(resolveBillingAccess({ subscription, now }), {
      commercialPlanId: id,
      commercialAccessPlanId: paid ? id : null,
      commercialAccessState: paid ? 'paid' : 'none',
      effectivePlanId: id,
      label,
      capabilities,
      quotas,
      accessSources,
      nextRecalculationAt: paid ? paidThrough : null,
      billing: {
        providerStatus: paid ? 'active' : 'inactive',
        paidThrough: paid ? paidThrough : null,
        pastDueAt: null,
        graceUntil: null,
        accessInvalidatedAt: null,
        invalidationReason: null,
        currentPeriodEnd: null,
        endedAt: null,
        cancelAtPeriodEnd: false,
        nextPlanId: null,
        nextInterval: null,
        nextPlanEffectiveAt: null,
      },
    });
  });

  test(`JSON/LAB: estado completo de ${id}`, () => {
    const user = { planState: { basePlanId: id, grants: [] } };
    assert.deepStrictEqual(publicPlanState(user, now), {
      base_plan_id: id,
      effective_plan_id: id,
      label,
      effective_until: null,
      access_source: 'base_plan',
      entitlements: capabilities,
      quotas: { ...quotas, ...legacyQuotas },
      referral,
    });
  });
}

test('JSON/LAB: catálogo público completo y en orden', () => {
  assert.deepStrictEqual(publicPlanCatalog(), plans.map(({ id, label, capabilities, quotas, legacyQuotas }) => ({
    id,
    label,
    entitlements: capabilities,
    quotas: { ...quotas, ...legacyQuotas },
  })));
});
