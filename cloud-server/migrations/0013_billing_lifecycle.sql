BEGIN;

-- Billing V1 lifecycle support.
-- Keeps billing projection isolated from Auth, transport, bots and library data.

-- Polar 2026-04 exposes recurring financial confirmation through Order resources.
-- An Order ID is therefore a durable provider financial identity even when no
-- separate provider payment ID is present on the webhook/resource.
ALTER TABLE billing_payments
  ALTER COLUMN provider_payment_id DROP NOT NULL;

ALTER TABLE billing_payments
  ADD CONSTRAINT billing_payments_provider_financial_identity_check
    CHECK (
      nullif(btrim(provider_payment_id), '') IS NOT NULL
      OR nullif(btrim(provider_order_id), '') IS NOT NULL
    );

CREATE UNIQUE INDEX billing_payments_provider_order_unique_idx
  ON billing_payments(provider, provider_environment, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

CREATE TABLE billing_provider_actions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (nullif(btrim(provider), '') IS NOT NULL),
  provider_environment text NOT NULL CHECK (provider_environment IN ('sandbox', 'production')),
  action_type text NOT NULL CHECK (action_type IN ('REVOKE_SUBSCRIPTION')),
  provider_subscription_id text NOT NULL CHECK (nullif(btrim(provider_subscription_id), '') IS NOT NULL),
  idempotency_key text NOT NULL CHECK (nullif(btrim(idempotency_key), '') IS NOT NULL),
  state text NOT NULL CHECK (state IN ('PENDING','PROCESSING','SUCCEEDED','FAILED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  processing_lease_owner text,
  processing_lease_until timestamptz,
  next_attempt_at timestamptz,
  last_error_code text,
  succeeded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_environment, idempotency_key),
  UNIQUE (provider, provider_environment, action_type, provider_subscription_id),
  CHECK (
    (state = 'PROCESSING' AND processing_lease_owner IS NOT NULL AND processing_lease_until IS NOT NULL)
    OR
    (state <> 'PROCESSING' AND processing_lease_owner IS NULL AND processing_lease_until IS NULL)
  ),
  CHECK (
    (state = 'SUCCEEDED' AND succeeded_at IS NOT NULL)
    OR
    (state <> 'SUCCEEDED' AND succeeded_at IS NULL)
  ),
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_:-]{1,128}$')
);

CREATE INDEX billing_provider_actions_ready_idx
  ON billing_provider_actions(provider, provider_environment, state, next_attempt_at, created_at);

CREATE INDEX billing_provider_actions_lease_idx
  ON billing_provider_actions(provider, provider_environment, processing_lease_until)
  WHERE state = 'PROCESSING';

COMMIT;
