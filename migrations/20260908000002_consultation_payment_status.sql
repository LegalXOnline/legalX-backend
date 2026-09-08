-- Migration: 20260908000002_consultation_payment_status
-- Description: Lets consultations record how they were actually funded.
-- Depends on:  20240824000001_lawyer_onboarding, 20260908000001_consultation_credits
-- Safe to re-run: yes.
--
-- consultations.payment_status was constrained to
--   ('unpaid','authorized','test_mode','captured','failed','refunded')
--
-- Two values the code writes are missing from that list:
--
--   'credits' — a consultation funded from free credit. Without it every call
--               placed on credit failed at the insert, which surfaced in the
--               booking widget as "Server error. Please try again in a moment."
--
--   'paid'    — written by the Agora settlement webhook after a successful
--               Razorpay capture, and the value the admin revenue queries
--               filter on. It was never in the constraint either, so a captured
--               consultation would have failed to record the capture — a latent
--               fault that only the credits path made visible.
--
-- 'test_mode' is kept: rows written before the TEST_MODE bypass was removed
-- still carry it, and dropping a value the data uses would fail the migration.

DO $$
DECLARE
  bad INT;
BEGIN
  -- Never silently discard a value already in the table.
  SELECT count(*) INTO bad
  FROM consultations
  WHERE payment_status IS NOT NULL
    AND payment_status NOT IN (
      'unpaid','authorized','test_mode','captured','failed','refunded','credits','paid'
    );

  IF bad > 0 THEN
    RAISE EXCEPTION
      'consultations holds % row(s) with a payment_status outside the new list — widen it before re-running', bad;
  END IF;

  ALTER TABLE consultations DROP CONSTRAINT IF EXISTS consultations_payment_status_check;
  ALTER TABLE consultations
    ADD CONSTRAINT consultations_payment_status_check
    CHECK (payment_status IN (
      'unpaid','authorized','test_mode','captured','failed','refunded','credits','paid'
    ));

  RAISE NOTICE 'consultations.payment_status now accepts credits and paid';
END $$;
