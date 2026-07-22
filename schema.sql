-- =====================================================================
-- LegalX Platform — Production PostgreSQL DDL (Comprehensive)
-- Includes:
-- 1. All 13 core bounded contexts + Future skeletons
-- 2. Sales Funnel (Guest Checkout for top-of-funnel conversion)
-- 3. Foundational Row Level Security (RLS) Policies
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";       -- case-insensitive email
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- fuzzy / ILIKE search
CREATE EXTENSION IF NOT EXISTS "btree_gist";   -- exclusion constraints (availability)


-- =====================================================================
-- SHARED CONVENTIONS
-- =====================================================================

CREATE OR REPLACE FUNCTION tg_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  IF TG_ARGV[0] = 'version' THEN
    NEW.version = COALESCE(OLD.version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- ENUM TYPES
-- =====================================================================
CREATE TYPE account_role        AS ENUM ('client','lawyer','admin');
CREATE TYPE account_status      AS ENUM ('active','suspended','banned','pending_deletion');
CREATE TYPE oauth_provider      AS ENUM ('google','apple');
CREATE TYPE otp_purpose         AS ENUM ('phone_verify','login','password_reset');

CREATE TYPE kyc_status            AS ENUM ('not_started','pending','verified','rejected');
CREATE TYPE wallet_txn_type       AS ENUM ('credit','debit');
CREATE TYPE notification_channel  AS ENUM ('push','email','sms','in_app');
CREATE TYPE notification_status   AS ENUM ('scheduled','sent','failed','read');

CREATE TYPE verification_status AS ENUM ('unverified','pending','verified','rejected','suspended');
CREATE TYPE doc_type            AS ENUM ('bar_certificate','id_proof','address_proof','degree_certificate','other');
CREATE TYPE payout_status       AS ENUM ('pending','processing','paid','failed','on_hold');

CREATE TYPE order_status        AS ENUM ('draft','pending_payment','in_progress','pending_customer_input','in_review','revision_requested','completed','cancelled','refunded');
CREATE TYPE doc_role            AS ENUM ('customer_upload','internal_draft','final_deliverable');
CREATE TYPE doc_verify_status   AS ENUM ('pending','approved','rejected');

CREATE TYPE message_role             AS ENUM ('user','assistant','system');

CREATE TYPE consult_type      AS ENUM ('chat','voice','video');
CREATE TYPE booking_status    AS ENUM ('requested','confirmed','in_progress','completed','cancelled','no_show','refunded');
CREATE TYPE session_status    AS ENUM ('not_started','active','ended','failed');

CREATE TYPE conversation_type AS ENUM ('consultation','support','general');
CREATE TYPE message_type      AS ENUM ('text','image','pdf','system');

CREATE TYPE gateway            AS ENUM ('razorpay','stripe');
CREATE TYPE order_type         AS ENUM ('consultation','service','wallet_topup','subscription');
CREATE TYPE payment_status     AS ENUM ('created','authorized','captured','failed','refunded','partially_refunded');
CREATE TYPE discount_type      AS ENUM ('flat','percentage');
CREATE TYPE settlement_status  AS ENUM ('pending','processing','paid','failed');

CREATE TYPE target_type         AS ENUM ('lawyer','service_order','consultation');
CREATE TYPE report_status       AS ENUM ('open','actioned','dismissed');

CREATE TYPE article_status      AS ENUM ('draft','published','archived');

-- =====================================================================
-- SALES FUNNEL (Guest Checkout / Lead Capture)
-- =====================================================================
CREATE TABLE leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  service_slug    TEXT NOT NULL,
  service_title   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new',
  source          TEXT NOT NULL DEFAULT 'apply-online',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER leads_updated BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

CREATE TABLE applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  service_slug    TEXT NOT NULL,
  form_data       JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'submitted',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER applications_updated BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- =====================================================================
-- GEO (shared lookup tables)
-- =====================================================================
CREATE TABLE countries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  iso_code      CHAR(2) NOT NULL UNIQUE,
  phone_code    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE states (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id    UUID NOT NULL REFERENCES countries(id),
  name          TEXT NOT NULL,
  code          TEXT,
  UNIQUE (country_id, name)
);

CREATE TABLE cities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id      UUID NOT NULL REFERENCES states(id),
  name          TEXT NOT NULL,
  UNIQUE (state_id, name)
);
CREATE INDEX idx_cities_name_trgm ON cities USING GIN (name gin_trgm_ops);

