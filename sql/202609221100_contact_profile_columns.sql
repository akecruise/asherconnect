-- Profile fields used by profile_update and the CRM mirror.
-- Additive and safe to run repeatedly; no existing data is rewritten.
ALTER TABLE core.contact
  ADD COLUMN IF NOT EXISTS picture_url text,
  ADD COLUMN IF NOT EXISTS profile_status text,
  ADD COLUMN IF NOT EXISTS profile_fetched_at timestamptz;
