-- Migration: 20261126000001_lock_down_client_table_access
-- Description: [DB-01, DB-02, DB-03, SEC-18]
--   No browser or phone talks to a table directly. Both clients use
--   supabase-js for authentication only and fetch everything else from this
--   API, which holds the service_role key and bypasses RLS. So the correct
--   policy set for client-facing roles is: none.
--
--   Most tables are already in exactly that state — anon reads nothing from
--   22 of the 24 sensitive ones. These are the leftovers, and two of them
--   matter:
--
--   lawyer_profiles_public_read exposed the whole row, all 55 columns, for
--   every verified advocate to anyone holding the publishable key — and that
--   key ships inside the Android APK. pan_number, gst_number, upi_id, phone
--   and office_address were all readable. Two advocates already have those
--   fields filled in.
--
--   accounts_self_update and lawyer_profiles_self_update had no column
--   restriction, so a signed-in user could write their own row: role to
--   'admin', free_credit_paise to anything, verification_status to 'verified',
--   avg_rating to 5. wallets_self had no FOR clause at all, which covers
--   UPDATE as well as SELECT.
--
--   Dropping them costs nothing: every one of these paths is already served by
--   an authenticated, authorised endpoint.
-- Safe to re-run (idempotent).

-- ── 1. RLS on, so the absence of a policy actually denies ───────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'accounts','lawyer_profiles','wallets','wallet_transactions','leads',
    'applications','orders','transactions','commissions','payouts',
    'consultations','conversations','messages','conversation_participants',
    'reviews','saved_lawyers','notifications','audit_log','disputes',
    'disciplinary_flags','deleted_accounts','push_subscriptions',
    'device_push_tokens','lawyer_bank_details','service_orders','user_profiles'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=t) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- ── 2. Remove direct client access ──────────────────────────────────────────
-- Reading: the directory is served by GET /api/lawyers, which returns the
-- fourteen columns a card needs and never the KYC ones.
DROP POLICY IF EXISTS lawyer_profiles_public_read ON lawyer_profiles;

-- Writing: PATCH /api/lawyers/settings and /api/profile own these, and they
-- decide which columns a user may change. A blanket self-update does not.
DROP POLICY IF EXISTS lawyer_profiles_self_update ON lawyer_profiles;
DROP POLICY IF EXISTS accounts_self_update        ON accounts;
DROP POLICY IF EXISTS accounts_self_read          ON accounts;

-- No FOR clause meant every command, including UPDATE. The balance is written
-- only by credit_wallet and charge_consultation_credits, both SECURITY DEFINER.
DROP POLICY IF EXISTS wallets_self             ON wallets;
DROP POLICY IF EXISTS wallet_transactions_self ON wallet_transactions;

-- ── 3. The admin policies go too ────────────────────────────────────────────
-- They query accounts from inside a policy on accounts, which recurses (DB-04),
-- and the admin portal reads through /api/admin on service_role regardless.
DROP POLICY IF EXISTS accounts_admin_all        ON accounts;
DROP POLICY IF EXISTS lawyer_profiles_admin_all ON lawyer_profiles;
DROP POLICY IF EXISTS bookings_admin_all        ON bookings;

-- ── 4. Belt and braces on the worst table ───────────────────────────────────
-- If a policy is ever added back by accident, the missing grant still stops
-- anon reading KYC columns.
REVOKE SELECT ON public.lawyer_profiles FROM anon;
REVOKE ALL    ON public.accounts        FROM anon;
REVOKE ALL    ON public.wallets         FROM anon, authenticated;

COMMENT ON TABLE lawyer_profiles IS
  'Client-facing reads go through GET /api/lawyers, which selects only directory columns. Direct anon access is revoked: this table holds pan_number, gst_number and upi_id.';

-- ROLLBACK:
-- The dropped policies are reproduced in 20240101000003 and 20240101000004,
-- but restoring them reopens the KYC exposure. Do not.
