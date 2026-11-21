BEGIN;

-- T12 — Capacidades de transferencia (NATIVO r2.1 §8.6) y journal durable de intentos de envío por parte (CONTRATO C7.3–C7.9).
-- Aditiva. El cliente recibe un token opaco de vida corta y un solo uso; aquí se guarda solo su hash (como direct_capabilities).
-- Ningún cliente recibe chat, message_id ni credenciales. Esta tabla no guarda bytes de archivos.
-- bytes_sha256 es el hash calculado por el gateway sobre los bytes que entregó al proveedor (nivel GATEWAY): no es un hash de
-- bytes remotos (nivel BYTES, T14/T19) y nunca sustituye la verificación del proveedor (nivel PROVIDER).
CREATE TABLE catalog_transfer_capabilities (
  capability_hash text PRIMARY KEY CHECK (capability_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL,
  operation_id text NOT NULL,
  part_key text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('UPLOAD', 'PROJECT_UPLOAD')),
  authority_epoch bigint NOT NULL CHECK (authority_epoch > 0),
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'REDEEMED', 'CONSUMED', 'FAILED', 'EXPIRED', 'REVOKED')),
  outcome text CHECK (outcome IN ('SENT', 'UNCERTAIN', 'REJECTED', 'UPLOAD_FAILED', 'BYTES_MISMATCH', 'ABORTED', 'PERMANENT', 'REVOKED', 'ACCESS_DENIED', 'SUPERSEDED')),
  bytes_size bigint CHECK (bytes_size > 0),
  bytes_sha256 text CHECK (bytes_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  resolved_at timestamptz,
  last_error text CHECK (char_length(last_error) <= 1000),
  FOREIGN KEY (user_id, operation_id, part_key) REFERENCES catalog_operation_parts(user_id, operation_id, part_key) ON DELETE CASCADE,
  CHECK ((status IN ('CONSUMED', 'FAILED')) = (outcome IS NOT NULL)),
  CHECK ((status IN ('REDEEMED', 'CONSUMED', 'FAILED')) = (redeemed_at IS NOT NULL)),
  CHECK ((status IN ('CONSUMED', 'FAILED', 'EXPIRED', 'REVOKED')) = (resolved_at IS NOT NULL)),
  CHECK (outcome IS NULL OR (status = 'CONSUMED') = (outcome IN ('SENT', 'UNCERTAIN')))
);
CREATE INDEX catalog_transfer_capabilities_part_idx ON catalog_transfer_capabilities(user_id, operation_id, part_key, status);
CREATE INDEX catalog_transfer_capabilities_live_idx ON catalog_transfer_capabilities(expires_at) WHERE status = 'ISSUED';

COMMIT;
