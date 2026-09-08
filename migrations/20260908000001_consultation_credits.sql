-- Migration: 20260908000001_consultation_credits
-- Description: Free consultation credits, so a call can be placed without a
--              payment gateway in the path.
-- Depends on:  20240101000003_identity, 20240101000006_consultations
-- Safe to re-run: yes.
--
-- WHY
-- Until now a consultation could only start after a Razorpay pre-authorisation
-- cleared, and the only way to test the call flow was TEST_MODE in the booking
-- widget faking a payment id. That put a live-payments switch in the middle of
-- the feature being developed, and made every call test depend on a gateway.
--
-- Every client now carries a free credit balance. A call funded from it needs
-- no gateway at all: the balance is checked before the call and debited by the
-- real duration afterwards.
--
-- Credits are not money. They are never refundable, never withdrawable, and
-- deliberately excluded from revenue: a consultation funded this way is marked
-- payment_status = 'credits', which the admin revenue queries (payment_status
-- = 'paid') do not count.

-- ── Client credit balance ────────────────────────────────────────────────────
-- Paise, matching every other amount in the schema. 10000 = ₹100.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS free_credit_paise INTEGER NOT NULL DEFAULT 10000;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_free_credit_paise_non_negative;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_free_credit_paise_non_negative
  CHECK (free_credit_paise >= 0);

-- Existing clients get the same grant as a new signup. Lawyers and admins do
-- not consult anyone, so they are left at whatever the default set.
UPDATE accounts
   SET free_credit_paise = 10000
 WHERE role = 'client'
   AND free_credit_paise = 0;

-- ── What a consultation actually consumed ────────────────────────────────────
-- Written when the call ends, from the measured duration. Null means the call
-- was not funded from credits, or has not ended yet.
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS credits_charged_paise INTEGER;

-- The ceiling authorised before the call started. The debit is capped at this,
-- so a webhook arriving late — or twice — can never take more than the client
-- agreed to when they placed the call.
ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS credits_held_paise INTEGER;

COMMENT ON COLUMN accounts.free_credit_paise IS
  'Promotional consultation credit in paise. Not money: never refundable or withdrawable.';
COMMENT ON COLUMN consultations.credits_held_paise IS
  'Credit ceiling authorised at initiate. The debit at end is capped at this.';
COMMENT ON COLUMN consultations.credits_charged_paise IS
  'Credit actually consumed, from the measured duration. Null until the call ends.';


-- ── Debit, atomically ────────────────────────────────────────────────────────
-- A read-then-write from the API would let two calls ending at once each read
-- the same balance and both subtract from it. This does the arithmetic in one
-- statement, and GREATEST keeps the balance from going negative if a duration
-- is somehow larger than the hold.
--
-- Idempotent by design: it refuses to charge a consultation that already has
-- credits_charged_paise set, because Agora retries webhook deliveries until it
-- gets a 2xx and a retried "call ended" must not bill twice.
CREATE OR REPLACE FUNCTION public.charge_consultation_credits(
  p_consultation_id UUID,
  p_amount_paise    INTEGER
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_client   UUID;
  v_held     INTEGER;
  v_charged  INTEGER;
  v_amount   INTEGER;
  v_balance  INTEGER;
BEGIN
  SELECT client_id, credits_held_paise, credits_charged_paise
    INTO v_client, v_held, v_charged
    FROM consultations
   WHERE id = p_consultation_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'consultation % not found', p_consultation_id;
  END IF;

  -- Already settled. Return what was taken rather than taking it again.
  IF v_charged IS NOT NULL THEN
    RETURN v_charged;
  END IF;

  -- Not a credit-funded call.
  IF v_held IS NULL THEN
    RETURN 0;
  END IF;

  v_amount := LEAST(GREATEST(COALESCE(p_amount_paise, 0), 0), v_held);

  -- Clamp to what the client actually holds as well, so the figure recorded on
  -- the consultation is the debit that really happened. Taking the balance to
  -- zero while writing a larger number would put a charge in the ledger that
  -- was never made, and the two would never reconcile.
  SELECT free_credit_paise INTO v_balance
    FROM accounts WHERE id = v_client FOR UPDATE;

  v_amount := LEAST(v_amount, COALESCE(v_balance, 0));

  UPDATE accounts
     SET free_credit_paise = free_credit_paise - v_amount
   WHERE id = v_client;

  UPDATE consultations
     SET credits_charged_paise = v_amount
   WHERE id = p_consultation_id;

  RETURN v_amount;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.charge_consultation_credits(UUID, INTEGER) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.charge_consultation_credits(UUID, INTEGER) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.charge_consultation_credits(UUID, INTEGER) TO service_role;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'anon/authenticated/service_role not present — grants left at defaults';
END $$;
