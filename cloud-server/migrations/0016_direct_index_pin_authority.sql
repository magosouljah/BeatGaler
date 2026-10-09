BEGIN;

-- A READY bot from an older deployment may still be able to pin INDEX.
-- Record the assigned bot whose pin right MASTER has revoked before its next
-- temporary credential is returned to Web.
ALTER TABLE vaults ADD COLUMN index_pin_restricted_bot_id text;
ALTER TABLE vaults ADD COLUMN index_pin_restricted_at timestamptz;

COMMIT;
