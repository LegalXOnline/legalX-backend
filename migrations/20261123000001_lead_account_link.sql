-- Migration: 20261123000001_lead_account_link
-- Description:
--   Links a lead to the account that submitted it, so an application can be
--   checked for ownership. Without this column there was nothing to check
--   against, and GET /api/applications/:id carried no auth at all.
--
--   Nullable on purpose: a visitor becomes a lead before they have an account,
--   so a guest lead has no owner and stays admin-only.
-- Safe to re-run (idempotent).

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_leads_account ON leads(account_id);

COMMENT ON COLUMN leads.account_id IS
  'Account that submitted this lead, when one was signed in. NULL for guest leads, which only an admin may read.';

-- Backfill by email. accounts.email is CITEXT, so the cast matches
-- case-insensitively. Scoped to unowned rows so a re-run cannot reassign.
UPDATE leads AS l
   SET account_id = a.id
  FROM accounts AS a
 WHERE l.account_id IS NULL
   AND l.email IS NOT NULL
   AND l.email <> ''
   AND a.email = l.email::CITEXT;

-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_leads_account;
-- ALTER TABLE leads DROP COLUMN IF EXISTS account_id;
