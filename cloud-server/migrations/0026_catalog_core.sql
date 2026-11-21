BEGIN;

-- T03 — Catálogo PostgreSQL: esquema base (CONTRATO C3 + precisiones T01-B, fase T03 de contract-map.ddl_phases).
-- Aditiva: no modifica datos ni migraciones anteriores. Toda biblioteca nace LEGACY con cleanup deshabilitado;
-- esta migración no importa nada ni cambia autoridad. Operaciones/eventos (T07), transferencias/jobs (T09),
-- shuffle (T14), purge (T15) y migration runs (T17) se añaden en sus fases: ninguna FK apunta hacia adelante.
-- Contenido legacy siempre en TEXT (JSON con escapes ASCII), nunca en JSON binario (D-03/D-08, aprobado 2026-11-08).

ALTER TABLE vaults ADD CONSTRAINT vaults_user_id_id_key UNIQUE (user_id, id);

CREATE TABLE catalog_libraries (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vault_id text NOT NULL UNIQUE,
  authority text NOT NULL DEFAULT 'LEGACY' CHECK (authority IN ('LEGACY', 'POSTGRES')),
  migration_state text NOT NULL DEFAULT 'IDLE'
    CHECK (migration_state IN ('IDLE', 'SHADOW', 'FREEZING', 'FROZEN', 'ROLLBACK', 'REVIEW')),
  authority_era uuid NOT NULL DEFAULT gen_random_uuid(),
  authority_epoch bigint NOT NULL DEFAULT 1 CHECK (authority_epoch > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  active_generation_id text,
  -- 'ACTIVE' cuando hay generación activa: la FK compuesta exige que esa generación esté ACTIVE.
  active_generation_status text GENERATED ALWAYS AS (CASE WHEN active_generation_id IS NULL THEN NULL ELSE 'ACTIVE' END) STORED,
  active_count bigint NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  trash_count bigint NOT NULL DEFAULT 0 CHECK (trash_count >= 0),
  purging_count bigint NOT NULL DEFAULT 0 CHECK (purging_count >= 0),
  pending_count bigint NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
  export_bytes_estimate bigint NOT NULL DEFAULT 0 CHECK (export_bytes_estimate >= 0),
  rollback_max_bytes bigint NOT NULL DEFAULT 15728640 CHECK (rollback_max_bytes > 0),
  cleanup_enabled boolean NOT NULL DEFAULT false,
  restore_hold boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_libraries_vault_fk FOREIGN KEY (user_id, vault_id) REFERENCES vaults(user_id, id) ON DELETE CASCADE,
  CONSTRAINT catalog_libraries_postgres_needs_generation CHECK (authority = 'LEGACY' OR active_generation_id IS NOT NULL),
  CONSTRAINT catalog_libraries_cleanup_only_postgres CHECK (NOT cleanup_enabled OR authority = 'POSTGRES')
);

CREATE TABLE catalog_generations (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  generation_id text NOT NULL CHECK (generation_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  snapshot_id text NOT NULL CHECK (snapshot_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  status text NOT NULL DEFAULT 'STAGING' CHECK (status IN ('STAGING', 'VALIDATED', 'ACTIVE', 'RETIRED')),
  source_hash text CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  raw_index bytea,
  raw_index_sha256 text CHECK (raw_index_sha256 ~ '^[0-9a-f]{64}$'),
  descriptor_json text,
  validated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, generation_id),
  UNIQUE (user_id, generation_id, status),
  CHECK (raw_index IS NULL OR encode(sha256(raw_index), 'hex') = raw_index_sha256),
  CHECK ((raw_index IS NULL) = (raw_index_sha256 IS NULL)),
  CHECK (status NOT IN ('VALIDATED', 'ACTIVE') OR (source_hash IS NOT NULL AND validated_at IS NOT NULL))
);
CREATE UNIQUE INDEX catalog_generations_one_active_idx ON catalog_generations(user_id) WHERE status = 'ACTIVE';

ALTER TABLE catalog_libraries ADD CONSTRAINT catalog_libraries_active_generation_fk
  FOREIGN KEY (user_id, active_generation_id, active_generation_status)
  REFERENCES catalog_generations(user_id, generation_id, status)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION catalog_generation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.generation_id <> OLD.generation_id OR NEW.snapshot_id <> OLD.snapshot_id THEN
    RAISE EXCEPTION 'catalog generation identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.raw_index_sha256 IS NOT NULL AND NEW.raw_index_sha256 IS DISTINCT FROM OLD.raw_index_sha256 THEN
    RAISE EXCEPTION 'catalog generation raw index is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'STAGING' AND NEW.status IN ('VALIDATED', 'RETIRED'))
    OR (OLD.status = 'VALIDATED' AND NEW.status IN ('ACTIVE', 'RETIRED'))
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'RETIRED')) THEN
    RAISE EXCEPTION 'catalog generation transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_generations_transition BEFORE UPDATE ON catalog_generations
  FOR EACH ROW EXECUTE FUNCTION catalog_generation_transition();

