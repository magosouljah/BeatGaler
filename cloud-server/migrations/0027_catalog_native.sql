BEGIN;

-- T05-N — Catálogo nativo PostgreSQL (NATIVO-POSTGRES-20261108 r2.1 §3, §5.1 capa 0, §6, §6.1, §6.2, §7).
-- Aditiva: 0026 no se modifica. Solo tablas, columnas con default, funciones y triggers. Sin jsonb (D-08).
-- Toda guarda se activa únicamente si existe la fila de catalog_native_activation o si la biblioteca/generación
-- es nativa (origin NATIVE o RESET): T03/T04 (bibliotecas LEGACY sin activación) quedan intactas por construcción.
-- La capa 0 es defensa en profundidad del ledger legacy, no cerco: no impide efectos externos ya enviados (§5 B1).

-- §3.1 Activación del entorno: una sola fila, escrita solo por T17-N activate con autorización.
CREATE TABLE catalog_native_activation (
  environment_id text PRIMARY KEY CHECK (environment_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  activated_at timestamptz NOT NULL DEFAULT now(),
  run_id text NOT NULL CHECK (char_length(run_id) BETWEEN 1 AND 128),
  -- Lista JSON de ids de bots permitidos en TEXT (D-08). Se valida en el código.
  transport_bot_ids text NOT NULL,
  direct_token_exposure text NOT NULL CHECK (direct_token_exposure IN ('ROTATED', 'FRESH_BOTS')),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  instance_inventory text NOT NULL
);
CREATE UNIQUE INDEX catalog_native_activation_single_idx ON catalog_native_activation((1));

-- §3.2 Marca positiva: solo la pone la DB al insertar un vault después de la activación.
ALTER TABLE vaults ADD COLUMN catalog_native_eligible boolean NOT NULL DEFAULT false;

-- §7 Origen de generación: LEGACY_IMPORT (T03/T04), NATIVE (provision) o RESET (T17-N reset). Inmutable.
ALTER TABLE catalog_generations ADD COLUMN origin text NOT NULL DEFAULT 'LEGACY_IMPORT'
  CHECK (origin IN ('LEGACY_IMPORT', 'NATIVE', 'RESET'));
ALTER TABLE catalog_generations ADD COLUMN retired_at timestamptz;

-- §4, §6 Un chat pertenece a una sola biblioteca para siempre (PK global por proveedor).
CREATE TABLE catalog_library_chats (
  provider text NOT NULL CHECK (provider IN ('telegram')),
  chat_id text NOT NULL CHECK (chat_id ~ '^-?[0-9]{1,20}$'),
  -- La cascada solo puede ocurrir tras pasar catalog_libraries_delete_guard (borrado de cuenta autorizado, §6.1).
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  vault_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('CURRENT', 'RETIRED', 'LEGACY_ABANDONED')),
  bound_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  PRIMARY KEY (provider, chat_id),
  CHECK ((state = 'CURRENT') = (retired_at IS NULL))
);
CREATE UNIQUE INDEX catalog_library_chats_one_current_idx ON catalog_library_chats(user_id) WHERE state = 'CURRENT';

-- §4.3 Ventana de rebind-chat: única vía para cambiar vaults.telegram_chat_id de una biblioteca nativa.
CREATE TABLE catalog_chat_rebinds (
  rebind_id text PRIMARY KEY CHECK (rebind_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  user_id text NOT NULL REFERENCES catalog_libraries(user_id) ON DELETE CASCADE,
  vault_id text NOT NULL,
  from_chat_id text NOT NULL CHECK (from_chat_id ~ '^-?[0-9]{1,20}$'),
  to_chat_id text NOT NULL CHECK (to_chat_id ~ '^-?[0-9]{1,20}$'),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'APPLIED', 'CANCELLED')),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK (from_chat_id <> to_chat_id),
  CHECK ((state = 'OPEN') = (closed_at IS NULL))
);
CREATE UNIQUE INDEX catalog_chat_rebinds_one_open_idx ON catalog_chat_rebinds(user_id) WHERE state = 'OPEN';

