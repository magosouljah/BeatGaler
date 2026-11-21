BEGIN;

-- T09 — Intenciones de transferencia, reservas de cuota, partes con random_id y jobs con lease (CONTRATO C3, C7, C8; NATIVO r2.1 §10 T09
-- simplificada: sin ledger legacy ni bootstrap desde INDEX; la cuota es active+trash+purging+pending de catalog_libraries).
-- Aditiva. Solo TEXT para JSON (D-08). Ninguna FK hacia adelante. Estas tablas no guardan bytes de archivos (C7.9).

CREATE TABLE catalog_transfer_operations (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  operation_id text NOT NULL CHECK (operation_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  generation_id text NOT NULL,
  authority_era uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  kind text NOT NULL CHECK (kind IN ('IMPORT', 'REPLACE', 'PURGE')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  intent_json text NOT NULL CHECK (octet_length(intent_json) <= 65536),
  result_json text,
  status text NOT NULL DEFAULT 'PREPARED' CHECK (status IN ('PREPARED', 'TRANSFERRING', 'VERIFYING', 'READY', 'COMMITTED', 'RECONCILE', 'CONFLICT', 'CANCELED', 'FAILED', 'BLOCKED')),
  beat_id text NOT NULL CHECK (beat_id ~ '^[A-Za-z0-9._:@+-]{1,192}$'),
  expected_version bigint CHECK (expected_version > 0),
  chat_id text NOT NULL CHECK (chat_id ~ '^-?[0-9]{1,20}$'),
  sender_id text NOT NULL CHECK (char_length(sender_id) BETWEEN 1 AND 128),
  reservation_id text,
  declared_bytes bigint NOT NULL DEFAULT 0 CHECK (declared_bytes >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, operation_id),
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE,
  CHECK ((status IN ('COMMITTED', 'CANCELED', 'FAILED')) = (completed_at IS NOT NULL)),
  CHECK (kind <> 'REPLACE' OR expected_version IS NOT NULL)
);
CREATE INDEX catalog_transfer_operations_status_idx ON catalog_transfer_operations(user_id, status, created_at);
CREATE INDEX catalog_transfer_operations_beat_idx ON catalog_transfer_operations(user_id, generation_id, beat_id);

-- C7: una transición solo con evidencia; terminales inmutables; RECONCILE/BLOCKED nunca saltan a COMMITTED sin pasar por READY.
CREATE FUNCTION catalog_transfer_operation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.operation_id <> OLD.operation_id OR NEW.kind <> OLD.kind OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.request_hash <> OLD.request_hash OR NEW.intent_json <> OLD.intent_json OR NEW.beat_id <> OLD.beat_id OR NEW.chat_id <> OLD.chat_id OR NEW.sender_id <> OLD.sender_id THEN
    RAISE EXCEPTION 'catalog transfer operation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('COMMITTED', 'CANCELED', 'FAILED') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'catalog transfer operation % is terminal', OLD.status USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'PREPARED' AND NEW.status IN ('TRANSFERRING', 'VERIFYING', 'READY', 'CANCELED', 'FAILED', 'BLOCKED', 'RECONCILE'))
    OR (OLD.status = 'TRANSFERRING' AND NEW.status IN ('VERIFYING', 'READY', 'RECONCILE', 'CANCELED', 'FAILED', 'BLOCKED'))
    OR (OLD.status = 'VERIFYING' AND NEW.status IN ('READY', 'TRANSFERRING', 'RECONCILE', 'CONFLICT', 'CANCELED', 'FAILED', 'BLOCKED'))
    OR (OLD.status = 'READY' AND NEW.status IN ('COMMITTED', 'CONFLICT', 'RECONCILE', 'CANCELED', 'FAILED', 'BLOCKED'))
    OR (OLD.status = 'RECONCILE' AND NEW.status IN ('VERIFYING', 'READY', 'BLOCKED', 'FAILED', 'CANCELED'))
    OR (OLD.status = 'CONFLICT' AND NEW.status IN ('CANCELED', 'FAILED', 'BLOCKED'))
    OR (OLD.status = 'BLOCKED' AND NEW.status IN ('VERIFYING', 'RECONCILE', 'CANCELED', 'FAILED'))) THEN
    RAISE EXCEPTION 'catalog transfer operation transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_transfer_operations_transition BEFORE UPDATE ON catalog_transfer_operations
  FOR EACH ROW EXECUTE FUNCTION catalog_transfer_operation_transition();

-- C7.3: identidad de envío persistida ANTES del efecto: sender, chat, operationId, partKey, tamaño, hash declarado y random_id
-- (entero firmado de 64 bits como texto). El hash declarado nunca es el verificado (campos separados).
CREATE TABLE catalog_operation_parts (
  user_id text NOT NULL,
  operation_id text NOT NULL,
  part_key text NOT NULL CHECK (part_key ~ '^[A-Za-z0-9._:-]{1,64}$'),
  slot_key text NOT NULL CHECK (slot_key ~ '^(MASTER|ARTWORK|PROJECT|FILES:[0-9]{1,6})$'),
  role text NOT NULL CHECK (role IN ('MASTER', 'WAV', 'ARTWORK', 'PROJECT', 'SAMPLES', 'STEMS', 'LOOP')),
  part_index integer NOT NULL CHECK (part_index >= 0),
  filename text,
  mime text,
  declared_size bigint NOT NULL CHECK (declared_size > 0),
  declared_sha256 text CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  random_id text NOT NULL CHECK (random_id ~ '^-?[0-9]{1,19}$'),
  sender_id text NOT NULL,
  chat_id text NOT NULL,
  dispatch_state text NOT NULL DEFAULT 'PENDING' CHECK (dispatch_state IN ('PENDING', 'DISPATCHED', 'RECEIPT', 'VERIFIED', 'FAILED')),
  dispatched_at timestamptz,
  receipt_json text CHECK (octet_length(receipt_json) <= 16384),
  receipt_hash text CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  provider_message_id bigint CHECK (provider_message_id > 0),
  provider_document_id text CHECK (provider_document_id ~ '^-?[0-9]{1,20}$'),
  verified_size bigint CHECK (verified_size > 0),
  verified_sha256 text CHECK (verified_sha256 ~ '^[0-9a-f]{64}$'),
  verified_json text CHECK (octet_length(verified_json) <= 16384),
  verified_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (user_id, operation_id, part_key),
  UNIQUE (user_id, operation_id, slot_key, part_index),
  UNIQUE (sender_id, random_id),
  FOREIGN KEY (user_id, operation_id) REFERENCES catalog_transfer_operations(user_id, operation_id) ON DELETE CASCADE,
  CHECK ((dispatch_state IN ('RECEIPT', 'VERIFIED')) = (receipt_json IS NOT NULL)),
  CHECK ((dispatch_state = 'VERIFIED') = (verified_at IS NOT NULL AND verified_size IS NOT NULL))
);

-- C7.1: reserva de una plaza de cuota; 15 min renovables hasta 24 h desde la creación; el vencimiento bloquea el commit, nunca borra bytes.
CREATE TABLE catalog_reservations (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  reservation_id text NOT NULL CHECK (reservation_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  operation_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('BEAT_SLOT')),
  state text NOT NULL DEFAULT 'HELD' CHECK (state IN ('HELD', 'CONSUMED', 'RELEASED', 'EXPIRED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  max_until timestamptz NOT NULL,
  renewals integer NOT NULL DEFAULT 0 CHECK (renewals >= 0),
  resolved_at timestamptz,
  PRIMARY KEY (user_id, reservation_id),
  UNIQUE (user_id, operation_id),
  FOREIGN KEY (user_id, operation_id) REFERENCES catalog_transfer_operations(user_id, operation_id) ON DELETE CASCADE,
  CHECK ((state = 'HELD') = (resolved_at IS NULL))
);
CREATE INDEX catalog_reservations_state_idx ON catalog_reservations(user_id, state, expires_at);

-- C8: jobs durables con claim FOR UPDATE SKIP LOCKED, lease con token creciente (lease_generation) y fencing en cada checkpoint.
CREATE TABLE catalog_jobs (
  job_id text PRIMARY KEY CHECK (job_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('TRANSFER_VERIFY', 'TRANSFER_COMMIT', 'TRANSFER_RECONCILE', 'QUERY_SET_BUILD', 'OPERATION_STEP', 'PURGE')),
  operation_id text,
  payload_json text NOT NULL DEFAULT '{}' CHECK (octet_length(payload_json) <= 16384),
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED', 'LEASED', 'DONE', 'FAILED', 'BLOCKED')),
  lease_owner text,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK ((state = 'LEASED') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state IN ('DONE', 'FAILED')) = (completed_at IS NOT NULL))
);
CREATE INDEX catalog_jobs_claim_idx ON catalog_jobs(state, next_attempt_at, created_at);
CREATE INDEX catalog_jobs_user_idx ON catalog_jobs(user_id, state);

CREATE FUNCTION catalog_job_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_id <> OLD.job_id OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'catalog job identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('DONE', 'FAILED') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'catalog job % is terminal', OLD.state USING ERRCODE = '23514';
  END IF;
  IF NEW.lease_generation < OLD.lease_generation THEN
    RAISE EXCEPTION 'catalog job lease generation never decreases' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_jobs_transition BEFORE UPDATE ON catalog_jobs
  FOR EACH ROW EXECUTE FUNCTION catalog_job_transition();

COMMIT;