CREATE TABLE catalog_beats (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  beat_id text NOT NULL CHECK (
    char_length(beat_id) BETWEEN 1 AND 256
    -- longitud UTF-16 (JS) <= 256: cada carácter astral cuenta 2
    AND char_length(beat_id) + char_length(beat_id) - char_length(regexp_replace(beat_id, '[\U00010000-\U0010FFFF]', '', 'g')) <= 256
    AND beat_id !~ '^\s' AND beat_id !~ '\s$'),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'TRASH', 'PURGING', 'PURGED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  name text,
  bpm_text text,
  key_text text,
  rating smallint CHECK (rating BETWEEN 0 AND 255),
  color text,
  color2 text,
  -- A2 (r4): clase 0=-Infinity 1=finito 2=+Infinity 3=NaN/no numérico; valor binary64 solo para finitos.
  bpm_sort_class smallint NOT NULL DEFAULT 3 CHECK (bpm_sort_class BETWEEN 0 AND 3),
  bpm_sort double precision,
  sort_order integer,
  manual_rank numeric(40, 0) NOT NULL,
  telegram_topic_id bigint CHECK (telegram_topic_id > 0),
  has_artwork boolean NOT NULL DEFAULT false,
  direct_scope_compatible boolean GENERATED ALWAYS AS (beat_id ~ '^[A-Za-z0-9._:@+-]{1,192}$') STORED,
  legacy_json text NOT NULL,
  legacy_sha256 text NOT NULL CHECK (legacy_sha256 ~ '^[0-9a-f]{64}$'),
  legacy_presence text NOT NULL DEFAULT '{}',
  legacy_export_bytes bigint NOT NULL CHECK (legacy_export_bytes >= 0),
  projection_version integer NOT NULL DEFAULT 1 CHECK (projection_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, generation_id, beat_id),
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE,
  -- Destinos de FKs denormalizadas (ON UPDATE CASCADE) para estado y rango manual.
  UNIQUE (user_id, generation_id, beat_id, state),
  UNIQUE (user_id, generation_id, beat_id, state, manual_rank),
  CHECK (legacy_sha256 = encode(sha256(convert_to(legacy_json, 'UTF8')), 'hex')),
  CHECK ((bpm_sort_class = 1) = (bpm_sort IS NOT NULL)),
  CHECK (bpm_sort IS NULL OR bpm_sort NOT IN ('Infinity'::float8, '-Infinity'::float8, 'NaN'::float8))
);
CREATE INDEX catalog_beats_manual_idx ON catalog_beats(user_id, generation_id, state, manual_rank, beat_id);
CREATE INDEX catalog_beats_rating_idx ON catalog_beats(user_id, generation_id, state, rating, beat_id);
CREATE INDEX catalog_beats_bpm_idx ON catalog_beats(user_id, generation_id, state, bpm_sort_class, bpm_sort, beat_id);

