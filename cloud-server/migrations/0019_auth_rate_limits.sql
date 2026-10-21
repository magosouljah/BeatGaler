CREATE TABLE IF NOT EXISTS auth_rate_limit_buckets (
  scope text NOT NULL,
  key_hash text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key_hash)
);

CREATE INDEX IF NOT EXISTS auth_rate_limit_buckets_expires_idx
  ON auth_rate_limit_buckets (expires_at);

COMMENT ON TABLE auth_rate_limit_buckets IS
  'Durable, cross-process authentication abuse-control buckets. Keys are SHA-256 digests; raw IP/email/account identifiers are not stored.';
