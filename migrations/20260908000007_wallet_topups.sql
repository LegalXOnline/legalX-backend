-- Migration: 20260908000007_wallet_topups
-- Description: Lets a client hold a paid balance, and spend it on consultations.
-- Depends on:  20240101000008_payments_and_wallet, 20260908000001_consultation_credits
-- Safe to re-run: yes.
--
-- WHY
-- A client could only ever consult on the free ₹100 grant. Once it was gone
-- there was nothing to do but wait, because there was no way to put money in.
--
-- Two balances, kept separate on purpose:
--
--   accounts.free_credit_paise  promotional. Not money: never refundable,
--                               never withdrawable, excluded from revenue.
--   wallets.balance             money the client actually paid, in rupees,
--                               which is the unit this table has always used
--                               and the unit the admin portal reads.
--
-- Merging them into one number would lose the distinction the moment anybody
-- asks for a refund, and that question is not optional in India.
--
-- Free credit is spent first. A client should exhaust the grant before their
-- own money, and if they never come back the platform has kept nothing of
-- theirs.

-- ── Credit a wallet after a verified payment ─────────────────────────────────
-- Creates the wallet row on first top-up, moves the balance and writes the
-- ledger entry in one statement, so a concurrent debit cannot read a stale
-- balance between the two.
CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_account_id   UUID,
  p_amount_paise INTEGER,
  p_reference    TEXT DEFAULT NULL,
  p_note         TEXT DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_wallet_id UUID;
  v_rupees    NUMERIC;
  v_after     NUMERIC;
BEGIN
  IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'top-up amount must be positive';
  END IF;

  v_rupees := p_amount_paise::NUMERIC / 100;

  SELECT id INTO v_wallet_id FROM wallets WHERE account_id = p_account_id FOR UPDATE;

  IF v_wallet_id IS NULL THEN
    INSERT INTO wallets (account_id, balance) VALUES (p_account_id, 0)
    RETURNING id INTO v_wallet_id;
  END IF;

  UPDATE wallets
     SET balance = balance + v_rupees,
         updated_at = now()
   WHERE id = v_wallet_id
  RETURNING balance INTO v_after;

  INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, reference_type, reference_id, note)
  VALUES (v_wallet_id, 'credit', v_rupees, v_after, 'topup', p_reference, p_note);

  RETURN v_after;
END $$;


-- ── Spend: free credit first, then the wallet ────────────────────────────────
-- Replaces charge_consultation_credits with the same name and signature, so
-- every existing caller keeps working — the call room, the portal's Mark
-- complete, and Agora's webhook all settle through this one function and must
-- not diverge.
--
-- Still idempotent: a consultation that already carries credits_charged_paise
-- is returned untouched, because Agora retries a delivery until it gets a 2xx
-- and a redelivered "call ended" must not bill twice.
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
  v_client     UUID;
  v_held       INTEGER;
  v_charged    INTEGER;
  v_amount     INTEGER;
  v_free       INTEGER;
  v_from_free  INTEGER;
  v_remaining  INTEGER;
  v_wallet_id  UUID;
  v_bal_paise  INTEGER;
  v_from_wall  INTEGER;
  v_after      NUMERIC;
BEGIN
  SELECT client_id, credits_held_paise, credits_charged_paise
    INTO v_client, v_held, v_charged
    FROM consultations
   WHERE id = p_consultation_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'consultation % not found', p_consultation_id;
  END IF;

  IF v_charged IS NOT NULL THEN
    RETURN v_charged;                       -- already settled
  END IF;

  IF v_held IS NULL THEN
    RETURN 0;                               -- not funded from balance
  END IF;

  v_amount := LEAST(GREATEST(COALESCE(p_amount_paise, 0), 0), v_held);

  -- Free credit first.
  SELECT free_credit_paise INTO v_free FROM accounts WHERE id = v_client FOR UPDATE;
  v_from_free := LEAST(v_amount, COALESCE(v_free, 0));

  IF v_from_free > 0 THEN
    UPDATE accounts SET free_credit_paise = free_credit_paise - v_from_free WHERE id = v_client;
  END IF;

  -- Then whatever they paid for.
  v_remaining := v_amount - v_from_free;
  v_from_wall := 0;

  IF v_remaining > 0 THEN
    SELECT id, ROUND(balance * 100)::INTEGER
      INTO v_wallet_id, v_bal_paise
      FROM wallets WHERE account_id = v_client FOR UPDATE;

    IF v_wallet_id IS NOT NULL AND COALESCE(v_bal_paise, 0) > 0 THEN
      v_from_wall := LEAST(v_remaining, v_bal_paise);

      UPDATE wallets
         SET balance = balance - (v_from_wall::NUMERIC / 100),
             updated_at = now()
       WHERE id = v_wallet_id
      RETURNING balance INTO v_after;

      INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, reference_type, reference_id, note)
      VALUES (v_wallet_id, 'debit', v_from_wall::NUMERIC / 100, v_after,
              'consultation', p_consultation_id::TEXT, 'Consultation charge');
    END IF;
  END IF;

  -- Recorded as what was actually taken, from both sources. A figure larger
  -- than the debit would never reconcile against the ledger.
  UPDATE consultations
     SET credits_charged_paise = v_from_free + v_from_wall
   WHERE id = p_consultation_id;

  RETURN v_from_free + v_from_wall;
END $$;

DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.credit_wallet(UUID, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.credit_wallet(UUID, INTEGER, TEXT, TEXT) TO service_role;
  REVOKE ALL ON FUNCTION public.charge_consultation_credits(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.charge_consultation_credits(UUID, INTEGER) TO service_role;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'anon/authenticated/service_role not present — grants left at defaults';
END $$;