CREATE TABLE catalog_beat_tags (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  beat_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  label text NOT NULL,
  norm_key text NOT NULL,
  projection_version integer NOT NULL DEFAULT 1 CHECK (projection_version > 0),
  PRIMARY KEY (user_id, generation_id, beat_id, position),
  FOREIGN KEY (user_id, generation_id, beat_id) REFERENCES catalog_beats(user_id, generation_id, beat_id) ON DELETE CASCADE
);
CREATE INDEX catalog_beat_tags_label_idx ON catalog_beat_tags(user_id, generation_id, label, beat_id);
CREATE INDEX catalog_beat_tags_norm_idx ON catalog_beat_tags(user_id, generation_id, norm_key, beat_id);

CREATE TABLE catalog_beat_tag_groups (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  beat_id text NOT NULL,
  norm_key text NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  state text NOT NULL,
  manual_rank numeric(40, 0) NOT NULL,
  first_position integer NOT NULL CHECK (first_position >= 0),
  label_at_first_position text NOT NULL,
  PRIMARY KEY (user_id, generation_id, beat_id, norm_key, projection_version),
  -- state/manual_rank siguen al beat en la misma transacción.
  FOREIGN KEY (user_id, generation_id, beat_id, state, manual_rank)
    REFERENCES catalog_beats(user_id, generation_id, beat_id, state, manual_rank) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (user_id, generation_id, beat_id, first_position)
    REFERENCES catalog_beat_tags(user_id, generation_id, beat_id, position) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX catalog_beat_tag_groups_rep_idx ON catalog_beat_tag_groups(user_id, generation_id, state, norm_key, manual_rank, beat_id);

CREATE TABLE catalog_facets (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('ACTIVE', 'TRASH')),
  norm_key text NOT NULL,
  projection_version integer NOT NULL CHECK (projection_version > 0),
  beat_count bigint NOT NULL CHECK (beat_count >= 0),
  rep_beat_id text,
  rep_position integer CHECK (rep_position >= 0),
  rep_label text,
  updated_revision bigint NOT NULL CHECK (updated_revision > 0),
  PRIMARY KEY (user_id, generation_id, scope, norm_key, projection_version),
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, generation_id, rep_beat_id, norm_key, projection_version)
    REFERENCES catalog_beat_tag_groups(user_id, generation_id, beat_id, norm_key, projection_version) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((beat_count = 0) = (rep_beat_id IS NULL)),
  CHECK ((rep_beat_id IS NULL) = (rep_position IS NULL) AND (rep_beat_id IS NULL) = (rep_label IS NULL))
);
CREATE INDEX catalog_facets_count_idx ON catalog_facets(user_id, generation_id, scope, beat_count DESC, norm_key);

CREATE TABLE catalog_trash_entries (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  beat_id text NOT NULL,
  beat_state text NOT NULL CHECK (beat_state IN ('TRASH', 'PURGING', 'PURGED')),
  wrapper_present boolean NOT NULL,
  trash_id text,
  trashed_at timestamptz,
  purge_after timestamptz,
  wrapper_json text,
  export_position integer NOT NULL CHECK (export_position >= 0),
  PRIMARY KEY (user_id, generation_id, beat_id),
  -- un beat restaurado a ACTIVE no puede conservar su entrada de papelera (la cascada viola el CHECK de beat_state)
  FOREIGN KEY (user_id, generation_id, beat_id, beat_state)
    REFERENCES catalog_beats(user_id, generation_id, beat_id, state) ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (wrapper_present OR (trash_id IS NULL AND trashed_at IS NULL AND purge_after IS NULL AND wrapper_json IS NULL))
);
CREATE UNIQUE INDEX catalog_trash_entries_trash_id_idx ON catalog_trash_entries(user_id, generation_id, trash_id) WHERE trash_id IS NOT NULL;

