-- Migration: 20260918000001_consultation_join_times
-- Description:
--   Records when each side actually reached the call room, so billing can start
--   when both are present rather than when the first one arrives.
--
--   started_at was stamped the moment the lawyer asked for a token. The client
--   was then billed from that instant while their own join was still in
--   progress — and if it never completed, they were charged for a call that
--   never happened. These two columns are what "both are here" is decided on.
-- Safe to re-run (idempotent).

ALTER TABLE consultations
  ADD COLUMN IF NOT EXISTS lawyer_joined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_joined_at TIMESTAMPTZ;

COMMENT ON COLUMN consultations.lawyer_joined_at IS
  'When the lawyer fetched call credentials. Presence, not billing.';
COMMENT ON COLUMN consultations.client_joined_at IS
  'When the client fetched call credentials. Presence, not billing.';