-- §6.1 Borrado de cuenta controlado: solo la tabla y la excepción del trigger. Ningún código inserta filas (deshabilitado).
CREATE TABLE catalog_account_deletions (
  deletion_id text PRIMARY KEY CHECK (deletion_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  user_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('REQUESTED', 'COOLING_OFF', 'FROZEN', 'PURGING', 'MEDIA_DELETED', 'DB_DELETED')),
  actor text NOT NULL CHECK (actor IN ('OWNER', 'OPERATOR')),
  manifest_sha256 text CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX catalog_account_deletions_live_idx ON catalog_account_deletions(user_id) WHERE state <> 'DB_DELETED';

-- §6.2 Cuarentena por usuario del flush del control-plane.
CREATE TABLE control_plane_flush_quarantine (
  user_id text NOT NULL,
  field text NOT NULL CHECK (field IN ('telegram_chat_id', 'id', 'user_id')),
  value_sha256 text NOT NULL CHECK (value_sha256 ~ '^[0-9a-f]{64}$'),
  detected_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  resolved_at timestamptz,
  resolution text CHECK (resolution IN ('REBIND', 'REVERTED')),
  PRIMARY KEY (user_id, field),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE INDEX control_plane_flush_quarantine_open_idx ON control_plane_flush_quarantine(user_id) WHERE resolved_at IS NULL;

-- Predicados comunes -------------------------------------------------------------------------------

CREATE FUNCTION catalog_native_activated() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM catalog_native_activation)
$$;

-- Biblioteca POSTGRES cuya guarda está activa: generación activa NATIVE/RESET o entorno activado.
CREATE FUNCTION catalog_native_library(p_user text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM catalog_libraries l
    LEFT JOIN catalog_generations g ON g.user_id = l.user_id AND g.generation_id = l.active_generation_id
    WHERE l.user_id = p_user AND l.authority = 'POSTGRES'
      AND (g.origin IN ('NATIVE', 'RESET') OR catalog_native_activated()))
$$;

CREATE FUNCTION catalog_generation_native(p_user text, p_generation text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM catalog_generations g WHERE g.user_id = p_user AND g.generation_id = p_generation
    AND g.origin IN ('NATIVE', 'RESET'))
$$;

-- §6.1: solo una sesión del job de borrado, con la fila en MEDIA_DELETED y la GUC igual a su id.
CREATE FUNCTION catalog_account_deletion_authorized(p_user text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM catalog_account_deletions d WHERE d.user_id = p_user AND d.state = 'MEDIA_DELETED'
    AND d.deletion_id = current_setting('beatgaler.account_deletion_id', true))
$$;

-- §3.2 La marca la escribe la DB. En ON CONFLICT DO UPDATE el SET no incluye la columna: un vault existente sigue en false.
CREATE FUNCTION catalog_vault_native_eligible() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.catalog_native_eligible := catalog_native_activated();
  RETURN NEW;
END $$;
CREATE TRIGGER vaults_catalog_native_eligible BEFORE INSERT ON vaults
  FOR EACH ROW EXECUTE FUNCTION catalog_vault_native_eligible();

-- Capa 0 (§5.1): el ledger legacy de una biblioteca nativa es inescribible. SQLSTATE BGL01 = CATALOG_LEGACY_WRITE_FORBIDDEN.
CREATE FUNCTION catalog_legacy_write_forbidden() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r record;
  uid text;
  op text;
BEGIN
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  IF TG_TABLE_NAME IN ('direct_operations', 'direct_capabilities') THEN
    op := r.operation_type;
    IF op IS NULL OR op NOT IN ('get_index', 'replace_index', 'delete_messages') THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME IN ('vault_index_pointers', 'garbage_journal', 'direct_operations') THEN
    SELECT v.user_id INTO uid FROM vaults v WHERE v.id = r.vault_id;
  ELSE
    uid := r.user_id;
  END IF;
  IF uid IS NOT NULL AND catalog_native_library(uid) THEN
    RAISE EXCEPTION 'CATALOG_LEGACY_WRITE_FORBIDDEN: % on % for a PostgreSQL-native library', TG_OP, TG_TABLE_NAME
      USING ERRCODE = 'BGL01', DETAIL = 'user_id=' || uid;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE TRIGGER vault_index_pointers_catalog_fence BEFORE INSERT OR UPDATE OR DELETE ON vault_index_pointers
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();
CREATE TRIGGER library_quota_state_catalog_fence BEFORE INSERT OR UPDATE OR DELETE ON library_quota_state
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();
CREATE TRIGGER library_beats_catalog_fence BEFORE INSERT OR UPDATE OR DELETE ON library_beats
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();
CREATE TRIGGER library_trash_purges_catalog_fence BEFORE INSERT OR UPDATE OR DELETE ON library_trash_purges
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();
CREATE TRIGGER library_beat_reservations_catalog_fence BEFORE INSERT OR UPDATE OR DELETE ON library_beat_reservations
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();
CREATE TRIGGER library_project_uploads_catalog_fence BEFORE INSERT OR UPDATE OR DELETE ON library_project_uploads
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();
CREATE TRIGGER library_legacy_project_copies_catalog_fence BEFORE INSERT OR UPDATE OR DELETE ON library_legacy_project_copies
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();
CREATE TRIGGER garbage_journal_catalog_fence BEFORE INSERT OR UPDATE OR DELETE ON garbage_journal
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();
CREATE TRIGGER direct_operations_catalog_fence BEFORE INSERT ON direct_operations
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();
CREATE TRIGGER direct_capabilities_catalog_fence BEFORE INSERT ON direct_capabilities
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_write_forbidden();

-- Pin authority 0016/0017 vive en columnas de vaults: tampoco se reescribe para una biblioteca nativa.
CREATE FUNCTION catalog_vault_pin_authority_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.index_pin_restricted_bot_id IS DISTINCT FROM OLD.index_pin_restricted_bot_id
      OR NEW.index_pin_restricted_at IS DISTINCT FROM OLD.index_pin_restricted_at
      OR NEW.project_media_restricted_bot_id IS DISTINCT FROM OLD.project_media_restricted_bot_id)
     AND catalog_native_library(OLD.user_id) THEN
    RAISE EXCEPTION 'CATALOG_LEGACY_WRITE_FORBIDDEN: pin authority update for a PostgreSQL-native library'
      USING ERRCODE = 'BGL01', DETAIL = 'user_id=' || OLD.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vaults_pin_authority_catalog_fence
  BEFORE UPDATE OF index_pin_restricted_bot_id, index_pin_restricted_at, project_media_restricted_bot_id ON vaults
  FOR EACH ROW EXECUTE FUNCTION catalog_vault_pin_authority_fence();

