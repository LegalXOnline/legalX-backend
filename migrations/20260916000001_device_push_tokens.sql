-- Migration: 20260916000001_device_push_tokens
-- Description: Native push tokens, so the app is reachable the way the web is.
-- Depends on:  20240101000003_identity, 20260908000004_push_subscriptions
-- Safe to re-run: yes.
--
-- WHY
-- push_subscriptions holds Web Push endpoints: a URL plus two encryption keys,
-- delivered through the browser's push service. None of that exists on a phone.
-- Android goes through FCM and iOS through APNs, and what the device hands the
-- app is a single opaque token.
--
-- The two cannot share a table without one of them carrying three empty
-- columns, so they sit side by side and the send path fans out to both. A
-- lawyer with a laptop and a phone is reachable on either.

CREATE TABLE IF NOT EXISTS device_push_tokens (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The Expo push token. Unique because reinstalling issues a new one and the
  -- old row must not linger and double-send.
  token        TEXT        NOT NULL UNIQUE,
  platform     TEXT        NOT NULL CHECK (platform IN ('ios', 'android')),
  device_name  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_account
  ON device_push_tokens (account_id);

-- Deny by default, like push_subscriptions. The API reaches this as
-- service_role, which bypasses RLS.
ALTER TABLE device_push_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE device_push_tokens IS
  'One row per installed app. Deleted when Expo reports DeviceNotRegistered, which is how it says the token is dead.';
