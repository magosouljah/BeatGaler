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

-- Persistent vault ownership is no longer constrained by the old session-era
-- four-active-leases-per-bot ceiling. Keep 0001 immutable and retire its
-- trigger/function here as part of the persistent assignment migration.
DROP TRIGGER IF EXISTS direct_leases_active_cap_trigger ON direct_leases;
DROP FUNCTION IF EXISTS enforce_transport_bot_active_lease_cap();

COMMIT;
