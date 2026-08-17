-- Migration: 20240101000004_lawyer_profiles
-- Description: Lawyer profiles, documents, availability, practice areas, bank details
-- Depends on: 20240101000003_identity, 20240101000002_geography

CREATE TABLE IF NOT EXISTS lawyer_profiles (
  account_id                UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  first_name                TEXT NOT NULL,
  last_name                 TEXT NOT NULL,
  email                     CITEXT,
  bar_council_number        TEXT NOT NULL UNIQUE,
  enrollment_year           SMALLINT,
  primary_specialization    TEXT,
  specializations           TEXT[]         DEFAULT '{}',
  years_experience          SMALLINT       DEFAULT 0,
  bio                       TEXT,
  city_id                   INTEGER        REFERENCES cities(id),
  city                      TEXT,          -- denormalised display name
  languages                 TEXT[]         DEFAULT '{"English"}',
  education                 JSONB          DEFAULT '[]',
  expertise                 TEXT[]         DEFAULT '{}',
  achievements              TEXT[]         DEFAULT '{}',
  consultation_fee_chat     NUMERIC(10,2)  DEFAULT 20,
  consultation_fee_voice    NUMERIC(10,2)  DEFAULT 30,
  consultation_fee_video    NUMERIC(10,2)  DEFAULT 40,
  cases_handled             INTEGER        DEFAULT 0,
  avg_rating                NUMERIC(3,2)   DEFAULT 0,
  total_reviews             INTEGER        DEFAULT 0,
  is_online                 BOOLEAN        NOT NULL DEFAULT false,
  verification_status       verification_status NOT NULL DEFAULT 'unverified',
  verified_at               TIMESTAMPTZ,
  rejection_reason          TEXT,
  created_at                TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lawyer_documents (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID    NOT NULL REFERENCES lawyer_profiles(account_id) ON DELETE CASCADE,
  doc_type     doc_type NOT NULL,
  storage_path TEXT    NOT NULL,
  status       doc_verify_status NOT NULL DEFAULT 'pending',
  notes        TEXT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS practice_areas (
  id    SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  slug  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lawyer_practice_areas (
  account_id   UUID     NOT NULL REFERENCES lawyer_profiles(account_id) ON DELETE CASCADE,
  area_id      SMALLINT NOT NULL REFERENCES practice_areas(id) ON DELETE CASCADE,
  PRIMARY KEY (account_id, area_id)
);

CREATE TABLE IF NOT EXISTS lawyer_bank_details (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES lawyer_profiles(account_id) ON DELETE CASCADE,
  beneficiary     TEXT NOT NULL,
  account_number  TEXT NOT NULL,
  ifsc            TEXT NOT NULL,
  bank_name       TEXT NOT NULL,
  is_primary      BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, account_number)
);

CREATE TABLE IF NOT EXISTS saved_lawyers (
  client_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lawyer_id  UUID NOT NULL REFERENCES lawyer_profiles(account_id) ON DELETE CASCADE,
  saved_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, lawyer_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_lawyer_profiles_status ON lawyer_profiles(verification_status);
CREATE INDEX IF NOT EXISTS idx_lawyer_profiles_online ON lawyer_profiles(is_online) WHERE is_online = true;
CREATE INDEX IF NOT EXISTS idx_lawyer_profiles_rating ON lawyer_profiles(avg_rating DESC);

CREATE OR REPLACE TRIGGER trg_lawyer_profiles_updated_at
  BEFORE UPDATE ON lawyer_profiles
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- RLS
ALTER TABLE lawyer_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lawyer_profiles_public_read  ON lawyer_profiles;
DROP POLICY IF EXISTS lawyer_profiles_self_update  ON lawyer_profiles;
DROP POLICY IF EXISTS lawyer_profiles_admin_all    ON lawyer_profiles;

CREATE POLICY lawyer_profiles_public_read ON lawyer_profiles
  FOR SELECT USING (verification_status = 'verified');

CREATE POLICY lawyer_profiles_self_update ON lawyer_profiles
  FOR UPDATE USING (auth.uid() = account_id);

CREATE POLICY lawyer_profiles_admin_all ON lawyer_profiles
  USING (EXISTS (SELECT 1 FROM accounts WHERE id = auth.uid() AND role = 'admin'));
