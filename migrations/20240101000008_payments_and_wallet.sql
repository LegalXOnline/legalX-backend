-- Migration: 20240101000008_payments_and_wallet
-- Description: Wallet, wallet transactions, payment orders, and transactions
-- Depends on: 20240101000003, 20240101000005, 20240101000006

CREATE TABLE IF NOT EXISTS wallets (
  account_id  UUID    PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  balance     NUMERIC(12,2) NOT NULL DEFAULT 0.00,
  currency    TEXT    NOT NULL DEFAULT 'INR',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID    NOT NULL REFERENCES accounts(id),
  txn_type     wallet_txn_type NOT NULL,
  amount       NUMERIC(10,2) NOT NULL,
  balance_after NUMERIC(12,2) NOT NULL,
  description  TEXT,
  ref_id       UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  order_type      order_type NOT NULL,
  ref_id          UUID,       -- booking_id, service_order_id, etc.
  amount          NUMERIC(10,2) NOT NULL,
  gateway         gateway NOT NULL DEFAULT 'razorpay',
  gateway_order_id TEXT UNIQUE,
  status          payment_status NOT NULL DEFAULT 'created',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            UUID NOT NULL REFERENCES orders(id),
  gateway_payment_id  TEXT UNIQUE,
  gateway_signature   TEXT,
  amount              NUMERIC(10,2) NOT NULL,
  status              payment_status NOT NULL DEFAULT 'created',
  error_code          TEXT,
  error_desc          TEXT,
  captured_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  lawyer_id       UUID NOT NULL REFERENCES lawyer_profiles(account_id),
  gross_amount    NUMERIC(10,2) NOT NULL,
  platform_fee    NUMERIC(10,2) NOT NULL,
  net_amount      NUMERIC(10,2) NOT NULL,
  payout_status   payout_status NOT NULL DEFAULT 'pending',
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_account   ON orders(account_id);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
CREATE INDEX IF NOT EXISTS idx_wallet_txn       ON wallet_transactions(account_id, created_at);

CREATE OR REPLACE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- RLS
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallets_self ON wallets;
CREATE POLICY wallets_self ON wallets USING (auth.uid() = account_id);
