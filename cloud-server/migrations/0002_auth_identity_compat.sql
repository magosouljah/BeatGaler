BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username text,
  ADD COLUMN IF NOT EXISTS username_source text,
  ADD COLUMN IF NOT EXISTS password_salt text;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx
  ON users(username)
  WHERE username IS NOT NULL;

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_password_material_check;

ALTER TABLE users
  ADD CONSTRAINT users_password_material_check CHECK (
    (password_hash IS NULL AND password_hash_algorithm IS NULL AND password_salt IS NULL)
    OR
    (password_hash IS NOT NULL AND password_hash_algorithm IS NOT NULL AND password_salt IS NOT NULL)
  );

COMMIT;
