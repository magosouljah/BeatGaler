BEGIN;

-- T07 — Mutaciones de metadata, papelera, selección y operaciones bulk (CONTRATO C5/C6, C12-r4 §3–§4, §6; contract-map ddl_phases.T07).
-- Aditiva. Solo TEXT para JSON (D-08). Ninguna FK hacia adelante: operaciones referencian conjuntos (0026) y generaciones.
--  - catalog_operations: operación durable (metadata individual o bulk) con idempotencia por usuario+clave y resultado persistido.
--  - catalog_events: feed durable por biblioteca (event_seq monótono bajo el lock de catalog_libraries), cursor `after`.
--  - catalog_operation_batches / _items: journal de lotes <=50 con checkpoint y avance de revisión en la misma transacción.
--  - catalog_selections / _ops / _op_ids: selección server-side sobre conjunto READY con CAS (selection_version) y log append-only.

CREATE TABLE catalog_operations (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  generation_id text NOT NULL,
  authority_era uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  kind text NOT NULL CHECK (kind IN ('PATCH', 'TRASH', 'RESTORE', 'BULK_PATCH', 'BULK_TRASH', 'BULK_RESTORE', 'TAG_RENAME')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  payload_json text NOT NULL CHECK (octet_length(payload_json) <= 262144),
  result_json text,
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'PARTIAL', 'CONFLICT', 'CANCELLING', 'CANCELLED', 'BLOCKED')),
  set_id text,
  selection_id text,
  selection_version bigint,
  expected_revision bigint CHECK (expected_revision > 0),
  committed_revision bigint CHECK (committed_revision > 0),
  total_frozen bigint NOT NULL DEFAULT 0 CHECK (total_frozen >= 0),
  confirmed bigint NOT NULL DEFAULT 0 CHECK (confirmed >= 0),
  not_executed bigint NOT NULL DEFAULT 0 CHECK (not_executed >= 0),
  cancelled bigint NOT NULL DEFAULT 0 CHECK (cancelled >= 0),
  conflict_batch_seq integer,
  next_slot bigint NOT NULL DEFAULT 0 CHECK (next_slot >= 0),
  frontier_beat_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, operation_id),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, set_id) REFERENCES catalog_query_sets(user_id, set_id) ON DELETE RESTRICT,
  CHECK (kind NOT IN ('BULK_PATCH', 'BULK_TRASH', 'BULK_RESTORE') OR set_id IS NOT NULL),
  CHECK ((status IN ('COMPLETED', 'PARTIAL', 'CANCELLED')) = (completed_at IS NOT NULL))
);
CREATE INDEX catalog_operations_status_idx ON catalog_operations(user_id, status, created_at);

CREATE FUNCTION catalog_operation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.operation_id <> OLD.operation_id OR NEW.kind <> OLD.kind OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.payload_json <> OLD.payload_json THEN
    RAISE EXCEPTION 'catalog operation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'QUEUED' AND NEW.status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'CONFLICT', 'CANCELLED', 'BLOCKED'))
    OR (OLD.status = 'RUNNING' AND NEW.status IN ('COMPLETED', 'PARTIAL', 'CONFLICT', 'CANCELLING', 'CANCELLED', 'BLOCKED'))
    OR (OLD.status = 'CONFLICT' AND NEW.status IN ('RUNNING', 'CANCELLED'))
    OR (OLD.status = 'CANCELLING' AND NEW.status = 'CANCELLED')
    OR (OLD.status = 'BLOCKED' AND NEW.status = 'CANCELLED')) THEN
    RAISE EXCEPTION 'catalog operation transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF NEW.confirmed < OLD.confirmed OR NEW.next_slot < OLD.next_slot THEN
    RAISE EXCEPTION 'catalog operation progress never decreases' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_operations_transition BEFORE UPDATE ON catalog_operations
  FOR EACH ROW EXECUTE FUNCTION catalog_operation_transition();