-- §6 Cascadas y reasignaciones. SQLSTATE BGC02 = CATALOG_CASCADE_FORBIDDEN, BGR03 = CATALOG_VAULT_REBIND_FORBIDDEN.
CREATE FUNCTION catalog_library_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF catalog_native_library(OLD.user_id) AND NOT catalog_account_deletion_authorized(OLD.user_id) THEN
    RAISE EXCEPTION 'CATALOG_CASCADE_FORBIDDEN: a PostgreSQL-native library cannot be deleted'
      USING ERRCODE = 'BGC02', DETAIL = 'user_id=' || OLD.user_id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER catalog_libraries_delete_guard BEFORE DELETE ON catalog_libraries
  FOR EACH ROW EXECUTE FUNCTION catalog_library_delete_guard();

CREATE FUNCTION catalog_generation_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.origin IN ('NATIVE', 'RESET') AND NOT catalog_account_deletion_authorized(OLD.user_id) THEN
    IF OLD.status = 'ACTIVE' THEN
      RAISE EXCEPTION 'CATALOG_CASCADE_FORBIDDEN: the ACTIVE native generation cannot be deleted'
        USING ERRCODE = 'BGC02', DETAIL = 'user_id=' || OLD.user_id;
    END IF;
    IF OLD.status <> 'RETIRED' OR OLD.retired_at IS NULL OR OLD.retired_at > now() - interval '35 days' THEN
      RAISE EXCEPTION 'CATALOG_CASCADE_FORBIDDEN: native generation % is inside the C9 retention window', OLD.generation_id
        USING ERRCODE = 'BGC02', DETAIL = 'user_id=' || OLD.user_id;
    END IF;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER catalog_generations_delete_guard BEFORE DELETE ON catalog_generations
  FOR EACH ROW EXECUTE FUNCTION catalog_generation_delete_guard();

