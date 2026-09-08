-- Migration: 20260908000004_push_subscriptions
-- Description: Web push subscriptions, so a lawyer is reachable with no tab open.
-- Depends on:  20240101000003_identity
-- Safe to re-run: yes.
--
-- WHY
-- Everything built so far reaches a lawyer only while a page is open: the SSE
-- stream and the poll both need a live tab. A lawyer whose laptop is asleep or
-- whose phone is in a pocket cannot be rung at all, which is most of the time.
--
-- Web push is the only mechanism that survives that, because the browser wakes
-- a service worker with no page in existence. Each row here is one device.
--
-- The endpoint IS the address — it names the push service and the device
-- together, so it is the natural primary key, and it is unique across every
-- account rather than per account: the same browser must never end up
-- subscribed for two people.
--
-- p256dh and auth are the device's own ECDH public key and 16-byte secret,
-- generated in the browser. The server derives a shared secret from them and
-- encrypts each payload with AES-128-GCM, so the push service relays ciphertext
-- it cannot read. They are useless without the VAPID private key, which never
-- leaves the server.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint     TEXT        NOT NULL UNIQUE,
  p256dh       TEXT        NOT NULL,
  auth         TEXT        NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- The send path looks up every device for one account.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_account
  ON push_subscriptions (account_id);

-- Deny by default: no policy is defined, so anon and authenticated see nothing.
-- The API reaches this table as service_role, which bypasses RLS.
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE push_subscriptions IS
  'One row per browser/device. Deleted when the push service answers 404 or 410, which is how it reports a dead subscription.';
