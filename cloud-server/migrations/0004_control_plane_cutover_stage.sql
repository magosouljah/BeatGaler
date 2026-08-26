BEGIN;

CREATE TABLE control_plane_cutover_stages (
  id text PRIMARY KEY,
  snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  external_bundle_sha256 text NULL CHECK (external_bundle_sha256 IS NULL OR external_bundle_sha256 ~ '^[0-9a-f]{64}$'),
  staged_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (id = 'legacy-json-v1')
);

COMMIT;
