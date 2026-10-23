BEGIN;

-- Existing vaults have unknown Telegram history and cannot infer an empty INDEX
-- from a missing pointer. Only vaults inserted after this migration opt in.
ALTER TABLE vaults ADD COLUMN index_bootstrap_pending boolean NOT NULL DEFAULT false;

COMMIT;