CREATE TABLE languages (
  id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code   TEXT NOT NULL UNIQUE,   -- ISO 639-1
  name   TEXT NOT NULL
);

-- =====================================================================
-- IDENTITY (auth)
-- =====================================================================
CREATE TABLE accounts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              CITEXT UNIQUE,
  phone              TEXT UNIQUE,
  password_hash      TEXT,
  role               account_role NOT NULL,
  status             account_status NOT NULL DEFAULT 'active',
  email_verified_at  TIMESTAMPTZ,
  phone_verified_at  TIMESTAMPTZ,
  last_login_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  created_by         UUID REFERENCES accounts(id),
  updated_by         UUID REFERENCES accounts(id),
  version            INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT chk_email_or_phone CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE INDEX idx_accounts_role ON accounts(role) WHERE deleted_at IS NULL;
CREATE INDEX idx_accounts_status ON accounts(status) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_accounts_updated BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at('version');

CREATE TABLE oauth_identities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider         oauth_provider NOT NULL,
  provider_user_id TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX idx_oauth_account ON oauth_identities(account_id);

CREATE TABLE refresh_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  device_id     TEXT,
  device_label  TEXT,
  ip_address    INET,
  user_agent    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
);
CREATE INDEX idx_refresh_tokens_account ON refresh_tokens(account_id) WHERE revoked_at IS NULL;

CREATE TABLE otp_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID REFERENCES accounts(id) ON DELETE CASCADE,
  destination   TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  purpose       otp_purpose NOT NULL,
  attempt_count SMALLINT NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_otp_destination ON otp_codes(destination, purpose) WHERE consumed_at IS NULL;

-- =====================================================================
-- USERS (client-facing profile)
-- =====================================================================
CREATE TABLE user_profiles (
  account_id           UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  first_name           TEXT NOT NULL,
  last_name            TEXT,
  avatar_url           TEXT,
  date_of_birth        DATE,
  gender               TEXT,
  preferred_language_id UUID REFERENCES languages(id),
  country_id           UUID REFERENCES countries(id),
  state_id             UUID REFERENCES states(id),
  city_id              UUID REFERENCES cities(id),
  address_line         TEXT,
  postal_code          TEXT,
  kyc_status           kyc_status NOT NULL DEFAULT 'not_started',
  kyc_verified_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);
CREATE TRIGGER trg_user_profiles_updated BEFORE UPDATE ON user_profiles FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

CREATE TABLE wallets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  balance      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  currency     CHAR(3) NOT NULL DEFAULT 'INR',
  version      INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wallet_transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id      UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  type           wallet_txn_type NOT NULL,
  amount         NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  balance_after  NUMERIC(14,2) NOT NULL,
  reference_type TEXT,
  reference_id   UUID,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_wallet_txn_wallet ON wallet_transactions(wallet_id, created_at DESC);