CREATE FUNCTION catalog_media_object_delete_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DELETED' AND catalog_native_library(OLD.user_id) AND NOT catalog_account_deletion_authorized(OLD.user_id) THEN
    RAISE EXCEPTION 'CATALOG_CASCADE_FORBIDDEN: media object % is not DELETED', OLD.object_id
      USING ERRCODE = 'BGC02', DETAIL = 'user_id=' || OLD.user_id;
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER catalog_media_objects_delete_guard BEFORE DELETE ON catalog_media_objects
  FOR EACH ROW EXECUTE FUNCTION catalog_media_object_delete_guard();

-- INSERT de media object nativo solo en el chat CURRENT de ese usuario.
CREATE FUNCTION catalog_media_object_chat_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF catalog_native_library(NEW.user_id) AND NOT EXISTS (
      SELECT 1 FROM catalog_library_chats c WHERE c.provider = NEW.provider AND c.chat_id = NEW.chat_id
        AND c.user_id = NEW.user_id AND c.state = 'CURRENT') THEN
    RAISE EXCEPTION 'CATALOG_NATIVE_RULE: media object chat % is not CURRENT for this library', NEW.chat_id
      USING ERRCODE = 'BGN04', DETAIL = 'user_id=' || NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_media_objects_chat_guard BEFORE INSERT ON catalog_media_objects
  FOR EACH ROW EXECUTE FUNCTION catalog_media_object_chat_guard();

CREATE FUNCTION catalog_forbid_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF catalog_native_activated() THEN
    RAISE EXCEPTION 'CATALOG_CASCADE_FORBIDDEN: TRUNCATE % is not allowed in a native environment', TG_TABLE_NAME
      USING ERRCODE = 'BGC02';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER users_catalog_truncate_guard BEFORE TRUNCATE ON users FOR EACH STATEMENT EXECUTE FUNCTION catalog_forbid_truncate();
CREATE TRIGGER vaults_catalog_truncate_guard BEFORE TRUNCATE ON vaults FOR EACH STATEMENT EXECUTE FUNCTION catalog_forbid_truncate();
CREATE TRIGGER catalog_libraries_truncate_guard BEFORE TRUNCATE ON catalog_libraries FOR EACH STATEMENT EXECUTE FUNCTION catalog_forbid_truncate();
CREATE TRIGGER catalog_generations_truncate_guard BEFORE TRUNCATE ON catalog_generations FOR EACH STATEMENT EXECUTE FUNCTION catalog_forbid_truncate();
CREATE TRIGGER catalog_beats_truncate_guard BEFORE TRUNCATE ON catalog_beats FOR EACH STATEMENT EXECUTE FUNCTION catalog_forbid_truncate();
CREATE TRIGGER catalog_media_objects_truncate_guard BEFORE TRUNCATE ON catalog_media_objects FOR EACH STATEMENT EXECUTE FUNCTION catalog_forbid_truncate();
CREATE TRIGGER catalog_library_chats_truncate_guard BEFORE TRUNCATE ON catalog_library_chats FOR EACH STATEMENT EXECUTE FUNCTION catalog_forbid_truncate();

-- vaults.telegram_chat_id / id / user_id de una biblioteca nativa: solo con un rebind OPEN hacia ese chat (§4.3, §6).
CREATE FUNCTION catalog_vault_rebind_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT catalog_native_library(OLD.user_id) THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'CATALOG_VAULT_REBIND_FORBIDDEN: vault identity of a native library is immutable'
      USING ERRCODE = 'BGR03', DETAIL = 'user_id=' || OLD.user_id;
  END IF;
  IF NEW.telegram_chat_id IS DISTINCT FROM OLD.telegram_chat_id AND NOT EXISTS (
      SELECT 1 FROM catalog_chat_rebinds r WHERE r.user_id = OLD.user_id AND r.state = 'OPEN'
        AND r.from_chat_id = OLD.telegram_chat_id AND r.to_chat_id = NEW.telegram_chat_id) THEN
    RAISE EXCEPTION 'CATALOG_VAULT_REBIND_FORBIDDEN: telegram_chat_id change without an open rebind'
      USING ERRCODE = 'BGR03', DETAIL = 'user_id=' || OLD.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vaults_catalog_rebind_guard BEFORE UPDATE OF telegram_chat_id, id, user_id ON vaults
  FOR EACH ROW EXECUTE FUNCTION catalog_vault_rebind_guard();

