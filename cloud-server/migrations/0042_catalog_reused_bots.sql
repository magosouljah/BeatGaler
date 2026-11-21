BEGIN;

-- Owner-approved alternative to T17: reuse existing Telegram bot tokens without rotation.
-- Do not claim ROTATED or FRESH_BOTS. Record the exposure truthfully.
-- The caller must explicitly accept this reduced fencing guarantee at activation.
ALTER TABLE catalog_native_activation
  DROP CONSTRAINT catalog_native_activation_direct_token_exposure_check;
ALTER TABLE catalog_native_activation
  ADD CONSTRAINT catalog_native_activation_direct_token_exposure_check
  CHECK (direct_token_exposure IN ('ROTATED', 'FRESH_BOTS', 'REUSED_UNROTATED'));

COMMIT;
