-- Migration: 20240101000001_sales_funnel
-- Description: Lead capture + guest application tables (top-of-funnel, no auth required)
-- Depends on: 20240101000000_extensions_and_enums

CREATE TABLE IF NOT EXISTS leads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  email           TEXT,
  service_slug    TEXT NOT NULL,
  service_title   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','contacted','converted','dropped')),
  source          TEXT NOT NULL DEFAULT 'apply-online',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS applications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  service_slug    TEXT NOT NULL,
  form_data       JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted','processing','completed','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id       UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  lead_id              UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  razorpay_order_id    TEXT UNIQUE,
  razorpay_payment_id  TEXT,
  razorpay_signature   TEXT,
  amount               INTEGER NOT NULL,        -- paise
  currency             TEXT NOT NULL DEFAULT 'INR',
  status               TEXT NOT NULL DEFAULT 'created'
                       CHECK (status IN ('created','paid','failed','refunded')),
  service_slug         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_leads_phone        ON leads(phone);
CREATE INDEX IF NOT EXISTS idx_leads_status       ON leads(status);
CREATE INDEX IF NOT EXISTS idx_applications_lead  ON applications(lead_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id  ON payments(razorpay_order_id);

-- Updated-at triggers
CREATE OR REPLACE TRIGGER trg_leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

CREATE OR REPLACE TRIGGER trg_applications_updated_at
  BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

CREATE OR REPLACE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
