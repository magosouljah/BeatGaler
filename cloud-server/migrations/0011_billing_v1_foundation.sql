BEGIN;

-- Billing V1 persistence foundation.
-- This migration deliberately does not change transport, bot membership, Direct,
-- library mutation, YouTube execution, Auth runtime wiring, or provider SDK code.

ALTER TABLE billing_subscription_state
  ADD COLUMN provider text,
  ADD COLUMN provider_environment text,
  ADD COLUMN offer_id text,
  ADD COLUMN provider_product_id text,
  ADD COLUMN provider_price_id text,
  ADD COLUMN current_period_start timestamptz,
  ADD COLUMN paid_through timestamptz,
  ADD COLUMN past_due_at timestamptz,
  ADD COLUMN grace_until timestamptz,
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN next_plan_id text,
  ADD COLUMN next_interval text,
  ADD COLUMN next_plan_effective_at timestamptz,
  ADD COLUMN access_invalidated_at timestamptz,
  ADD COLUMN invalidation_reason text,
  ADD COLUMN last_synced_at timestamptz,
  ADD COLUMN local_version bigint NOT NULL DEFAULT 0;

ALTER TABLE billing_subscription_state
  ADD CONSTRAINT billing_subscription_state_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT billing_subscription_state_provider_environment_check
    CHECK (provider_environment IS NULL OR provider_environment IN ('sandbox', 'production')),
  ADD CONSTRAINT billing_subscription_state_period_check
    CHECK (
      current_period_start IS NULL
      OR current_period_end IS NULL
      OR current_period_end > current_period_start
    ),
  ADD CONSTRAINT billing_subscription_state_paid_through_check
    CHECK (
      paid_through IS NULL
      OR current_period_start IS NULL
      OR paid_through >= current_period_start
    ),
  ADD CONSTRAINT billing_subscription_state_grace_check
    CHECK (
      grace_until IS NULL
      OR (past_due_at IS NOT NULL AND grace_until > past_due_at)
    ),
  ADD CONSTRAINT billing_subscription_state_next_plan_check
    CHECK (next_plan_id IS NULL OR next_plan_id IN ('free', 'paid_entry', 'highest_paid')),
  ADD CONSTRAINT billing_subscription_state_next_interval_check
    CHECK (next_interval IS NULL OR next_interval IN ('month', 'year')),
  ADD CONSTRAINT billing_subscription_state_next_change_shape_check
    CHECK (
      (next_plan_id IS NULL AND next_interval IS NULL AND next_plan_effective_at IS NULL)
      OR (next_plan_id IS NOT NULL AND next_plan_effective_at IS NOT NULL)
    ),
  ADD CONSTRAINT billing_subscription_state_invalidation_check
    CHECK (
      (access_invalidated_at IS NULL AND invalidation_reason IS NULL)
      OR (
        access_invalidated_at IS NOT NULL
        AND nullif(btrim(invalidation_reason), '') IS NOT NULL
      )
    ),
  ADD CONSTRAINT billing_subscription_state_local_version_check
    CHECK (local_version >= 0);

CREATE UNIQUE INDEX billing_subscription_state_provider_subscription_unique_idx
  ON billing_subscription_state(provider, provider_environment, provider_subscription_id)
  WHERE provider IS NOT NULL
    AND provider_environment IS NOT NULL
    AND provider_subscription_id IS NOT NULL;

CREATE INDEX billing_subscription_state_access_window_idx
  ON billing_subscription_state(paid_through, grace_until, access_invalidated_at);

ALTER TABLE entitlements
  ADD COLUMN source_key text,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revocation_reason text,
  ADD COLUMN issued_by_actor text;

ALTER TABLE entitlements
  ADD CONSTRAINT entitlements_revocation_window_check
    CHECK (revoked_at IS NULL OR revoked_at >= starts_at),
  ADD CONSTRAINT entitlements_revocation_reason_check
    CHECK (
      (revoked_at IS NULL AND revocation_reason IS NULL)
      OR (
        revoked_at IS NOT NULL
        AND nullif(btrim(revocation_reason), '') IS NOT NULL
      )
    );

CREATE UNIQUE INDEX entitlements_source_key_unique_idx
  ON entitlements(user_id, source, source_key)
  WHERE source_key IS NOT NULL;

