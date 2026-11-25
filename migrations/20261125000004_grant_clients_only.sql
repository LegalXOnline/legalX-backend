-- Migration: 20261125000004_grant_clients_only
-- Description: [DB-06]
--   The Rs 100 consultation grant went to every new account, because the
--   column default applied regardless of role. Advocates and admins were each
--   handed Rs 100 of consultation time they have no use for, and an account
--   deleted and recreated on the same email collected a fresh grant.
--
--   The grant is a client acquisition cost. It now belongs to clients, once.
-- Safe to re-run (idempotent).

-- ── 1. No grant by default; the trigger decides ─────────────────────────────
ALTER TABLE accounts ALTER COLUMN free_credit_paise SET DEFAULT 0;

COMMENT ON COLUMN accounts.free_credit_paise IS
  'Promotional consultation credit in paise. Not money: never refundable or withdrawable. Granted to clients on first signup only — see handle_new_auth_user.';

-- ── 2. Grant it to clients, and only on a genuinely new email ───────────────
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
  _grant INTEGER := 0;
BEGIN
  _fname := COALESCE((NEW.raw_user_meta_data->>'first_name')::text, split_part(NEW.email, '@', 1));
  _lname := COALESCE((NEW.raw_user_meta_data->>'last_name')::text, '');

  BEGIN
    _role := (NEW.raw_user_meta_data->>'role')::account_role;
  EXCEPTION WHEN invalid_text_representation THEN
    _role := 'client';
  END;
  IF _role IS NULL THEN _role := 'client'; END IF;

  -- Clients only, and not to an email that has already had one. Deleting an
  -- account and signing up again was a way to collect the grant repeatedly.
  IF _role = 'client' AND NEW.email IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.deleted_accounts d WHERE lower(d.email) = lower(NEW.email))
  THEN
    _grant := 10000;
  END IF;

  INSERT INTO public.accounts (id, email, first_name, last_name, role, status, free_credit_paise)
  VALUES (NEW.id, NEW.email, _fname, _lname, _role, 'active', _grant)
  ON CONFLICT (id) DO NOTHING;

  IF _role = 'lawyer' THEN
    INSERT INTO public.lawyer_profiles (account_id)
    VALUES (NEW.id)
    ON CONFLICT (account_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. Take back the grants that were never meant to be given ───────────────
-- Advocates and admins do not consult, so nothing of theirs has been spent.
UPDATE accounts
   SET free_credit_paise = 0
 WHERE role IN ('lawyer', 'admin')
   AND free_credit_paise > 0;

-- ROLLBACK:
-- ALTER TABLE accounts ALTER COLUMN free_credit_paise SET DEFAULT 10000;
-- The trigger body would need restoring from 20240824000002.
