CREATE TABLE IF NOT EXISTS auth_email_changes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL UNIQUE,
  old_email TEXT NOT NULL,
  new_email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING','CONFIRMED','EXPIRED','FAILED','CONFLICT')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  delivery_count INTEGER NOT NULL DEFAULT 0 CHECK (delivery_count >= 0),
  last_delivery_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_email_changes_token_idx
  ON auth_email_changes(token_hash);

CREATE INDEX IF NOT EXISTS auth_email_changes_state_expiry_idx
  ON auth_email_changes(state, expires_at);
