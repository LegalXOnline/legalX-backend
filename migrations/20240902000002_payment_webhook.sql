-- Migration: 20240902000002_payment_webhook
-- Description:
--   Makes Razorpay webhook deliveries linkable back to our own records.
--
--   A webhook only tells us Razorpay's order id. `orders` had no column to
--   match that against, so a captured payment could not be tied to the order
--   that produced it — the money arrives and nothing updates.
-- Safe to re-run (idempotent).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS gateway_order_id TEXT;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- One local order per gateway order. Also the lookup path for every webhook
-- delivery, so it needs the index regardless of the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_gateway_order_id
  ON orders(gateway_order_id) WHERE gateway_order_id IS NOT NULL;

-- The idempotency guard: Razorpay retries until it receives a 2xx, so the same
-- payment can arrive many times. A unique gateway_transaction_id makes a repeat
-- insert fail rather than double-crediting a wallet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_gateway_txn_id
  ON transactions(gateway_transaction_id) WHERE gateway_transaction_id IS NOT NULL;
