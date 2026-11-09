BEGIN;

-- T19-N — Restore PostgreSQL (NATIVO r2.1 §11). Aditiva. Una corrida de restore deja a la instancia restaurada en HELD: los workers no
-- reclaman jobs de ninguna biblioteca hasta que la reconciliación del journal externo termine sin hallazgos bloqueantes (RECONCILED).
-- No hay vía de recuperación distinta de PostgreSQL ni importador de INDEX; estas tablas no guardan bytes de medios.
CREATE TABLE catalog_restore_runs (
  restore_id text PRIMARY KEY CHECK (restore_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  backup_id text NOT NULL CHECK (char_length(backup_id) BETWEEN 1 AND 128),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_taken_at timestamptz NOT NULL,
  restored_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'HELD' CHECK (status IN ('HELD', 'BLOCKED', 'RECONCILED')),
  libraries_epoch_bumped integer NOT NULL CHECK (libraries_epoch_bumped >= 0),
  reconciled_at timestamptz,
  CHECK ((status = 'RECONCILED') = (reconciled_at IS NOT NULL))
);

CREATE TABLE catalog_restore_findings (
  restore_id text NOT NULL REFERENCES catalog_restore_runs(restore_id),
  user_id text NOT NULL,
  object_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('PRESENT_CONFIRMED', 'DELETED_CONFIRMED', 'BYTES_RESTORED', 'UNRECOVERABLE', 'PROVIDER_UNREACHABLE', 'BYTES_MISMATCH', 'BYTES_MISSING', 'JOURNAL_NOT_IN_SQL')),
  detail text CHECK (char_length(detail) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (restore_id, user_id, object_id)
);
CREATE INDEX catalog_restore_findings_blocking_idx ON catalog_restore_findings(restore_id) WHERE kind IN ('UNRECOVERABLE', 'PROVIDER_UNREACHABLE', 'BYTES_MISMATCH', 'BYTES_MISSING');

COMMIT;