-- Autoridad (§6, §7): sin LEGACY tras la activación, sin retorno POSTGRES→LEGACY, migration_state IDLE, época monótona.
-- SQLSTATE BGA05 = CATALOG_AUTHORITY_FORBIDDEN.
CREATE FUNCTION catalog_library_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.authority = 'LEGACY' AND catalog_native_activated() THEN
      RAISE EXCEPTION 'CATALOG_AUTHORITY_FORBIDDEN: LEGACY libraries cannot be created in a native environment'
        USING ERRCODE = 'BGA05', DETAIL = 'user_id=' || NEW.user_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.user_id <> OLD.user_id OR NEW.vault_id <> OLD.vault_id THEN
    IF catalog_native_library(OLD.user_id) OR catalog_native_activated() THEN
      RAISE EXCEPTION 'CATALOG_AUTHORITY_FORBIDDEN: library identity is immutable'
        USING ERRCODE = 'BGA05', DETAIL = 'user_id=' || OLD.user_id;
    END IF;
  END IF;
  IF OLD.authority = 'POSTGRES' AND NEW.authority = 'LEGACY' AND (catalog_native_activated() OR catalog_native_library(OLD.user_id)) THEN
    RAISE EXCEPTION 'CATALOG_AUTHORITY_FORBIDDEN: there is no return from POSTGRES to LEGACY'
      USING ERRCODE = 'BGA05', DETAIL = 'user_id=' || OLD.user_id;
  END IF;
  IF NEW.migration_state <> 'IDLE' AND (catalog_native_activated() OR catalog_native_library(OLD.user_id)) THEN
    RAISE EXCEPTION 'CATALOG_AUTHORITY_FORBIDDEN: native libraries are always IDLE'
      USING ERRCODE = 'BGA05', DETAIL = 'user_id=' || OLD.user_id;
  END IF;
  IF NEW.authority_epoch < OLD.authority_epoch AND catalog_native_library(OLD.user_id) THEN
    RAISE EXCEPTION 'CATALOG_AUTHORITY_FORBIDDEN: authority_epoch never decreases'
      USING ERRCODE = 'BGA05', DETAIL = 'user_id=' || OLD.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_libraries_authority_guard BEFORE INSERT OR UPDATE ON catalog_libraries
  FOR EACH ROW EXECUTE FUNCTION catalog_library_authority_guard();

-- §7 Reglas DB de generaciones nativas. SQLSTATE BGN04 = CATALOG_NATIVE_RULE.
CREATE FUNCTION catalog_generation_native_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.origin <> OLD.origin THEN
      RAISE EXCEPTION 'CATALOG_NATIVE_RULE: generation origin is immutable' USING ERRCODE = 'BGN04', DETAIL = 'user_id=' || OLD.user_id;
    END IF;
    IF NEW.status = 'RETIRED' AND OLD.status <> 'RETIRED' THEN NEW.retired_at := now(); END IF;
  END IF;
  IF NEW.origin IN ('NATIVE', 'RESET') AND (NEW.raw_index IS NOT NULL OR NEW.raw_index_sha256 IS NOT NULL) THEN
    RAISE EXCEPTION 'CATALOG_NATIVE_RULE: native generations never carry a raw INDEX' USING ERRCODE = 'BGN04', DETAIL = 'user_id=' || NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_generations_native_rules BEFORE INSERT OR UPDATE ON catalog_generations
  FOR EACH ROW EXECUTE FUNCTION catalog_generation_native_rules();

