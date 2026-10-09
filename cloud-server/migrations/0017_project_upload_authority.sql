BEGIN;

ALTER TABLE vaults ADD COLUMN project_media_restricted_bot_id text;

CREATE TABLE library_project_uploads (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  beat_id text NOT NULL,
  sha256 text NOT NULL,
  message_id bigint NOT NULL,
  telegram_document_id text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, beat_id, sha256),
  UNIQUE (user_id, message_id)
);

CREATE TABLE library_legacy_project_copies (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  beat_id text NOT NULL,
  part_index integer NOT NULL CHECK (part_index >= 0),
  source_message_id bigint NOT NULL,
  message_id bigint NOT NULL,
  telegram_document_id text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, beat_id, part_index, message_id)
);

COMMIT;
