BEGIN;

-- OAuth-only accounts may have no sign-in email. A staged, provider-reauthenticated
-- change can establish the first verified address without inventing an old one.
ALTER TABLE auth_email_changes
  ALTER COLUMN old_email DROP NOT NULL;

COMMIT;
