-- Migration: 20240824000001_lawyer_onboarding
-- Description: Adds full lawyer onboarding fields to lawyer_profiles,
--              extends doc_type enum, adds consultation_notifications table,
--              and adds govtid_type + availability columns.
-- Depends on:  20240101000000_extensions_and_enums
--              20240101000004_lawyer_profiles
--              20240101000006_consultations
-- Safe to re-run: all statements use IF NOT EXISTS / EXCEPTION guards.
--
-- ROLLBACK (manual):
--   ALTER TABLE lawyer_profiles DROP COLUMN IF EXISTS onboarding_complete;
--   ALTER TABLE lawyer_profiles DROP COLUMN IF EXISTS bar_council_state;
--   ... (full list at bottom of file)
--   DROP TABLE IF EXISTS consultation_notifications;

-- ── 0. Extend ENUMs (idempotent guard) ───────────────────────────────────────
-- Add 'govtid_proof' to doc_type enum (PAN, Aadhaar, Passport uploads)
DO $$ BEGIN
  ALTER TYPE doc_type ADD VALUE IF NOT EXISTS 'govtid_proof';
EXCEPTION WHEN others THEN NULL; END $$;

-- Add 'pending_verification' to verification_status so it matches
-- the app's 3-state flow: unverified → pending_verification → verified/rejected
DO $$ BEGIN
  ALTER TYPE verification_status ADD VALUE IF NOT EXISTS 'pending_signup';
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE verification_status ADD VALUE IF NOT EXISTS 'pending_verification';
EXCEPTION WHEN others THEN NULL; END $$;


-- ── 1. lawyer_profiles — onboarding gate ─────────────────────────────────────
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT false;

-- ── 2. lawyer_profiles — Bar Council credentials (Page 1) ────────────────────
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS bar_council_state    TEXT;

-- bar_council_number already exists (NOT NULL UNIQUE in original schema).
-- enrolment_year: backend uses this name; enrollment_year already exists (alias).
-- We add the new spelling as an alias column for the backend.
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS enrolment_year       SMALLINT;

-- Profile photo stored in Supabase Storage; path stored here
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS profile_photo_url    TEXT;

-- Government ID type — PAN | AADHAAR | PASSPORT
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS govt_id_type         TEXT
  CHECK (govt_id_type IN ('PAN', 'AADHAAR', 'PASSPORT'));

-- ── 3. lawyer_profiles — Professional Profile (Page 2) ───────────────────────
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS firm_name            TEXT;

ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS linkedin_url         TEXT;

ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS website_url          TEXT;

ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS courts_practiced     TEXT[]  DEFAULT '{}';

-- ── 4. lawyer_profiles — Services & Pricing (Page 3) ────────────────────────
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS consultation_types   TEXT[]  DEFAULT '{chat,voice,video}';

ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS document_services    TEXT[]  DEFAULT '{}';

-- Availability slots: { "mon": ["morning","evening"], "tue": [] ... }
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS availability_slots   JSONB   DEFAULT '{}';

-- last_seen_at for online presence tracking
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS last_seen_at         TIMESTAMPTZ;

-- ── 5. lawyer_profiles — Payout Details (Page 4) ────────────────────────────
-- Payout is stored in lawyer_bank_details table (already exists in migration 004).
-- Add UPI as an alternative to bank transfer:
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS upi_id               TEXT;

-- GST & PAN for tax invoicing (PAN may already be in lawyer_documents, keep here for quick access)
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS pan_number           TEXT;

ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS gst_number           TEXT;

-- ── 6. lawyer_profiles — Trust Signals (Page 4) ──────────────────────────────
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS notable_achievements TEXT;

ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS certifications       TEXT;


-- ── 7. lawyer_documents — ensure all required doc_type values can be stored ───
-- The lawyer_documents table (from migration 004) uses the doc_type enum.
-- New valid values: 'govtid_proof' (added above).
-- Existing: bar_certificate, id_proof, address_proof, degree_certificate, other
-- No structural change needed — enum extended above.


