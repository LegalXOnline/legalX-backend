-- Migration: 20240101000000_extensions_and_enums
-- Description: Install required extensions and define all shared ENUM types
-- Run once on a fresh Supabase project before any table migrations.
-- Safe to re-run: all statements are idempotent.

-- ── Extensions ───────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";     -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "citext";       -- case-insensitive email/text
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- fuzzy search / ILIKE indexes
CREATE EXTENSION IF NOT EXISTS "btree_gist";   -- exclusion constraints (availability)

-- ── Shared trigger function ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tg_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  IF TG_ARGV[0] = 'version' THEN
    NEW.version = COALESCE(OLD.version, 0) + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── ENUM types ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE account_role       AS ENUM ('client','lawyer','admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_status     AS ENUM ('active','suspended','banned','pending_deletion');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE oauth_provider     AS ENUM ('google','apple');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE otp_purpose        AS ENUM ('phone_verify','login','password_reset');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE kyc_status         AS ENUM ('not_started','pending','verified','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE wallet_txn_type    AS ENUM ('credit','debit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_channel AS ENUM ('push','email','sms','in_app');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE notification_status AS ENUM ('scheduled','sent','failed','read');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('unverified','pending','verified','rejected','suspended');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE doc_type           AS ENUM ('bar_certificate','id_proof','address_proof','degree_certificate','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payout_status      AS ENUM ('pending','processing','paid','failed','on_hold');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_status       AS ENUM ('draft','pending_payment','in_progress','pending_customer_input','in_review','revision_requested','completed','cancelled','refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE doc_role           AS ENUM ('customer_upload','internal_draft','final_deliverable');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE doc_verify_status  AS ENUM ('pending','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE message_role       AS ENUM ('user','assistant','system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE consult_type       AS ENUM ('chat','voice','video');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE booking_status     AS ENUM ('requested','confirmed','in_progress','completed','cancelled','no_show','refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE session_status     AS ENUM ('not_started','active','ended','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE conversation_type  AS ENUM ('consultation','support','general');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE message_type       AS ENUM ('text','image','pdf','system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE gateway            AS ENUM ('razorpay','stripe');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_type         AS ENUM ('consultation','service','wallet_topup','subscription');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status     AS ENUM ('created','authorized','captured','failed','refunded','partially_refunded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE discount_type      AS ENUM ('flat','percentage');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE settlement_status  AS ENUM ('pending','processing','paid','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE target_type        AS ENUM ('lawyer','service_order','consultation');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE report_status      AS ENUM ('open','actioned','dismissed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE article_status     AS ENUM ('draft','published','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
