-- Migration: 20261125000002_lawyer_earnings_and_grant_cap
-- Description:
--   Two money rules the code now enforces, made durable.
--
--   1. What an advocate earns is not what the client paid. A consultation
--      funded by the ₹100 promotional grant earns nothing — that time is given
--      pro bono — and the first five minutes of a paid one are the platform's.
--      Stored per consultation rather than recomputed, so changing the rule
--      later cannot rewrite what someone has already earned.
--
--   2. The grant is ₹100 and only ₹100. Two accounts had been topped up by
--      hand to ₹525 and ₹688, which is real consultation time the platform
--      never agreed to give away. Balances already spent down stay as they are.
-- Safe to re-run (idempotent).

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS lawyer_earnings NUMERIC(10,2);

COMMENT ON COLUMN consultations.lawyer_earnings IS
  'Rupees owed to the advocate for this consultation. Not total_amount: free-grant consultations earn 0, and the first LAWYER_UNPAID_MINUTES of a paid one earn 0. See src/lib/consultation.ts.';

-- Backfill under the current rule. Safe because payouts has never had a row,
-- so nothing has been paid against the old assumption.
UPDATE consultations
   SET lawyer_earnings = CASE
         WHEN payment_status = 'credits' THEN 0
         WHEN duration_seconds IS NULL OR duration_seconds <= 300 THEN 0
         ELSE CEIL(((duration_seconds - 300)::NUMERIC / 60) * COALESCE(fee_per_minute, 0))
       END
 WHERE lawyer_earnings IS NULL
   AND status = 'completed';

-- Cap the promotional grant. LEAST leaves a partly-spent balance alone.
UPDATE accounts
   SET free_credit_paise = LEAST(free_credit_paise, 10000)
 WHERE free_credit_paise > 10000;

-- ROLLBACK:
-- ALTER TABLE consultations DROP COLUMN IF EXISTS lawyer_earnings;
-- The grant cap is not reversible; the prior balances were not a granted entitlement.
