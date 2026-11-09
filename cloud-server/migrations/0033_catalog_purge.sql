BEGIN;

-- T15 — Purge durable, retención y limpieza segura (CONTRATO C9; NATIVO r2.1 §6.1/§7: purge solo desde SQL y solo en chats CURRENT o
-- RETIRED; journal externo previo a cada borrado; `restore_hold` y `cleanup_enabled` por biblioteca). Aditiva. Sin bytes de archivos.
-- Nada aquí borra objetos: las filas describen la intención, la enumeración, el journal y la confirmación; el delete físico es del worker
-- y solo tras journal persistido y verificado; la cuota se libera una sola vez al PURGED completo del beat.
CREATE TABLE catalog_purges (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  purge_id text NOT NULL CHECK (purge_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  generation_id text NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  scope text NOT NULL CHECK (scope IN ('ALL_TRASH', 'ITEMS')),
  limit_position integer CHECK (limit_position >= 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'ENUMERATING' CHECK (status IN ('ENUMERATING', 'DELETING', 'PURGED', 'PARTIAL', 'BLOCKED', 'CANCELLED')),
  enumeration_cursor integer NOT NULL DEFAULT -1,
  total_items integer NOT NULL DEFAULT 0 CHECK (total_items >= 0),
  purged_items integer NOT NULL DEFAULT 0 CHECK (purged_items >= 0),
  blocked_items integer NOT NULL DEFAULT 0 CHECK (blocked_items >= 0),
  last_error text CHECK (char_length(last_error) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, purge_id),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE,
  CHECK ((status IN ('PURGED', 'PARTIAL', 'BLOCKED', 'CANCELLED')) = (completed_at IS NOT NULL))
);
CREATE INDEX catalog_purges_status_idx ON catalog_purges(user_id, status);

CREATE TABLE catalog_purge_items (
  user_id text NOT NULL,
  purge_id text NOT NULL,
  beat_id text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ENUMERATED', 'DELETING', 'PURGED', 'BLOCKED')),
  block_reason text CHECK (block_reason IN ('OPAQUE_REFERENCE', 'SHARED_OBJECT', 'RETENTION_WINDOW', 'RESTORE_HOLD', 'CLEANUP_DISABLED', 'PENDING_OPERATION', 'JOURNAL_UNAVAILABLE', 'PROVIDER_UNCERTAIN', 'BEAT_STATE')),
  objects_total integer NOT NULL DEFAULT 0 CHECK (objects_total >= 0),
  objects_deleted integer NOT NULL DEFAULT 0 CHECK (objects_deleted >= 0),
  enumerated_at timestamptz,
  purged_at timestamptz,
  PRIMARY KEY (user_id, purge_id, beat_id),
  FOREIGN KEY (user_id, purge_id) REFERENCES catalog_purges(user_id, purge_id) ON DELETE CASCADE,
  CHECK ((status = 'BLOCKED') = (block_reason IS NOT NULL)),
  CHECK ((status = 'PURGED') = (purged_at IS NOT NULL))
);

-- manifiesto de objetos físicos por purge: identidad física única (object_id); estado del journal y de la eliminación verificada.
CREATE TABLE catalog_purge_objects (
  user_id text NOT NULL,
  purge_id text NOT NULL,
  object_id text NOT NULL,
  beat_id text NOT NULL,
  file_id text,
  part_index integer CHECK (part_index >= 0),
  chat_id text NOT NULL CHECK (chat_id ~ '^-?[0-9]{1,20}$'),
  message_id bigint NOT NULL CHECK (message_id > 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'JOURNALED', 'DELETING', 'DELETED', 'BLOCKED', 'UNCERTAIN')),
  block_reason text,
  journal_ref text CHECK (char_length(journal_ref) BETWEEN 1 AND 256),
  journal_sha256 text CHECK (journal_sha256 ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text CHECK (char_length(last_error) <= 1000),
  deleted_at timestamptz,
  PRIMARY KEY (user_id, purge_id, object_id),
  FOREIGN KEY (user_id, purge_id, beat_id) REFERENCES catalog_purge_items(user_id, purge_id, beat_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, object_id) REFERENCES catalog_media_objects(user_id, object_id),
  CHECK (status NOT IN ('JOURNALED', 'DELETING', 'DELETED') OR journal_ref IS NOT NULL),
  CHECK ((status = 'DELETED') = (deleted_at IS NOT NULL))
);
CREATE INDEX catalog_purge_objects_status_idx ON catalog_purge_objects(user_id, purge_id, status);

-- Una sola purga activa por biblioteca: las intenciones se serializan (nunca dos manifiestos sobre los mismos objetos).
CREATE UNIQUE INDEX catalog_purges_live_idx ON catalog_purges(user_id) WHERE status IN ('ENUMERATING', 'DELETING');

COMMIT;
