-- Migration: 20261126000004_pending_signups
-- Description: [BE-02]
--   Moves the signup OTP out of process memory.
--
--   It lived in a Map, and this service sleeps on the free tier. Someone who
--   requested a code, went to their inbox and came back two minutes later
--   found it rejected as invalid — because the store had gone with the
--   process. Intermittent, invisible in the logs, and it reads to the person
--   signing up as the code simply being wrong.
--
--   No password is stored. The client sends it again on verification and
--   always has, so holding one here would be a secret at rest that nothing
--   reads. What is stored is the name and role the signup was requested
--   with, which verification now pins to instead of trusting the second
--   request to repeat them honestly.
-- Safe to re-run (idempotent).

CREATE TABLE IF NOT EXISTS pending_signups (
  email       CITEXT      PRIMARY KEY,
  otp         TEXT        NOT NULL,
  first_name  TEXT        NOT NULL,
  last_name   TEXT        NOT NULL,
  role        TEXT        NOT NULL CHECK (role IN ('client', 'lawyer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_signups_created ON pending_signups (created_at);

COMMENT ON TABLE pending_signups IS
  'A signup between requesting an OTP and verifying it. Ten-minute life, swept by /api/jobs/retention. Holds no password: the client resends it on verification.';

ALTER TABLE pending_signups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pending_signups FROM anon, authenticated;
GRANT  ALL ON pending_signups TO service_role;

-- ROLLBACK:
-- DROP TABLE IF EXISTS pending_signups;
