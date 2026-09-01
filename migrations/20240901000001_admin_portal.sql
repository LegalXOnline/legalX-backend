-- Migration: 20240901000001_admin_portal
-- Description:
--   1. disputes            — client/lawyer dispute tickets
--   2. payouts             — lawyer payout cycles with TDS breakdown
--   3. audit_log           — immutable record of every admin mutation
--   4. disciplinary_flags  — complaints, warnings, suspensions, reinstatements
--   5. lawyer_profiles.rejection_reason — column the reject route already writes
--      to but which was never created (that route errors without this)
-- Safe to re-run (idempotent).

-- ── 1. disputes ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disputes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id   UUID REFERENCES consultations(id),
  service_order_id  UUID REFERENCES service_orders(id),
  client_id         UUID NOT NULL REFERENCES accounts(id),
  lawyer_id         UUID REFERENCES lawyer_profiles(account_id),
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','investigating','resolved','escalated')),
  resolution_note   TEXT,
  opened_by         UUID REFERENCES accounts(id),
  resolved_by       UUID REFERENCES accounts(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disputes_status  ON disputes(status);
CREATE INDEX IF NOT EXISTS idx_disputes_lawyer  ON disputes(lawyer_id);
CREATE INDEX IF NOT EXISTS idx_disputes_client  ON disputes(client_id);
CREATE INDEX IF NOT EXISTS idx_disputes_created ON disputes(created_at DESC);

-- ── 2. payouts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payouts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lawyer_id          UUID NOT NULL REFERENCES lawyer_profiles(account_id),
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  gross_amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  tds_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  platform_fee       NUMERIC(12,2) NOT NULL DEFAULT 0,
  net_amount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','processing','paid','held','cancelled')),
  hold_reason        TEXT,
  transaction_count  INT NOT NULL DEFAULT 0,
  bank_ref           TEXT,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One payout row per lawyer per cycle — makes the generate endpoint re-runnable
-- without creating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_lawyer_period
  ON payouts(lawyer_id, period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);

-- ── 3. audit_log ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id     UUID NOT NULL REFERENCES accounts(id),
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  before_data  JSONB,
  after_data   JSONB,
  ip_address   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity  ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin   ON audit_log(admin_id);

-- ── 4. disciplinary_flags ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS disciplinary_flags (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lawyer_id   UUID NOT NULL REFERENCES lawyer_profiles(account_id),
  type        TEXT NOT NULL
                CHECK (type IN ('complaint','warning','suspension','reinstatement')),
  reason      TEXT NOT NULL,
  flagged_by  UUID NOT NULL REFERENCES accounts(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disciplinary_flags_lawyer
  ON disciplinary_flags(lawyer_id, created_at DESC);

-- ── 5. lawyer_profiles.rejection_reason ───────────────────────────────────────
-- PATCH /api/admin/lawyers/:id/reject has always written this column, but it
-- was never added — every rejection fails until this runs.
ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- ── 6. Row Level Security ─────────────────────────────────────────────────────
-- These tables are only ever touched by the backend's service_role key, which
-- bypasses RLS. Enabling it with no permissive policy means that if the anon or
-- authenticated key ever reaches them, it reads nothing rather than everything.
ALTER TABLE disputes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log          ENABLE ROW LEVEL SECURITY;
ALTER TABLE disciplinary_flags ENABLE ROW LEVEL SECURITY;