-- ── 8. consultation_notifications — real-time incoming call alerts ────────────
-- Used by Supabase Realtime to push incoming consultation alerts to lawyers.
CREATE TABLE IF NOT EXISTS consultation_notifications (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id  UUID        NOT NULL
                   REFERENCES  consultations(id) ON DELETE CASCADE,
  lawyer_id        UUID        NOT NULL
                   REFERENCES  lawyer_profiles(account_id) ON DELETE CASCADE,
  client_id        UUID        NOT NULL
                   REFERENCES  accounts(id) ON DELETE CASCADE,
  type             consult_type NOT NULL,              -- chat | voice | video
  expires_at       TIMESTAMPTZ NOT NULL,               -- notification window (~20 s)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consult_notifs_lawyer
  ON consultation_notifications(lawyer_id);

CREATE INDEX IF NOT EXISTS idx_consult_notifs_expires
  ON consultation_notifications(expires_at);

-- RLS: lawyers can only read their own notifications
ALTER TABLE consultation_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS consult_notifs_lawyer_read ON consultation_notifications;
CREATE POLICY consult_notifs_lawyer_read ON consultation_notifications
  FOR SELECT
  USING (auth.uid() = lawyer_id);

-- Service role (backend) bypasses RLS — inserts are backend-only


-- ── 9. consultations — add columns used by current backend ───────────────────
-- The original consultations table (migration 006) may be missing these columns
-- if it was designed before the Agora / HMS integration.

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS hms_room_id          TEXT;          -- Agora channel name

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS hms_session_id       TEXT;          -- duplicate for webhook matching

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS payment_status       TEXT
    NOT NULL DEFAULT 'unpaid'
    CHECK (payment_status IN ('unpaid','authorized','test_mode','captured','failed','refunded'));

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS razorpay_order_id    TEXT;

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS razorpay_payment_id  TEXT;

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS fee_per_minute       NUMERIC(10,2);

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS duration_seconds     INTEGER;

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS total_amount         NUMERIC(10,2);

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS started_at           TIMESTAMPTZ;

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS ended_at             TIMESTAMPTZ;

-- Index for Agora webhook channel lookup
CREATE INDEX IF NOT EXISTS idx_consultations_channel
  ON consultations(hms_room_id);


-- ── 10. New index: lawyer_profiles onboarding gate ───────────────────────────
CREATE INDEX IF NOT EXISTS idx_lawyer_profiles_onboarding
  ON lawyer_profiles(account_id) WHERE onboarding_complete = false;


-- ── Verification ─────────────────────────────────────────────────────────────
-- Run this query after migration to confirm:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'lawyer_profiles' ORDER BY ordinal_position;

-- ── ROLLBACK section (manual, run if you need to revert) ─────────────────────
-- ALTER TABLE lawyer_profiles
--   DROP COLUMN IF EXISTS onboarding_complete,
--   DROP COLUMN IF EXISTS bar_council_state,
--   DROP COLUMN IF EXISTS enrolment_year,
--   DROP COLUMN IF EXISTS profile_photo_url,
--   DROP COLUMN IF EXISTS govt_id_type,
--   DROP COLUMN IF EXISTS firm_name,
--   DROP COLUMN IF EXISTS linkedin_url,
--   DROP COLUMN IF EXISTS website_url,
--   DROP COLUMN IF EXISTS courts_practiced,
--   DROP COLUMN IF EXISTS consultation_types,
--   DROP COLUMN IF EXISTS document_services,
--   DROP COLUMN IF EXISTS availability_slots,
--   DROP COLUMN IF EXISTS last_seen_at,
--   DROP COLUMN IF EXISTS upi_id,
--   DROP COLUMN IF EXISTS pan_number,
--   DROP COLUMN IF EXISTS gst_number,
--   DROP COLUMN IF EXISTS notable_achievements,
--   DROP COLUMN IF EXISTS certifications;
-- DROP TABLE IF EXISTS consultation_notifications;

-- ── Patch: columns confirmed missing from schema cache (added 2026-08-31) ────
-- Run these if the above were not applied or schema cache was stale:
ALTER TABLE lawyer_profiles ADD COLUMN IF NOT EXISTS email               TEXT;
ALTER TABLE lawyer_profiles ADD COLUMN IF NOT EXISTS phone               TEXT;
ALTER TABLE lawyer_profiles ADD COLUMN IF NOT EXISTS languages            TEXT[] DEFAULT '{English}';
ALTER TABLE lawyer_profiles ADD COLUMN IF NOT EXISTS specializations      TEXT[] DEFAULT '{}';
ALTER TABLE lawyer_profiles ADD COLUMN IF NOT EXISTS primary_specialization TEXT;
