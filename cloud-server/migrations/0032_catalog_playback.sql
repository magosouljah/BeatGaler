BEGIN;

-- T14 — Rondas Shuffle persistidas (C12-r4 §5: Fisher–Yates perezoso sobre slots densos del conjunto READY; mapping disperso
-- posición→slot con ausencia = identidad; inverso por UNIQUE(slot); consumidos por beatId; resultado idempotente por comando con
-- sequence CAS) y concesiones de acceso a medios por gateway (NATIVO r2.1 §8.6: el cliente recibe un token opaco de vida corta por
-- parte; aquí solo su hash; las descargas van por HTTP con Range y nunca exponen chat, message_id ni credenciales).
-- Aditiva. Sin bytes de archivos. Ninguna FK hacia adelante. El cliente nunca recibe la permutación ni los IDs del conjunto.
CREATE TABLE catalog_playback_rounds (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  round_id text NOT NULL CHECK (round_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  set_id text NOT NULL,
  generation_id text NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('BUILDING', 'ACTIVE', 'COMPLETE', 'STALE', 'RELEASED')),
  member_count bigint NOT NULL CHECK (member_count >= 0),
  remaining bigint NOT NULL CHECK (remaining >= 0),
  sequence bigint NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  consumer_id text NOT NULL CHECK (char_length(consumer_id) BETWEEN 1 AND 128),
  rebuild_from text,
  rebuild_cursor bigint NOT NULL DEFAULT 0 CHECK (rebuild_cursor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, round_id),
  FOREIGN KEY (user_id, set_id, generation_id) REFERENCES catalog_query_sets(user_id, set_id, generation_id) ON DELETE CASCADE,
  CHECK (remaining <= member_count)
);
CREATE INDEX catalog_playback_rounds_set_idx ON catalog_playback_rounds(user_id, set_id, status);

-- mapping disperso: la posición p contiene el slot p salvo que exista fila; un slot movido aparece exactamente una vez (inverso).
CREATE TABLE catalog_round_mapping (
  user_id text NOT NULL,
  round_id text NOT NULL,
  position bigint NOT NULL CHECK (position >= 0),
  slot bigint NOT NULL CHECK (slot >= 0),
  PRIMARY KEY (user_id, round_id, position),
  UNIQUE (user_id, round_id, slot),
  FOREIGN KEY (user_id, round_id) REFERENCES catalog_playback_rounds(user_id, round_id) ON DELETE CASCADE
);

CREATE TABLE catalog_round_consumed (
  user_id text NOT NULL,
  round_id text NOT NULL,
  beat_id text NOT NULL,
  slot bigint NOT NULL CHECK (slot >= 0),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  reason text NOT NULL CHECK (reason IN ('DRAW', 'CURRENT', 'EXPLICIT', 'REBUILD')),
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, round_id, beat_id),
  FOREIGN KEY (user_id, round_id) REFERENCES catalog_playback_rounds(user_id, round_id) ON DELETE CASCADE
);

-- resultado idempotente de cada comando musical (misma transacción que el swap): el retry devuelve el mismo beat sin consumir otro.
CREATE TABLE catalog_round_commands (
  user_id text NOT NULL,
  round_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  kind text NOT NULL CHECK (kind IN ('NEXT', 'CONSUME')),
  sequence bigint NOT NULL CHECK (sequence >= 0),
  result_json text NOT NULL CHECK (octet_length(result_json) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, round_id, idempotency_key),
  FOREIGN KEY (user_id, round_id) REFERENCES catalog_playback_rounds(user_id, round_id) ON DELETE CASCADE
);

-- concesiones de acceso a medios: solo el hash del token; ligadas a usuario, generación, archivo/parte, época y revisión del archivo.
CREATE TABLE catalog_media_grants (
  grant_hash text PRIMARY KEY CHECK (grant_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL,
  generation_id text NOT NULL,
  file_id text NOT NULL,
  part_index integer NOT NULL CHECK (part_index >= 0),
  beat_id text NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  file_revision bigint NOT NULL CHECK (file_revision > 0),
  object_id text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  uses integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  FOREIGN KEY (user_id, generation_id, file_id, part_index) REFERENCES catalog_file_parts(user_id, generation_id, file_id, part_index) ON DELETE CASCADE,
  FOREIGN KEY (user_id, object_id) REFERENCES catalog_media_objects(user_id, object_id)
);
CREATE INDEX catalog_media_grants_file_idx ON catalog_media_grants(user_id, generation_id, file_id, status);
CREATE INDEX catalog_media_grants_live_idx ON catalog_media_grants(expires_at) WHERE status = 'ACTIVE';

COMMIT;
