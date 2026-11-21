BEGIN;

-- T17-N — CLI nativa (NATIVO-POSTGRES-20261108 r2.1 §4.2 paso 4, §4.3): auditoría durable y append-only de rebind-chat.
-- Aditiva: 0026/0027 no se modifican. catalog_chat_rebinds exige fila de catálogo (FK), pero un vault "en reset" aún no la
-- tiene; reset verifica aquí que el chat nuevo lo puso rebind-chat (no SQL directo). Solo TEXT para JSON (D-08).
CREATE TABLE catalog_vault_rebind_audit (
  rebind_id text PRIMARY KEY CHECK (rebind_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  environment_id text NOT NULL CHECK (environment_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  user_id text NOT NULL,
  vault_id text NOT NULL,
  from_chat_id text NOT NULL CHECK (from_chat_id ~ '^-?[0-9]{1,20}$'),
  to_chat_id text NOT NULL CHECK (to_chat_id ~ '^-?[0-9]{1,20}$'),
  library_authority text CHECK (library_authority IN ('LEGACY', 'POSTGRES')),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  approval_ref text NOT NULL CHECK (char_length(approval_ref) BETWEEN 1 AND 256),
  applied_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_chat_id <> to_chat_id)
);
CREATE INDEX catalog_vault_rebind_audit_vault_idx ON catalog_vault_rebind_audit(user_id, vault_id, applied_at);
-- Un chat abandonado o retirado nunca vuelve a ser destino (§4, §6: un chat pertenece a una sola biblioteca para siempre).
CREATE UNIQUE INDEX catalog_vault_rebind_audit_to_chat_idx ON catalog_vault_rebind_audit(to_chat_id);

CREATE FUNCTION catalog_vault_rebind_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CATALOG_NATIVE_RULE: rebind audit is append-only' USING ERRCODE = 'BGN04';
END $$;
CREATE TRIGGER catalog_vault_rebind_audit_immutable BEFORE UPDATE OR DELETE ON catalog_vault_rebind_audit
  FOR EACH ROW EXECUTE FUNCTION catalog_vault_rebind_audit_immutable();
CREATE TRIGGER catalog_vault_rebind_audit_truncate_guard BEFORE TRUNCATE ON catalog_vault_rebind_audit
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_forbid_truncate();

COMMIT;