CREATE TABLE catalog_events (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  event_seq bigint NOT NULL CHECK (event_seq > 0),
  generation_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  kind text NOT NULL CHECK (kind IN ('BEAT_PATCHED', 'BEAT_TRASHED', 'BEAT_RESTORED', 'TAGS_RENAMED', 'OPERATION_STATUS')),
  beat_id text,
  version bigint CHECK (version > 0),
  operation_id text,
  payload_json text NOT NULL DEFAULT '{}' CHECK (octet_length(payload_json) <= 65536),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_seq),
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE
);
CREATE INDEX catalog_events_revision_idx ON catalog_events(user_id, revision);

CREATE TABLE catalog_operation_batches (
  user_id text NOT NULL,
  operation_id text NOT NULL,
  batch_seq integer NOT NULL CHECK (batch_seq >= 1),
  from_slot bigint NOT NULL CHECK (from_slot >= 0),
  to_slot bigint NOT NULL CHECK (to_slot >= from_slot),
  item_count integer NOT NULL CHECK (item_count BETWEEN 0 AND 50),
  status text NOT NULL CHECK (status IN ('COMMITTED', 'CONFLICT', 'SKIPPED_CANCELLED')),
  committed_revision bigint CHECK (committed_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, operation_id, batch_seq),
  FOREIGN KEY (user_id, operation_id) REFERENCES catalog_operations(user_id, operation_id) ON DELETE CASCADE
);

CREATE TABLE catalog_operation_batch_items (
  user_id text NOT NULL,
  operation_id text NOT NULL,
  batch_seq integer NOT NULL,
  beat_id text NOT NULL,
  result text NOT NULL CHECK (result IN ('APPLIED', 'NOOP', 'CONFLICT', 'NOT_EXECUTED', 'SKIPPED')),
  from_version bigint CHECK (from_version > 0),
  to_version bigint CHECK (to_version > 0),
  detail text,
  PRIMARY KEY (user_id, operation_id, batch_seq, beat_id),
  FOREIGN KEY (user_id, operation_id, batch_seq) REFERENCES catalog_operation_batches(user_id, operation_id, batch_seq) ON DELETE CASCADE
);

CREATE TABLE catalog_selections (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  selection_id text NOT NULL CHECK (selection_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  set_id text NOT NULL,
  generation_id text NOT NULL,
  sort text NOT NULL CHECK (sort IN ('manual', 'rating', 'name', 'bpm')),
  default_selected boolean NOT NULL DEFAULT false,
  selection_version bigint NOT NULL DEFAULT 0 CHECK (selection_version >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INVALIDATED', 'CONFLICT', 'FROZEN', 'RELEASED')),
  owner_consumer_id text NOT NULL CHECK (char_length(owner_consumer_id) BETWEEN 1 AND 128),
  selected_count bigint NOT NULL DEFAULT 0 CHECK (selected_count >= 0),
  base_revision bigint NOT NULL CHECK (base_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, selection_id),
  FOREIGN KEY (user_id, set_id) REFERENCES catalog_query_sets(user_id, set_id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE
);

CREATE TABLE catalog_selection_ops (
  user_id text NOT NULL,
  selection_id text NOT NULL,
  op_seq bigint NOT NULL CHECK (op_seq > 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('INCLUDE_IDS', 'EXCLUDE_IDS', 'INCLUDE_RANGE', 'EXCLUDE_RANGE', 'CLEAR')),
  from_beat_id text,
  to_beat_id text,
  revision bigint NOT NULL CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, selection_id, op_seq),
  UNIQUE (user_id, selection_id, idempotency_key),
  FOREIGN KEY (user_id, selection_id) REFERENCES catalog_selections(user_id, selection_id) ON DELETE CASCADE,
  CHECK ((kind IN ('INCLUDE_RANGE', 'EXCLUDE_RANGE')) = (from_beat_id IS NOT NULL AND to_beat_id IS NOT NULL))
);

CREATE TABLE catalog_selection_op_ids (
  user_id text NOT NULL,
  selection_id text NOT NULL,
  op_seq bigint NOT NULL,
  beat_id text NOT NULL,
  PRIMARY KEY (user_id, selection_id, op_seq, beat_id),
  FOREIGN KEY (user_id, selection_id, op_seq) REFERENCES catalog_selection_ops(user_id, selection_id, op_seq) ON DELETE CASCADE
);
CREATE INDEX catalog_selection_op_ids_beat_idx ON catalog_selection_op_ids(user_id, selection_id, beat_id, op_seq);

COMMIT;
