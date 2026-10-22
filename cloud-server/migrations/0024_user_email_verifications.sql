BEGIN;

CREATE TABLE IF NOT EXISTS user_email_verifications (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION invalidate_user_email_verification_on_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF lower(btrim(OLD.email)) IS DISTINCT FROM lower(btrim(NEW.email)) THEN
    DELETE FROM user_email_verifications WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_email_verification_invalidation ON users;
CREATE TRIGGER users_email_verification_invalidation
AFTER UPDATE OF email ON users
FOR EACH ROW EXECUTE FUNCTION invalidate_user_email_verification_on_change();

COMMIT;
