BEGIN;

CREATE TABLE IF NOT EXISTS billing_reconciliation_exceptions (
  exception_key text PRIMARY KEY,
  user_id text NOT NULL,
  provider_customer_id text,
  provider_subscription_id text,
  reason text NOT NULL,
  provider_snapshot jsonb NOT NULL,
  local_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','RESOLVED')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS billing_reconciliation_exceptions_state_idx
  ON billing_reconciliation_exceptions(state, updated_at);

COMMIT;
