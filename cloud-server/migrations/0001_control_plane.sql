BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  checksum_sha256 text NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id text PRIMARY KEY,
  email text UNIQUE,
  password_hash text,
  password_hash_algorithm text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((password_hash IS NULL) = (password_hash_algorithm IS NULL))
);

CREATE TABLE auth_sessions (
  session_key_hash text PRIMARY KEY CHECK (length(session_key_hash) = 64),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions(expires_at);

CREATE TABLE provider_identities (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_subject text NOT NULL,
  access_token_ciphertext bytea,
  refresh_token_ciphertext bytea,
  secret_nonce bytea,
  secret_key_version integer,
  token_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject),
  CHECK (secret_key_version IS NULL OR secret_key_version > 0)
);
CREATE INDEX provider_identities_user_id_idx ON provider_identities(user_id);

CREATE TABLE mfa_factors (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  factor_type text NOT NULL CHECK (factor_type IN ('totp')),
  secret_ciphertext bytea NOT NULL,
  secret_nonce bytea NOT NULL,
  secret_key_version integer NOT NULL CHECK (secret_key_version > 0),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, factor_type)
);

CREATE TABLE entitlements (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id text NOT NULL CHECK (plan_id IN ('free', 'paid_entry', 'highest_paid')),
  source text NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > starts_at)
);
CREATE INDEX entitlements_user_id_idx ON entitlements(user_id);

CREATE TABLE vaults (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_chat_id text NOT NULL UNIQUE,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vaults_user_id_unique_idx ON vaults(user_id);

CREATE TABLE transport_bots (
  id text PRIMARY KEY,
  secret_ref text,
  quarantined boolean NOT NULL DEFAULT false,
  rotation_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE direct_leases (
  id text PRIMARY KEY,
  transport_bot_id text NOT NULL REFERENCES transport_bots(id),
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  installation_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASING', 'RELEASED', 'EXPIRED')),
  started_at timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL,
  released_at timestamptz,
  CHECK (released_at IS NULL OR released_at >= started_at)
);
CREATE INDEX direct_leases_bot_status_idx ON direct_leases(transport_bot_id, status);
CREATE INDEX direct_leases_vault_status_idx ON direct_leases(vault_id, status);
CREATE UNIQUE INDEX direct_leases_one_active_installation_idx
  ON direct_leases(installation_id)
  WHERE status = 'ACTIVE';

CREATE TABLE direct_operations (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  lease_id text REFERENCES direct_leases(id),
  operation_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('PREPARED', 'EXTERNAL_EFFECT', 'INDEX_COMMITTED', 'COMMITTED', 'FAILED', 'RECONCILE')),
  produced_object_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(produced_object_ids) = 'array')
);
CREATE INDEX direct_operations_vault_state_idx ON direct_operations(vault_id, state);

CREATE TABLE index_observations (
  vault_id text PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  pinned_message_id text,
  revision text,
  manifest_sha256 text CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE garbage_journal (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  vault_id text NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  operation_id text REFERENCES direct_operations(id) ON DELETE SET NULL,
  object_kind text NOT NULL CHECK (object_kind IN ('media', 'old_index', 'topic')),
  object_id text NOT NULL,
  beat_id text,
  reason text NOT NULL CHECK (reason IN ('orphan_upload', 'replace_asset', 'permanent_delete', 'old_index', 'topic_cleanup')),
  state text NOT NULL CHECK (state IN ('pending', 'retrying', 'blocked', 'done')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_error_code text,
  last_error_redacted text,
  index_commit_ref text NOT NULL,
  worker_lease_owner text,
  worker_lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((state = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX garbage_journal_ready_idx ON garbage_journal(state, next_attempt_at);

CREATE TABLE jobs (
  id text PRIMARY KEY,
  idempotency_key text UNIQUE,
  job_type text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX jobs_ready_idx ON jobs(state, next_attempt_at);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX audit_events_created_at_idx ON audit_events(created_at);
CREATE INDEX audit_events_actor_idx ON audit_events(actor_user_id, created_at);

COMMIT;
