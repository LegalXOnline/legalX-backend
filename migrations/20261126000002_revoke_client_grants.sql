-- Migration: 20261126000002_revoke_client_grants
-- Description: [DB-01 follow-up]
--   Takes the table privileges away from anon and authenticated, so row level
--   security is not the only thing holding.
--
--   Measured on the live database: anon still held INSERT, UPDATE, DELETE and
--   TRUNCATE on applications, consultations, leads, messages, payouts,
--   lawyer_profiles and wallet_transactions. Nothing was exploitable — a
--   delete against all five tables changed no rows, because RLS filtered
--   them — but that is one permissive policy away from being very
--   exploitable, and TRUNCATE is not subject to RLS at all.
--
--   Neither client needs any of it. Both use supabase-js for authentication
--   only and read everything through this API on service_role, which bypasses
--   RLS and is unaffected by grants.
--
--   If a client is ever given direct read access to something, grant SELECT on
--   that one table explicitly and write the policy with it. Do not grant back
--   in bulk.
-- Safe to re-run (idempotent).

DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t.tablename);
  END LOOP;
END $$;

-- Sequences too: an INSERT grant is useless without one, and leaving them
-- behind only muddies the next audit.
DO $$
DECLARE s RECORD;
BEGIN
  FOR s IN
    SELECT sequencename FROM pg_sequences WHERE schemaname = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM anon, authenticated', s.sequencename);
  END LOOP;
END $$;

-- And stop the defaults re-granting on the next table that gets created.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- service_role is what the API runs as and must keep everything.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- ROLLBACK:
-- GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
-- Restores Supabase's default posture, where RLS alone protects every table.
