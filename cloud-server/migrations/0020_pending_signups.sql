BEGIN;

CREATE TABLE IF NOT EXISTS pending_signups (
  id text PRIMARY KEY,
  email_normalized text NOT NULL UNIQUE,
  username_base text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  installation_id text,
  continuation_hash text NOT NULL,
  link_token_hash text NOT NULL,
  manual_code_hash text NOT NULL,
  challenge_expires_at timestamptz NOT NULL,
  challenge_failures integer NOT NULL DEFAULT 0 CHECK (challenge_failures >= 0),
  resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count >= 0),
  last_requested_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  status text NOT NULL CHECK (status IN (
    'NEW','DELIVERY_PENDING','CODE_SENT','VERIFIED','ACTIVATING','PROVISIONING','ACTIVE','RETRYABLE','EXPIRED','CANCELLED'
  )),
  verified_at timestamptz,
  activated_user_id text REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_signups_expires_idx ON pending_signups(expires_at);
CREATE INDEX IF NOT EXISTS pending_signups_status_idx ON pending_signups(status, updated_at);

CREATE TABLE IF NOT EXISTS auth_delivery_outbox (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  signup_id text REFERENCES pending_signups(id) ON DELETE CASCADE,
  kind text NOT NULL,
  destination_hash text NOT NULL,
  public_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext text NOT NULL,
  secret_nonce text NOT NULL,
  secret_key_version integer NOT NULL CHECK (secret_key_version > 0),
  state text NOT NULL CHECK (state IN ('PENDING','SENDING','SENT','RETRYABLE','FAILED','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_delivery_outbox_ready_idx
  ON auth_delivery_outbox(state, available_at, created_at)
  WHERE state IN ('PENDING','RETRYABLE');

CREATE TABLE IF NOT EXISTS auth_provisioning_ledger (
  signup_id text NOT NULL REFERENCES pending_signups(id) ON DELETE CASCADE,
  step text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','RUNNING','DONE','RETRYABLE','FAILED')),
  idempotency_key text NOT NULL UNIQUE,
  external_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signup_id, step)
);

COMMENT ON TABLE pending_signups IS
  'Temporary public-signup state. A pending row is not a BeatGaler user and must never grant a normal session, vault or entitlement.';
COMMENT ON TABLE auth_delivery_outbox IS
  'Durable email delivery queue. Verification secrets are envelope-encrypted; plaintext codes/tokens are never stored.';
COMMENT ON TABLE auth_provisioning_ledger IS
  'Idempotent activation/provisioning steps used to recover crashes without duplicating external resources.';

COMMIT;
