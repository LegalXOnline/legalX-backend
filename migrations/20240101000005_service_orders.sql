-- Migration: 20240101000005_service_orders
-- Description: Service catalog + customer orders for document services
-- Depends on: 20240101000003_identity

CREATE TABLE IF NOT EXISTS service_catalog (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  description  TEXT,
  category     TEXT    NOT NULL,
  base_price   NUMERIC(10,2) NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS service_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  service_slug    TEXT NOT NULL,
  lead_id         UUID REFERENCES leads(id),
  application_id  UUID REFERENCES applications(id),
  status          order_status NOT NULL DEFAULT 'draft',
  form_data       JSONB NOT NULL DEFAULT '{}',
  amount_paid     NUMERIC(10,2),
  notes           TEXT,
  version         INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_orders_account  ON service_orders(account_id);
CREATE INDEX IF NOT EXISTS idx_service_orders_status   ON service_orders(status);
CREATE INDEX IF NOT EXISTS idx_service_catalog_slug    ON service_catalog(slug);

CREATE OR REPLACE TRIGGER trg_service_orders_updated_at
  BEFORE UPDATE ON service_orders
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at('version');
