'use strict';

function definePlan({ capabilities, quotas, jsonQuotas, ...plan }) {
  return Object.freeze({
    ...plan,
    capabilities: Object.freeze(capabilities),
    quotas: Object.freeze(quotas),
    jsonQuotas: Object.freeze(jsonQuotas),
  });
}

const PLAN_DEFINITIONS = Object.freeze({
  free: definePlan({
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
      // Free cannot write PROJECT content. Callers must still enforce upload_project.
      max_project_zip_bytes: 0,
      youtube_uploads_per_day: 3,
      youtube_uploads_per_month: 31,
    },
    // Legacy JSON response fields. The runtime does not enforce these limits.
    jsonQuotas: { max_active_devices: 2, max_simultaneous_sessions: 1 },
  }),
  paid_entry: definePlan({
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
    jsonQuotas: { max_active_devices: 3, max_simultaneous_sessions: 2 },
  }),
  highest_paid: definePlan({
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
    jsonQuotas: { max_active_devices: null, max_simultaneous_sessions: 2 },
  }),
});

const BILLING_V1_ACCESS_CATALOG = Object.freeze(Object.fromEntries(
  Object.entries(PLAN_DEFINITIONS).map(([id, { jsonQuotas, ...plan }]) => [id, Object.freeze(plan)]),
));

module.exports = { PLAN_DEFINITIONS, BILLING_V1_ACCESS_CATALOG };
