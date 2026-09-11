BEGIN;

ALTER TABLE vaults
  ADD COLUMN transport_bot_id text REFERENCES transport_bots(id),
  ADD COLUMN transport_membership_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN transport_membership_updated_at timestamptz;

ALTER TABLE vaults
  ADD CONSTRAINT vaults_transport_membership_state_check
  CHECK (transport_membership_state IN ('pending', 'ready', 'repair'));

CREATE INDEX vaults_transport_bot_id_idx
  ON vaults(transport_bot_id);

COMMIT;
