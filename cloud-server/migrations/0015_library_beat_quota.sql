BEGIN;

-- INDEX remains the media/library document. These rows are the server-side
-- identity and capacity ledger used by Access before a new beat is created.
CREATE TABLE library_quota_state (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  index_message_id bigint NOT NULL CHECK (index_message_id > 0),
  index_sha256 text NOT NULL CHECK (index_sha256 ~ '^[0-9a-f]{64}$'),
  initialized_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE library_beat_reservations (
  id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  beat_id text NOT NULL CHECK (length(beat_id) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN ('PENDING','COMMITTED','CANCELED','EXPIRED','DENIED')),
  denial_reason text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE UNIQUE INDEX library_beat_reservations_live_identity_idx
  ON library_beat_reservations(user_id, beat_id)
  WHERE state IN ('PENDING','COMMITTED');
CREATE INDEX library_beat_reservations_pending_idx
  ON library_beat_reservations(user_id, expires_at) WHERE state = 'PENDING';

CREATE TABLE library_beats (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  beat_id text NOT NULL CHECK (length(beat_id) BETWEEN 1 AND 256),
  state text NOT NULL CHECK (state IN ('ACTIVE','TRASH')),
  reservation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, beat_id),
  UNIQUE (user_id, reservation_id),
  FOREIGN KEY (user_id, reservation_id) REFERENCES library_beat_reservations(user_id, id)
);
CREATE INDEX library_beats_user_state_idx ON library_beats(user_id, state);

COMMIT;