CREATE FUNCTION catalog_legacy_fields_native_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF catalog_generation_native(NEW.user_id, NEW.generation_id) THEN
    RAISE EXCEPTION 'CATALOG_NATIVE_RULE: native generations have no legacy fields' USING ERRCODE = 'BGN04', DETAIL = 'user_id=' || NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_legacy_fields_native_guard BEFORE INSERT OR UPDATE ON catalog_legacy_fields
  FOR EACH ROW EXECUTE FUNCTION catalog_legacy_fields_native_guard();

CREATE FUNCTION catalog_beats_native_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF catalog_generation_native(NEW.user_id, NEW.generation_id) AND NEW.beat_id !~ '^[A-Za-z0-9._:@+-]{1,192}$' THEN
    RAISE EXCEPTION 'CATALOG_NATIVE_RULE: native beat_id must be Direct-scope compatible' USING ERRCODE = 'BGN04', DETAIL = 'user_id=' || NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_beats_native_guard BEFORE INSERT OR UPDATE OF beat_id ON catalog_beats
  FOR EACH ROW EXECUTE FUNCTION catalog_beats_native_guard();

CREATE FUNCTION catalog_file_versions_native_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF catalog_generation_native(NEW.user_id, NEW.generation_id) AND NEW.role IN ('LEGACY_OTHER', 'METADATA') THEN
    RAISE EXCEPTION 'CATALOG_NATIVE_RULE: role % is not used by native libraries', NEW.role USING ERRCODE = 'BGN04', DETAIL = 'user_id=' || NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_file_versions_native_guard BEFORE INSERT OR UPDATE OF role ON catalog_file_versions
  FOR EACH ROW EXECUTE FUNCTION catalog_file_versions_native_guard();

CREATE FUNCTION catalog_current_files_native_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF catalog_generation_native(NEW.user_id, NEW.generation_id) AND NEW.slot_key = 'METADATA' THEN
    RAISE EXCEPTION 'CATALOG_NATIVE_RULE: METADATA slot is not used by native libraries' USING ERRCODE = 'BGN04', DETAIL = 'user_id=' || NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_current_files_native_guard BEFORE INSERT OR UPDATE OF slot_key ON catalog_current_files
  FOR EACH ROW EXECUTE FUNCTION catalog_current_files_native_guard();

CREATE FUNCTION catalog_tombstones_native_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF catalog_generation_native(NEW.user_id, NEW.generation_id) AND NEW.source <> 'CATALOG' THEN
    RAISE EXCEPTION 'CATALOG_NATIVE_RULE: native tombstones are always source CATALOG' USING ERRCODE = 'BGN04', DETAIL = 'user_id=' || NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_tombstones_native_guard BEFORE INSERT OR UPDATE OF source ON catalog_tombstones
  FOR EACH ROW EXECUTE FUNCTION catalog_tombstones_native_guard();

-- §6.1 Los estados de borrado de cuenta solo avanzan; el titular no cambia.
CREATE FUNCTION catalog_account_deletion_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ord text[] := ARRAY['REQUESTED', 'COOLING_OFF', 'FROZEN', 'PURGING', 'MEDIA_DELETED', 'DB_DELETED'];
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.deletion_id <> OLD.deletion_id THEN
    RAISE EXCEPTION 'account deletion identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF array_position(ord, NEW.state) < array_position(ord, OLD.state) THEN
    RAISE EXCEPTION 'account deletion state % -> % is not allowed', OLD.state, NEW.state USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_account_deletions_transition BEFORE UPDATE ON catalog_account_deletions
  FOR EACH ROW EXECUTE FUNCTION catalog_account_deletion_transition();

CREATE FUNCTION catalog_chat_rebind_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id <> OLD.user_id OR NEW.from_chat_id <> OLD.from_chat_id OR NEW.to_chat_id <> OLD.to_chat_id THEN
    RAISE EXCEPTION 'chat rebind identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'OPEN' AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION 'chat rebind % is closed', OLD.rebind_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_chat_rebinds_transition BEFORE UPDATE ON catalog_chat_rebinds
  FOR EACH ROW EXECUTE FUNCTION catalog_chat_rebind_transition();

COMMIT;