CREATE TABLE catalog_tombstones (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  beat_id text NOT NULL CHECK (char_length(beat_id) BETWEEN 1 AND 256),
  source text NOT NULL CHECK (source IN ('INDEX', 'SQL', 'BOTH', 'CATALOG')),
  deleted_at timestamptz,
  raw_key text CHECK (raw_key IN ('beat_id', 'id', 'both')),
  original_json text,
  export_position integer CHECK (export_position >= 0),
  sql_state text CHECK (sql_state IN ('CONFIRMED', 'LEGACY_TOMBSTONE')),
  assets_known boolean NOT NULL DEFAULT false,
  beat_sha256 text CHECK (beat_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (user_id, generation_id, beat_id),
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE,
  CHECK ((source IN ('INDEX', 'BOTH')) = (original_json IS NOT NULL AND raw_key IS NOT NULL AND export_position IS NOT NULL)),
  CHECK ((source IN ('SQL', 'BOTH')) = (sql_state IS NOT NULL))
);

-- Vivo vs tombstone es imposible (C1.11 / D-10): se rechaza en cualquiera de los dos lados.
CREATE FUNCTION catalog_reject_live_tombstone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'catalog_tombstones' THEN
    IF EXISTS (SELECT 1 FROM catalog_beats b WHERE b.user_id = NEW.user_id AND b.generation_id = NEW.generation_id
               AND b.beat_id = NEW.beat_id AND b.state IN ('ACTIVE', 'TRASH', 'PURGING')) THEN
      RAISE EXCEPTION 'catalog tombstone conflicts with a live beat' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.state IN ('ACTIVE', 'TRASH', 'PURGING') THEN
    IF EXISTS (SELECT 1 FROM catalog_tombstones t WHERE t.user_id = NEW.user_id AND t.generation_id = NEW.generation_id
               AND t.beat_id = NEW.beat_id) THEN
      RAISE EXCEPTION 'catalog live beat conflicts with a tombstone' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER catalog_tombstones_not_live AFTER INSERT OR UPDATE ON catalog_tombstones
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_reject_live_tombstone();
CREATE CONSTRAINT TRIGGER catalog_beats_not_tombstoned AFTER INSERT OR UPDATE OF state ON catalog_beats
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_reject_live_tombstone();

CREATE TABLE catalog_file_versions (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  file_id text NOT NULL CHECK (char_length(file_id) BETWEEN 1 AND 256),
  beat_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('MASTER', 'WAV', 'ARTWORK', 'PROJECT', 'SAMPLES', 'STEMS', 'LOOP', 'LEGACY_OTHER', 'METADATA')),
  legacy_path text NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  filename text,
  mime text,
  size_bytes bigint CHECK (size_bytes >= 0),
  declared_sha256 text CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  verified_sha256 text CHECK (verified_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'STAGED' CHECK (status IN ('STAGED', 'VERIFIED', 'RETIRED', 'DELETING', 'DELETED', 'REVIEW')),
  original_json text,
  retained_until timestamptz,
  backup_state text NOT NULL DEFAULT 'NONE' CHECK (backup_state IN ('NONE', 'PENDING', 'VERIFIED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, generation_id, file_id),
  UNIQUE (user_id, generation_id, beat_id, file_id),
  FOREIGN KEY (user_id, generation_id, beat_id) REFERENCES catalog_beats(user_id, generation_id, beat_id) ON DELETE CASCADE
);

CREATE TABLE catalog_file_parts (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  file_id text NOT NULL,
  part_index integer NOT NULL CHECK (part_index >= 0),
  size_bytes bigint CHECK (size_bytes >= 0),
  declared_sha256 text CHECK (declared_sha256 ~ '^[0-9a-f]{64}$'),
  verified_sha256 text CHECK (verified_sha256 ~ '^[0-9a-f]{64}$'),
  original_json text,
  PRIMARY KEY (user_id, generation_id, file_id, part_index),
  FOREIGN KEY (user_id, generation_id, file_id) REFERENCES catalog_file_versions(user_id, generation_id, file_id) ON DELETE CASCADE
);

CREATE TABLE catalog_media_objects (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  object_id text NOT NULL CHECK (char_length(object_id) BETWEEN 1 AND 128),
  provider text NOT NULL CHECK (provider IN ('telegram')),
  chat_id text NOT NULL CHECK (chat_id ~ '^-?[0-9]{1,20}$'),
  message_id bigint NOT NULL CHECK (message_id > 0),
  document_id text CHECK (document_id ~ '^-?[0-9]{1,20}$'),
  sender_id text CHECK (sender_id ~ '^-?[0-9]{1,20}$'),
  topic_id bigint CHECK (topic_id > 0),
  verified_at timestamptz,
  status text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('PRESENT', 'DELETING', 'DELETED', 'UNKNOWN')),
  deletion_generation text,
  PRIMARY KEY (user_id, object_id),
  UNIQUE (user_id, provider, chat_id, message_id)
);

CREATE TABLE catalog_part_locations (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  file_id text NOT NULL,
  part_index integer NOT NULL,
  location text NOT NULL CHECK (location IN ('PRIMARY', 'BACKUP')),
  reference_class text NOT NULL CHECK (reference_class IN ('KNOWN', 'OPAQUE')),
  object_id text,
  provider text NOT NULL,
  locator text NOT NULL,
  verification_level text CHECK (verification_level IN ('PROVIDER', 'BYTES')),
  checksum_sha256 text CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz,
  PRIMARY KEY (user_id, generation_id, file_id, part_index, location),
  FOREIGN KEY (user_id, generation_id, file_id, part_index)
    REFERENCES catalog_file_parts(user_id, generation_id, file_id, part_index) ON DELETE CASCADE,
  -- El objeto físico nunca se borra en cascada desde un snapshot.
  FOREIGN KEY (user_id, object_id) REFERENCES catalog_media_objects(user_id, object_id),
  CHECK ((reference_class = 'KNOWN') = (object_id IS NOT NULL)),
  CHECK (verification_level IS NULL OR verified_at IS NOT NULL)
);
CREATE INDEX catalog_part_locations_object_idx ON catalog_part_locations(user_id, object_id);

CREATE TABLE catalog_current_files (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  beat_id text NOT NULL,
  slot_key text NOT NULL CHECK (slot_key ~ '^(MASTER|ARTWORK|PROJECT|METADATA|FILES:[0-9]{1,6})$'),
  file_id text NOT NULL,
  PRIMARY KEY (user_id, generation_id, beat_id, slot_key),
  FOREIGN KEY (user_id, generation_id, beat_id, file_id)
    REFERENCES catalog_file_versions(user_id, generation_id, beat_id, file_id) ON DELETE CASCADE
);

CREATE TABLE catalog_legacy_fields (
  user_id text NOT NULL,
  generation_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('root', 'garbage', 'deleted', 'trash_wrapper', 'topic_map')),
  key text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  value_json text NOT NULL,
  reference_class text NOT NULL DEFAULT 'NONE' CHECK (reference_class IN ('NONE', 'KNOWN', 'OPAQUE')),
  PRIMARY KEY (user_id, generation_id, scope, key, ordinal),
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE
);

CREATE TABLE catalog_query_sets (
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  set_id text NOT NULL CHECK (set_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  generation_id text NOT NULL,
  authority_era uuid NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  scope text NOT NULL CHECK (scope IN ('ACTIVE', 'TRASH', 'BOTH')),
  predicate_json text NOT NULL CHECK (octet_length(predicate_json) <= 8192),
  predicate_version integer NOT NULL CHECK (predicate_version > 0),
  predicate_hash text NOT NULL CHECK (predicate_hash ~ '^[0-9a-f]{64}$'),
  base_revision bigint NOT NULL CHECK (base_revision > 0),
  status text NOT NULL DEFAULT 'BUILDING' CHECK (status IN ('BUILDING', 'READY', 'STALE', 'FAILED', 'CANCELLED', 'RELEASED')),
  member_count bigint NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  frontier_beat_id text,
  checkpoint_seq bigint NOT NULL DEFAULT 0 CHECK (checkpoint_seq >= 0),
  auto_retry_used boolean NOT NULL DEFAULT false,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, set_id),
  UNIQUE (user_id, set_id, generation_id),
  FOREIGN KEY (user_id, generation_id) REFERENCES catalog_generations(user_id, generation_id) ON DELETE CASCADE,
  CHECK ((status = 'FAILED') = (error_code IS NOT NULL))
);
CREATE UNIQUE INDEX catalog_query_sets_reuse_idx ON catalog_query_sets(user_id, generation_id, predicate_hash, base_revision)
  WHERE status IN ('BUILDING', 'READY');
CREATE UNIQUE INDEX catalog_query_sets_one_building_idx ON catalog_query_sets(user_id) WHERE status = 'BUILDING';

CREATE TABLE catalog_query_set_leases (
  user_id text NOT NULL,
  set_id text NOT NULL,
  consumer_id text NOT NULL CHECK (char_length(consumer_id) BETWEEN 1 AND 128),
  consumer_kind text NOT NULL CHECK (consumer_kind IN ('SELECTION', 'SHUFFLE', 'OPERATION', 'BUILD')),
  lease_until timestamptz NOT NULL,
  PRIMARY KEY (user_id, set_id, consumer_id),
  FOREIGN KEY (user_id, set_id) REFERENCES catalog_query_sets(user_id, set_id) ON DELETE CASCADE
);

CREATE TABLE catalog_query_members (
  user_id text NOT NULL,
  set_id text NOT NULL,
  slot bigint NOT NULL CHECK (slot >= 0),
  generation_id text NOT NULL,
  beat_id text NOT NULL,
  expected_version bigint NOT NULL CHECK (expected_version > 0),
  PRIMARY KEY (user_id, set_id, slot),
  UNIQUE (user_id, set_id, beat_id),
  FOREIGN KEY (user_id, set_id, generation_id) REFERENCES catalog_query_sets(user_id, set_id, generation_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, generation_id, beat_id) REFERENCES catalog_beats(user_id, generation_id, beat_id)
);

CREATE FUNCTION catalog_query_set_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.set_id <> OLD.set_id OR NEW.generation_id <> OLD.generation_id
     OR NEW.predicate_hash <> OLD.predicate_hash OR NEW.base_revision <> OLD.base_revision THEN
    RAISE EXCEPTION 'catalog query set identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'BUILDING' AND NEW.status IN ('READY', 'STALE', 'FAILED', 'CANCELLED'))
    OR (OLD.status IN ('READY', 'STALE', 'FAILED', 'CANCELLED') AND NEW.status = 'RELEASED')) THEN
    RAISE EXCEPTION 'catalog query set transition % -> % is not allowed', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_query_sets_transition BEFORE UPDATE ON catalog_query_sets
  FOR EACH ROW EXECUTE FUNCTION catalog_query_set_transition();

-- READY exige member_count = count(*) = max(slot)+1 (slots densos 0..m-1).
CREATE FUNCTION catalog_query_set_ready_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n bigint; mx bigint;
BEGIN
  IF NEW.status = 'READY' THEN
    SELECT count(*), max(slot) INTO n, mx FROM catalog_query_members WHERE user_id = NEW.user_id AND set_id = NEW.set_id;
    IF n <> NEW.member_count OR coalesce(mx + 1, 0) <> n THEN
      RAISE EXCEPTION 'catalog query set READY with % members (max slot %) but member_count %', n, mx, NEW.member_count USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER catalog_query_sets_ready AFTER INSERT OR UPDATE ON catalog_query_sets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION catalog_query_set_ready_check();

COMMIT;