-- =====================================================================
-- LAWYERS
-- =====================================================================
CREATE TABLE lawyer_profiles (
  account_id                UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  first_name                TEXT NOT NULL,
  last_name                 TEXT,
  avatar_url                TEXT,
  bio                       TEXT,
  bar_council_number        TEXT NOT NULL,
  bar_council_state         TEXT,
  verification_status       verification_status NOT NULL DEFAULT 'unverified',
  verified_at               TIMESTAMPTZ,
  verified_by               UUID REFERENCES accounts(id),
  years_experience          SMALLINT NOT NULL DEFAULT 0 CHECK (years_experience >= 0),
  office_address            TEXT,
  country_id                UUID REFERENCES countries(id),
  state_id                  UUID REFERENCES states(id),
  city_id                   UUID REFERENCES cities(id),
  consultation_fee_chat     NUMERIC(10,2) CHECK (consultation_fee_chat >= 0),
  consultation_fee_voice    NUMERIC(10,2) CHECK (consultation_fee_voice >= 0),
  consultation_fee_video    NUMERIC(10,2) CHECK (consultation_fee_video >= 0),
  avg_rating                NUMERIC(3,2) NOT NULL DEFAULT 0,
  total_reviews             INTEGER NOT NULL DEFAULT 0,
  is_featured               BOOLEAN NOT NULL DEFAULT false,
  is_online                 BOOLEAN NOT NULL DEFAULT false,
  last_active_at            TIMESTAMPTZ,
  profile_completion_pct    SMALLINT NOT NULL DEFAULT 0 CHECK (profile_completion_pct BETWEEN 0 AND 100),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ,
  version                   INTEGER NOT NULL DEFAULT 0,
  UNIQUE (bar_council_number)
);
CREATE INDEX idx_lawyer_search ON lawyer_profiles(verification_status, is_online, avg_rating DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_lawyer_city ON lawyer_profiles(city_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_lawyer_featured ON lawyer_profiles(is_featured) WHERE is_featured = true AND deleted_at IS NULL;
CREATE TRIGGER trg_lawyer_profiles_updated BEFORE UPDATE ON lawyer_profiles FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at('version');

CREATE TABLE saved_lawyers (
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lawyer_id   UUID NOT NULL REFERENCES lawyer_profiles(account_id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, lawyer_id)
);

CREATE TABLE practice_areas (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  parent_id  UUID REFERENCES practice_areas(id)
);

CREATE TABLE lawyer_practice_areas (
  lawyer_id         UUID NOT NULL REFERENCES lawyer_profiles(account_id) ON DELETE CASCADE,
  practice_area_id  UUID NOT NULL REFERENCES practice_areas(id) ON DELETE CASCADE,
  PRIMARY KEY (lawyer_id, practice_area_id)
);

CREATE TABLE lawyer_bank_details (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lawyer_id             UUID NOT NULL UNIQUE REFERENCES lawyer_profiles(account_id) ON DELETE CASCADE,
  account_holder_name   TEXT NOT NULL,
  account_number_enc    TEXT NOT NULL,
  ifsc_code             TEXT,
  bank_name             TEXT,
  pan_number_enc        TEXT,
  gst_number            TEXT,
  is_verified           BOOLEAN NOT NULL DEFAULT false,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- CATALOG (documentation services)
-- =====================================================================
CREATE TABLE service_catalog (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  slug               TEXT NOT NULL UNIQUE,
  category           TEXT NOT NULL,
  description        TEXT,
  base_price         NUMERIC(10,2) NOT NULL CHECK (base_price >= 0),
  timeline_days      SMALLINT NOT NULL,
  required_documents JSONB NOT NULL DEFAULT '[]',
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE service_orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number       TEXT NOT NULL UNIQUE,
  account_id         UUID REFERENCES accounts(id), -- Nullable for Guest/Lead
  guest_lead_id      UUID REFERENCES leads(id),       -- For Guests
  service_id         UUID NOT NULL REFERENCES service_catalog(id),
  assigned_lawyer_id UUID REFERENCES lawyer_profiles(account_id),
  status             order_status NOT NULL DEFAULT 'draft',
  price              NUMERIC(10,2) NOT NULL,
  customer_notes     TEXT,
  internal_notes     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  version            INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER trg_service_orders_updated BEFORE UPDATE ON service_orders FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at('version');

-- =====================================================================
-- CONSULTATIONS
-- =====================================================================
CREATE TABLE bookings (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_number     TEXT NOT NULL UNIQUE,
  account_id         UUID NOT NULL REFERENCES accounts(id),
  lawyer_id          UUID NOT NULL REFERENCES lawyer_profiles(account_id),
  type               consult_type NOT NULL,
  scheduled_at       TIMESTAMPTZ NOT NULL,
  duration_minutes   SMALLINT NOT NULL,
  status             booking_status NOT NULL DEFAULT 'requested',
  fee_per_minute     NUMERIC(10,2) NOT NULL,
  total_amount       NUMERIC(10,2),
  cancellation_reason TEXT,
  cancelled_by       UUID REFERENCES accounts(id),
  cancelled_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  version            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_bookings_lawyer_time ON bookings(lawyer_id, scheduled_at);
CREATE TRIGGER trg_bookings_updated BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at('version');

CREATE TABLE sessions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id               UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  started_at               TIMESTAMPTZ,
  ended_at                 TIMESTAMPTZ,
  actual_duration_seconds  INTEGER,
  recording_url            TEXT,
  status                   session_status NOT NULL DEFAULT 'not_started'
);

-- =====================================================================
-- MESSAGING
-- =====================================================================
CREATE TABLE conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          conversation_type NOT NULL,
  reference_id  UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversation_participants (
  conversation_id       UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  joined_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_message_id  UUID,
  PRIMARY KEY (conversation_id, account_id)
);

CREATE TABLE messages (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id       UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id             UUID NOT NULL REFERENCES accounts(id),
  message_type          message_type NOT NULL DEFAULT 'text',
  content               TEXT,
  reply_to_message_id   UUID REFERENCES messages(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- PAYMENTS
-- =====================================================================
CREATE TABLE orders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number   TEXT NOT NULL UNIQUE,
  account_id     UUID REFERENCES accounts(id),
  guest_lead_id  UUID REFERENCES leads(id), 
  order_type     order_type NOT NULL,
  reference_id   UUID,          
  amount         NUMERIC(12,2) NOT NULL,
  currency       CHAR(3) NOT NULL DEFAULT 'INR',
  status         payment_status NOT NULL DEFAULT 'created',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  version        INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at('version');

CREATE TABLE transactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  gateway               gateway NOT NULL,
  gateway_transaction_id TEXT,
  amount                NUMERIC(12,2) NOT NULL,
  status                payment_status NOT NULL,
  payment_method        TEXT,
  paid_at               TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, gateway_transaction_id)
);

CREATE TABLE commissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           UUID NOT NULL REFERENCES orders(id),
  lawyer_id          UUID NOT NULL REFERENCES lawyer_profiles(account_id),
  gross_amount       NUMERIC(12,2) NOT NULL,
  commission_pct     NUMERIC(5,2) NOT NULL,
  commission_amount  NUMERIC(12,2) NOT NULL,
  net_amount         NUMERIC(12,2) NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- REVIEWS & CONTENT
-- =====================================================================
CREATE TABLE reviews (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id),
  target_type    target_type NOT NULL,
  target_id      UUID NOT NULL,
  rating         SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        TEXT,
  is_moderated   BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, target_type, target_id)
);

CREATE TABLE articles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  content           TEXT NOT NULL,
  status            article_status NOT NULL DEFAULT 'draft',
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- ROW LEVEL SECURITY (RLS)
-- Protects data access so clients can only access their own data.
-- =====================================================================

-- Enable RLS across all principal tables
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE lawyer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE lawyer_bank_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- 1. Identity & Profiles
CREATE POLICY "Users can view their own account" ON accounts FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update their own account" ON accounts FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can view their own profile" ON user_profiles FOR SELECT USING (auth.uid() = account_id);
CREATE POLICY "Users can update their own profile" ON user_profiles FOR UPDATE USING (auth.uid() = account_id);

-- 2. Lawyer Profiles (Publicly readable, updated by owner)
CREATE POLICY "Lawyer profiles are publicly readable" ON lawyer_profiles FOR SELECT USING (true);
CREATE POLICY "Lawyers can update own profile" ON lawyer_profiles FOR UPDATE USING (auth.uid() = account_id);

-- 3. Highly Sensitive: Bank Details (Only owner can read/update)
CREATE POLICY "Lawyers can view own bank details" ON lawyer_bank_details FOR SELECT USING (auth.uid() = lawyer_id);
CREATE POLICY "Lawyers can update own bank details" ON lawyer_bank_details FOR UPDATE USING (auth.uid() = lawyer_id);

-- 4. Commerce & Orders
CREATE POLICY "Users can view own service orders" ON service_orders FOR SELECT USING (auth.uid() = account_id OR auth.uid() = assigned_lawyer_id);
CREATE POLICY "Users can view own payments" ON orders FOR SELECT USING (auth.uid() = account_id);

-- 5. Consultations
CREATE POLICY "Users and Lawyers can view their bookings" ON bookings FOR SELECT USING (auth.uid() = account_id OR auth.uid() = lawyer_id);

-- Note: Admin functions, Stripe/Razorpay webhooks, and your Express backend 
-- use the `service_role` key, which automatically bypasses ALL these RLS checks.
-- This ensures unauthenticated sales funnels work flawlessly without custom anonymous RLS hacks.
