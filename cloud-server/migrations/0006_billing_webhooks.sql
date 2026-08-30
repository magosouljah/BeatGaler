BEGIN;

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  subject_id text NOT NULL,
  provider_created_at bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('PROCESSING','PROCESSED','FAILED','IGNORED_OUT_OF_ORDER')),
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_webhook_events_state_idx ON billing_webhook_events(state, updated_at);
CREATE TABLE IF NOT EXISTS billing_webhook_subjects (
  subject_id text PRIMARY KEY,
  last_provider_created_at bigint NOT NULL DEFAULT -1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
