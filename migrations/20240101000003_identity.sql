-- Migration: 20240101000003_identity
-- Description: Core user accounts, OAuth identities, OTP codes
-- NOTE: This table extends Supabase Auth (auth.users). The 'id' references auth.users.
-- Depends on: 20240101000000, 20240101000002

CREATE TABLE IF NOT EXISTS accounts (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role            account_role         NOT NULL DEFAULT 'client',
  status          account_status       NOT NULL DEFAULT 'active',
  email           CITEXT               UNIQUE,
  phone           TEXT                 UNIQUE,
  first_name      TEXT,
  last_name       TEXT,
  avatar_url      TEXT,
  preferred_lang  TEXT                 NOT NULL DEFAULT 'en',
  city_id         INTEGER              REFERENCES cities(id),
  kyc_status      kyc_status           NOT NULL DEFAULT 'not_started',
  version         INTEGER              NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ          NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ          NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oauth_identities (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider    oauth_provider NOT NULL,
  provider_id TEXT    NOT NULL,
  email       CITEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_id)
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT    NOT NULL,
  code        TEXT    NOT NULL,
  purpose     otp_purpose NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_email  ON accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_phone  ON accounts(phone);
CREATE INDEX IF NOT EXISTS idx_accounts_role   ON accounts(role);
CREATE INDEX IF NOT EXISTS idx_otp_phone       ON otp_codes(phone, purpose);

CREATE OR REPLACE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at('version');

-- RLS
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounts_self_read   ON accounts;
DROP POLICY IF EXISTS accounts_self_update ON accounts;
DROP POLICY IF EXISTS accounts_admin_all   ON accounts;

CREATE POLICY accounts_self_read   ON accounts FOR SELECT USING (auth.uid() = id);
CREATE POLICY accounts_self_update ON accounts FOR UPDATE USING (auth.uid() = id);
CREATE POLICY accounts_admin_all   ON accounts USING (
  EXISTS (SELECT 1 FROM accounts WHERE id = auth.uid() AND role = 'admin')
);
