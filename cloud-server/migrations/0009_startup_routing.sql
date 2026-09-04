BEGIN;

CREATE TABLE IF NOT EXISTS beatgaler_startup_routing_revisions (
  vault_id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beatgaler_startup_routes (
  vault_id text NOT NULL,
  beat_id text NOT NULL CHECK (length(beat_id) BETWEEN 1 AND 256),
  master_message_id bigint NOT NULL CHECK (master_message_id > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, beat_id)
);

CREATE INDEX IF NOT EXISTS beatgaler_startup_routes_vault_updated_idx
  ON beatgaler_startup_routes (vault_id, updated_at DESC);

COMMIT;
