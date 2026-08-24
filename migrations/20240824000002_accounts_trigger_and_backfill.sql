-- Migration: 20240824000002_accounts_trigger_and_backfill
-- Description:
--   1. Add missing columns to accounts table (first_name, last_name, etc.)
--   2. Relax NOT NULL constraints on lawyer_profiles that block partial/staged inserts
--   3. Add Supabase trigger: auto-insert into public.accounts on auth.users insert
--   4. Backfill existing auth.users into accounts
-- Safe to re-run (idempotent).

-- ── 1. Add missing columns to accounts ───────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'first_name') THEN
    ALTER TABLE public.accounts ADD COLUMN first_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'last_name') THEN
    ALTER TABLE public.accounts ADD COLUMN last_name TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'avatar_url') THEN
    ALTER TABLE public.accounts ADD COLUMN avatar_url TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'preferred_lang') THEN
    ALTER TABLE public.accounts ADD COLUMN preferred_lang TEXT NOT NULL DEFAULT 'en';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'phone') THEN
    ALTER TABLE public.accounts ADD COLUMN phone TEXT UNIQUE;
  END IF;
END $$;

-- ── 2. Relax NOT NULL constraints on lawyer_profiles ─────────────────────────
-- Lawyers fill their profile in stages (4-page onboarding).
-- A row must be insertable with just account_id at signup time.
ALTER TABLE public.lawyer_profiles
  ALTER COLUMN first_name        DROP NOT NULL,
  ALTER COLUMN last_name         DROP NOT NULL,
  ALTER COLUMN bar_council_number DROP NOT NULL;

-- Remove UNIQUE on bar_council_number if it causes issues with NULL values
-- (NULL != NULL in SQL, so multiple NULLs are fine, but let's be explicit)
-- bar_council_number unique constraint is preserved — NULLs are allowed.

-- ── 3. Trigger function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _role  account_role;
  _fname TEXT;
  _lname TEXT;
BEGIN
  _fname := COALESCE((NEW.raw_user_meta_data->>'first_name')::text, split_part(NEW.email, '@', 1));
  _lname := COALESCE((NEW.raw_user_meta_data->>'last_name')::text, '');

  BEGIN
    _role := (NEW.raw_user_meta_data->>'role')::account_role;
  EXCEPTION WHEN invalid_text_representation THEN
    _role := 'client';
  END;
  IF _role IS NULL THEN _role := 'client'; END IF;

  -- Insert into accounts
  INSERT INTO public.accounts (id, email, first_name, last_name, role, status)
  VALUES (NEW.id, NEW.email, _fname, _lname, _role, 'active')
  ON CONFLICT (id) DO NOTHING;

  -- For lawyers: create a minimal lawyer_profiles row so FK references work
  -- first_name/last_name/bar_council_number are now nullable (step 2 above)
  IF _role = 'lawyer' THEN
    INSERT INTO public.lawyer_profiles (account_id)
    VALUES (NEW.id)
    ON CONFLICT (account_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

-- ── 4. Attach trigger to auth.users ──────────────────────────────────────────
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();

-- ── 5. Backfill: existing auth.users → accounts ───────────────────────────────
INSERT INTO public.accounts (id, email, first_name, last_name, role, status)
SELECT
  au.id,
  au.email,
  COALESCE((au.raw_user_meta_data->>'first_name')::text, split_part(au.email, '@', 1)),
  COALESCE((au.raw_user_meta_data->>'last_name')::text,  ''),
  CASE
    WHEN (au.raw_user_meta_data->>'role') = 'lawyer' THEN 'lawyer'::account_role
    WHEN (au.raw_user_meta_data->>'role') = 'admin'  THEN 'admin'::account_role
    ELSE 'client'::account_role
  END,
  'active'
FROM auth.users au
WHERE NOT EXISTS (
  SELECT 1 FROM public.accounts a WHERE a.id = au.id
);

-- ── 6. Backfill: lawyer_profiles for lawyers who don't have a row yet ─────────
-- Now safe because NOT NULL constraints on first_name/last_name/bar_council_number
-- were dropped in step 2.
INSERT INTO public.lawyer_profiles (account_id)
SELECT a.id
FROM public.accounts a
WHERE a.role = 'lawyer'
  AND NOT EXISTS (
    SELECT 1 FROM public.lawyer_profiles lp WHERE lp.account_id = a.id
  );

-- ── 7. Verify ────────────────────────────────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM auth.users)        AS auth_users_total,
  (SELECT COUNT(*) FROM public.accounts)   AS accounts_total,
  (SELECT COUNT(*) FROM public.lawyer_profiles) AS lawyer_profiles_total;
