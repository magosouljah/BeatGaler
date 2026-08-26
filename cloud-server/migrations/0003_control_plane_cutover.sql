BEGIN;

ALTER TABLE provider_identities
  ADD COLUMN IF NOT EXISTS profile jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE provider_identities
  DROP CONSTRAINT IF EXISTS provider_identities_profile_object_check;
ALTER TABLE provider_identities
  ADD CONSTRAINT provider_identities_profile_object_check
  CHECK (jsonb_typeof(profile) = 'object');

CREATE TABLE control_plane_cutovers (
  id text PRIMARY KEY,
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('READY', 'ROLLED_BACK')),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 'legacy-json-v1')
);

CREATE TABLE runtime_compat_state (
  state_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state_key IN ('legacy-cloud-data-v1')),
  CHECK (jsonb_typeof(payload) = 'object')
);

COMMIT;
