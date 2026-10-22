BEGIN;

-- Run auth-identity-preflight and resolve legacy collisions before this
-- migration. A failed unique index is safer than ambiguous account ownership.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_casefold_unique_idx
  ON users (lower(username))
  WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_casefold_unique_idx
  ON users (lower(email))
  WHERE email IS NOT NULL;

COMMIT;
