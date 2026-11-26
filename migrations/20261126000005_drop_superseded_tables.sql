-- Migration: 20261126000005_drop_superseded_tables
-- Description: [DB-09]
--   Removes thirteen tables that are empty, referenced by no code, and
--   superseded by something that is.
--
--   Dead schema is not neutral. The cost is not storage — it is that the next
--   person reading this database cannot tell which of two tables is
--   authoritative, and eventually joins the wrong one and gets nothing back.
--   That has already happened here: bookings and consultations model the same
--   appointment, and sessions is named as though it belonged to auth while
--   actually hanging off the dead booking flow.
--
--   Each was checked three ways before being listed: zero rows in production,
--   no .from() in src/, and no textual reference anywhere outside comments.
--
--   A second authentication stack. Supabase Auth does all of it, and these
--   have never held a row:
--     otp_codes, oauth_identities, user_profiles
--
--   The superseded appointment flow. consultations is the one with 69 rows
--   and the one every route uses:
--     bookings, sessions
--
--   Normalised lookups that were never populated, while lawyer_profiles
--   stores the same facts as text and arrays — which is what the code reads:
--     countries, states, cities, languages, practice_areas,
--     lawyer_practice_areas
--
--   Superseded by columns on another table. Attachments live on messages
--   (attachment_url, attachment_name, attachment_size); advocate KYC files
--   live in the legalx-lawyer-docs storage bucket, not a table:
--     message_attachments, lawyer_documents
--
--   Never read or written at all:
--     commissions
--
--   Deliberately NOT dropped, though they are also empty: orders,
--   transactions, payments, payouts, wallets, wallet_transactions,
--   service_catalog, service_orders, disputes, articles, lawyer_bank_details.
--   Every one of those is queried by live code and is waiting on a feature
--   rather than left over from one. knowledge_raw_documents stays too: 499
--   rows of provenance behind the published cards, linked by foreign key.
-- Safe to re-run (idempotent).

-- ── 1. Columns on tables we are keeping ─────────────────────────────────────
-- These point at tables about to go. city_id is null on every row and nothing
-- reads it; lawyer_profiles.city (text) is what the directory returns.
ALTER TABLE accounts        DROP COLUMN IF EXISTS city_id;
ALTER TABLE lawyer_profiles DROP COLUMN IF EXISTS city_id;
ALTER TABLE conversations   DROP COLUMN IF EXISTS booking_id;
ALTER TABLE reviews         DROP COLUMN IF EXISTS booking_id;

-- The hand-rolled auth that Supabase Auth replaced.
ALTER TABLE accounts DROP COLUMN IF EXISTS password_hash;

-- ── 2. The tables, in dependency order ──────────────────────────────────────
-- Children first, so no drop needs CASCADE to force its way through a
-- reference we have not accounted for. A CASCADE here could silently take a
-- column off a table we meant to keep.
DROP TABLE IF EXISTS lawyer_practice_areas;
DROP TABLE IF EXISTS practice_areas;

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS bookings;

DROP TABLE IF EXISTS cities;
DROP TABLE IF EXISTS states;
DROP TABLE IF EXISTS countries;
DROP TABLE IF EXISTS languages;

DROP TABLE IF EXISTS message_attachments;
DROP TABLE IF EXISTS lawyer_documents;
DROP TABLE IF EXISTS commissions;

DROP TABLE IF EXISTS oauth_identities;
DROP TABLE IF EXISTS otp_codes;
DROP TABLE IF EXISTS user_profiles;

-- ROLLBACK:
-- Not reversible. The definitions are in migrations 20240101000002 through
-- 20240101000009, but every one of these tables was empty, so there is no
-- data to restore — only the shape, and the shape is what was wrong.