-- Welcome is an at-most-once grant for the lifetime of a user. Revoking or
-- expiring the original row must not permit a second welcome grant.
CREATE UNIQUE INDEX entitlements_welcome_once_per_user_idx
  ON entitlements(user_id)
  WHERE source = 'welcome';

CREATE INDEX entitlements_active_grants_idx
  ON entitlements(user_id, expires_at, revoked_at);

CREATE TABLE billing_customers (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (nullif(btrim(provider), '') IS NOT NULL),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'production')),
  provider_customer_id text NOT NULL CHECK (nullif(btrim(provider_customer_id), '') IS NOT NULL),
  external_id text NOT NULL CHECK (nullif(btrim(external_id), '') IS NOT NULL),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, provider_environment),
  UNIQUE (provider, provider_environment, provider_customer_id),
  UNIQUE (provider, provider_environment, external_id)
);
CREATE INDEX billing_customers_user_idx
  ON billing_customers(user_id);

CREATE TABLE billing_checkout_requests (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id text NOT NULL CHECK (nullif(btrim(request_id), '') IS NOT NULL),
  offer_id text NOT NULL CHECK (nullif(btrim(offer_id), '') IS NOT NULL),
  request_hash_sha256 text NOT NULL CHECK (request_hash_sha256 ~ '^[0-9a-f]{64}$'),
  provider text NOT NULL CHECK (nullif(btrim(provider), '') IS NOT NULL),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'production')),
  state text NOT NULL CHECK (state IN ('CREATING', 'OPEN', 'COMPLETED', 'EXPIRED', 'FAILED', 'AMBIGUOUS')),
  provider_checkout_id text,
  checkout_url text,
  expires_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  CHECK (provider_checkout_id IS NULL OR nullif(btrim(provider_checkout_id), '') IS NOT NULL),
  CHECK (checkout_url IS NULL OR nullif(btrim(checkout_url), '') IS NOT NULL)
);

CREATE UNIQUE INDEX billing_checkout_requests_provider_checkout_unique_idx
  ON billing_checkout_requests(provider, provider_environment, provider_checkout_id)
  WHERE provider_checkout_id IS NOT NULL;

-- CREATING/OPEN/AMBIGUOUS all represent unresolved subscription checkout work.
-- An ambiguous timeout must be reconciled instead of silently creating another checkout.
CREATE UNIQUE INDEX billing_checkout_requests_one_unresolved_per_user_idx
  ON billing_checkout_requests(user_id)
  WHERE state IN ('CREATING', 'OPEN', 'AMBIGUOUS');

CREATE INDEX billing_checkout_requests_state_idx
  ON billing_checkout_requests(state, updated_at);
CREATE INDEX billing_checkout_requests_expiry_idx
  ON billing_checkout_requests(expires_at)
  WHERE state = 'OPEN';

CREATE TABLE billing_payments (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK (nullif(btrim(provider), '') IS NOT NULL),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'production')),
  provider_payment_id text NOT NULL CHECK (nullif(btrim(provider_payment_id), '') IS NOT NULL),
  provider_order_id text,
  provider_invoice_id text,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_subscription_id text,
  offer_id text NOT NULL CHECK (nullif(btrim(offer_id), '') IS NOT NULL),
  period_start timestamptz,
  period_end timestamptz,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  status text NOT NULL CHECK (
    status IN ('pending', 'succeeded', 'failed', 'partially_refunded', 'refunded', 'disputed', 'void')
  ),
  refunded_amount_minor bigint NOT NULL DEFAULT 0,
  invalidated_at timestamptz,
  invalidation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start IS NULL OR period_end IS NULL OR period_end > period_start),
  CHECK (refunded_amount_minor >= 0 AND refunded_amount_minor <= amount_minor),
  CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (
      invalidated_at IS NOT NULL
      AND nullif(btrim(invalidation_reason), '') IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX billing_payments_provider_payment_unique_idx
  ON billing_payments(provider, provider_environment, provider_payment_id);
CREATE INDEX billing_payments_user_period_idx
  ON billing_payments(user_id, period_end DESC);
CREATE INDEX billing_payments_subscription_idx
  ON billing_payments(provider, provider_environment, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

COMMIT;
