-- Read-only RLS audit. Paste into the Supabase SQL editor.
-- Changes nothing; run it before and after 20261126000001 to see the effect.

-- ── 1. Tables with RLS off, or on with no policy ────────────────────────────
-- 'RLS OFF' is the dangerous one: anon can read the table.
-- 'on, no policies' is safe — it denies everything to anon and authenticated.
SELECT
  t.tablename,
  CASE WHEN t.rowsecurity THEN 'on' ELSE 'RLS OFF — anon can read this' END AS rls,
  COUNT(p.policyname)                                                       AS policies,
  COALESCE(string_agg(p.policyname || ' [' || p.cmd || ']', ', '), '—')     AS policy_list
FROM pg_tables t
LEFT JOIN pg_policies p
       ON p.schemaname = t.schemaname AND p.tablename = t.tablename
WHERE t.schemaname = 'public'
GROUP BY t.tablename, t.rowsecurity
ORDER BY t.rowsecurity ASC, COUNT(p.policyname) DESC, t.tablename;

-- ── 2. Policies that let a client write their own row ───────────────────────
-- A policy with no column restriction lets the user set every column in it,
-- including role, verification_status, avg_rating and free_credit_paise.
SELECT tablename, policyname, cmd, roles, qual AS using_expr, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND cmd IN ('ALL', 'UPDATE', 'INSERT')
ORDER BY tablename, policyname;

-- ── 3. What anon and authenticated are granted at table level ───────────────
-- RLS only filters rows on tables the role can reach at all. A revoked grant
-- is a second lock.
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type) AS privileges
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
  AND table_name IN ('accounts','lawyer_profiles','wallets','wallet_transactions',
                     'payments','payouts','consultations','messages','leads','applications')
GROUP BY table_name, grantee
ORDER BY table_name, grantee;
