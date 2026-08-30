-- ============================================================
-- whatsapp_config: remember the number's two-step verification PIN
--
-- Why this exists:
--   POST /{phone_number_id}/register SETS the number's two-step
--   verification PIN when none is configured, and REQUIRES the
--   existing one when there is. The manual setup flow asks the user
--   for it, so wacrm never had to store one.
--
--   Embedded Signup has no such screen — nobody is around to invent
--   a PIN mid-popup — so onboarding generates one. Generating it and
--   throwing it away leaves the tenant permanently unable to
--   re-register their own number, with a PIN that exists at Meta and
--   is known to nobody. That is a one-way door: the recovery path is
--   Meta support, not a button in this app.
--
--   Encrypted at rest with the same AES-256-GCM helper as
--   access_token / verify_token (`src/lib/whatsapp/encryption.ts`),
--   because it is a credential on the tenant's phone number.
--
-- Backfill: nullable. Manually-configured rows keep NULL — their
-- owner typed the PIN and knows it. Only Embedded Signup writes here.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS registration_pin TEXT;

COMMENT ON COLUMN whatsapp_config.registration_pin IS
  'AES-256-GCM encrypted 6-digit two-step verification PIN, generated during Embedded Signup. NULL for manually-configured rows.';
