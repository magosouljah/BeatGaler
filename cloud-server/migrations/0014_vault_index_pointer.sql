BEGIN;

-- Telegram's INDEX document remains the library authority.  This table is a
-- durable, vault-scoped shortcut to that document and never stores manifest
-- content or transport credentials.
CREATE TABLE vault_index_pointers (
  vault_id text PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  index_message_id bigint NOT NULL CHECK (index_message_id > 0),
  predecessor_message_id bigint CHECK (predecessor_message_id IS NULL OR predecessor_message_id > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  source text NOT NULL CHECK (source IN ('publish', 'pin_recovery', 'history_recovery', 'migration')),
  verified_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX vault_index_pointers_message_idx ON vault_index_pointers(index_message_id);

COMMIT;
