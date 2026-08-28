BEGIN;

CREATE TABLE direct_capabilities (
  capability_hash text PRIMARY KEY CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
  internal_operation_id text NOT NULL UNIQUE,
  user_id text NOT NULL,
  tenant_id text NOT NULL,
  installation_id text NOT NULL,
  auth_session_hash text NOT NULL CHECK (auth_session_hash ~ '^[0-9a-f]{64}$'),
  session_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  vault_scope text NOT NULL,
  operation_type text NOT NULL,
  object_scope jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','AUTHORIZED','CONSUMED','REVOKED','EXPIRED')),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  authorized_at timestamptz,
  consumed_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (jsonb_typeof(object_scope) = 'object'),
  CHECK (expires_at > issued_at),
  CHECK (status NOT IN ('AUTHORIZED','CONSUMED') OR authorized_at IS NOT NULL),
  CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL)),
  CHECK (status <> 'REVOKED' OR revoked_at IS NOT NULL)
);

CREATE INDEX direct_capabilities_tenant_live_idx
  ON direct_capabilities(tenant_id, expires_at)
  WHERE status IN ('ACTIVE','AUTHORIZED');
CREATE INDEX direct_capabilities_session_live_idx
  ON direct_capabilities(installation_id, session_id)
  WHERE status IN ('ACTIVE','AUTHORIZED');
CREATE INDEX direct_capabilities_auth_live_idx
  ON direct_capabilities(auth_session_hash)
  WHERE status IN ('ACTIVE','AUTHORIZED');

COMMIT;
