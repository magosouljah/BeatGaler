BEGIN;

-- S3 is a temporary, resumable ingress. Only the measured MASTER receipt in
-- library_project_uploads can authorize a PROJECT reference in the INDEX.
CREATE TABLE library_project_multipart_uploads (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  beat_id text NOT NULL,
  client_upload_id text NOT NULL,
  chat_id text NOT NULL,
  thread_id bigint,
  filename text NOT NULL,
  fingerprint_sha256 text NOT NULL CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1900000000),
  object_key text NOT NULL UNIQUE,
  s3_upload_id text,
  state text NOT NULL CHECK (state IN ('STARTING','UPLOADING','READY','PROCESSING','COMPLETED','FAILED','ABORTED')),
  worker_id text,
  processing_lease_until timestamptz,
  telegram_message_id bigint,
  result_sha256 text,
  failure_code text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  staged_removed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, beat_id, client_upload_id),
  CHECK ((worker_id IS NULL AND processing_lease_until IS NULL) OR
    (state = 'PROCESSING' AND worker_id IS NOT NULL AND processing_lease_until IS NOT NULL)),
  CHECK (state <> 'COMPLETED' OR (telegram_message_id > 0 AND result_sha256 ~ '^[0-9a-f]{64}$'))
);

-- One expensive in-flight PROJECT per account bounds staging cost and worker
-- backlog even if a client cycles otherwise valid beat identities.
CREATE UNIQUE INDEX library_project_multipart_one_active_user_idx
  ON library_project_multipart_uploads(user_id)
  WHERE state IN ('STARTING','UPLOADING','READY','PROCESSING');
CREATE INDEX library_project_multipart_worker_idx
  ON library_project_multipart_uploads(state, processing_lease_until, created_at);
CREATE INDEX library_project_multipart_expiry_idx
  ON library_project_multipart_uploads(expires_at)
  WHERE state IN ('STARTING','UPLOADING','READY','FAILED','COMPLETED');

COMMIT;
