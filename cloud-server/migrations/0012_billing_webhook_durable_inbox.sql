BEGIN;

-- Billing V1 durable webhook inbox.
-- 0006 introduced the original synchronous webhook table. This migration keeps
-- that history intact and upgrades the existing table for receive-first,
-- process-later semantics with recoverable leases.

ALTER TABLE billing_webhook_events
  ADD COLUMN provider text NOT NULL DEFAULT 'legacy',
  ADD COLUMN provider_environment text NOT NULL DEFAULT 'legacy',
  ADD COLUMN raw_body_sha256 text,
  ADD COLUMN validated_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN resolved_user_id text REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN provider_customer_id text,
  ADD COLUMN provider_subscription_id text,
  ADD COLUMN provider_checkout_id text,
  ADD COLUMN received_at timestamptz,
  ADD COLUMN processed_at timestamptz,
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN processing_lease_owner text,
  ADD COLUMN processing_lease_until timestamptz,
  ADD COLUMN last_error_code text,
  ADD COLUMN last_error_redacted text;

UPDATE billing_webhook_events
SET received_at = created_at
WHERE received_at IS NULL;

-- A pre-0012 PROCESSING row has no recoverable lease. Treat it as failed work
-- that requires an explicit retry instead of pretending it is still owned.
UPDATE billing_webhook_events
SET state = 'FAILED',
    last_error_code = COALESCE(last_error_code, 'WEBHOOK_LEGACY_PROCESSING_RECOVERED'),
    last_error_redacted = COALESCE(last_error_redacted, 'legacy processing state requires retry'),
    updated_at = now()
WHERE state = 'PROCESSING';

UPDATE billing_webhook_events
SET state = 'IGNORED'
WHERE state = 'IGNORED_OUT_OF_ORDER';

UPDATE billing_webhook_events
SET processed_at = updated_at
WHERE state IN ('PROCESSED', 'IGNORED')
  AND processed_at IS NULL;

ALTER TABLE billing_webhook_events
  DROP CONSTRAINT IF EXISTS billing_webhook_events_state_check;

ALTER TABLE billing_webhook_events
  ALTER COLUMN received_at SET DEFAULT now(),
  ALTER COLUMN received_at SET NOT NULL,
  ADD CONSTRAINT billing_webhook_events_provider_check
    CHECK (nullif(btrim(provider), '') IS NOT NULL),
  ADD CONSTRAINT billing_webhook_events_provider_environment_check
    CHECK (nullif(btrim(provider_environment), '') IS NOT NULL),
  ADD CONSTRAINT billing_webhook_events_raw_body_sha256_check
    CHECK (raw_body_sha256 IS NULL OR raw_body_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT billing_webhook_events_payload_check
    CHECK (jsonb_typeof(validated_payload) = 'object'),
  ADD CONSTRAINT billing_webhook_events_state_check
    CHECK (state IN ('RECEIVED','PROCESSING','PROCESSED','FAILED','IGNORED')),
  ADD CONSTRAINT billing_webhook_events_attempt_count_check
    CHECK (attempt_count >= 0),
  ADD CONSTRAINT billing_webhook_events_processing_lease_check
    CHECK (
      (state = 'PROCESSING' AND processing_lease_owner IS NOT NULL AND processing_lease_until IS NOT NULL)
      OR
      (state <> 'PROCESSING' AND processing_lease_owner IS NULL AND processing_lease_until IS NULL)
    ),
  ADD CONSTRAINT billing_webhook_events_processed_at_check
    CHECK (
      (state IN ('PROCESSED','IGNORED') AND processed_at IS NOT NULL)
      OR
      (state NOT IN ('PROCESSED','IGNORED') AND processed_at IS NULL)
    ),
  ADD CONSTRAINT billing_webhook_events_provider_customer_id_check
    CHECK (provider_customer_id IS NULL OR nullif(btrim(provider_customer_id), '') IS NOT NULL),
  ADD CONSTRAINT billing_webhook_events_provider_subscription_id_check
    CHECK (provider_subscription_id IS NULL OR nullif(btrim(provider_subscription_id), '') IS NOT NULL),
  ADD CONSTRAINT billing_webhook_events_provider_checkout_id_check
    CHECK (provider_checkout_id IS NULL OR nullif(btrim(provider_checkout_id), '') IS NOT NULL),
  ADD CONSTRAINT billing_webhook_events_error_code_check
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_:-]{1,128}$');

CREATE INDEX billing_webhook_events_ready_idx
  ON billing_webhook_events(state, next_attempt_at, received_at);

CREATE INDEX billing_webhook_events_lease_idx
  ON billing_webhook_events(processing_lease_until)
  WHERE state = 'PROCESSING';

CREATE INDEX billing_webhook_events_resolved_user_idx
  ON billing_webhook_events(resolved_user_id, received_at)
  WHERE resolved_user_id IS NOT NULL;

CREATE INDEX billing_webhook_events_subscription_idx
  ON billing_webhook_events(provider, provider_environment, provider_subscription_id)
  WHERE provider_subscription_id IS NOT NULL;

CREATE INDEX billing_webhook_events_provider_event_idx
  ON billing_webhook_events(provider, provider_environment, event_id);

COMMIT;
