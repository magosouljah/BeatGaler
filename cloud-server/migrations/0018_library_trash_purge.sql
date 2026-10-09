BEGIN;

-- A purge request survives process death while its beat still occupies quota.
-- Confirmed rows are permanent identity tombstones, independent of INDEX history.
CREATE TABLE library_trash_purges (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  beat_id text NOT NULL CHECK (length(beat_id) BETWEEN 1 AND 256),
  operation_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','CONFIRMED','LEGACY_TOMBSTONE')),
  asset_message_ids bigint[] NOT NULL,
  beat_sha256 text NOT NULL CHECK (beat_sha256 ~ '^[0-9a-f]{64}$'),
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  PRIMARY KEY (user_id, beat_id),
  UNIQUE (user_id, operation_id),
  CHECK ((state = 'CONFIRMED') = (confirmed_at IS NOT NULL))
);

COMMIT;
