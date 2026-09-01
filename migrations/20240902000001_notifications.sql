-- Migration: 20240902000001_notifications
-- Description:
--   General-purpose in-app notifications for clients, lawyers and admins.
--   Distinct from `consultation_notifications`, which is a short-lived
--   ring-signal for incoming calls and expires after ~20 seconds.
-- Safe to re-run (idempotent).

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'info',
  is_read     BOOLEAN NOT NULL DEFAULT false,
  link        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The bell queries "my newest notifications" and "my unread count" on every
-- page load; both are served by this one index.
CREATE INDEX IF NOT EXISTS idx_notifications_account_created
  ON notifications(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(account_id) WHERE is_read = false;

-- Only the backend's service_role touches this table, and it bypasses RLS.
-- Enabling RLS with no permissive policy means that if the anon or
-- authenticated key ever reaches it, it reads nothing rather than everything.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Realtime is consumed server-side by the SSE stream in routes/notifications.ts,
-- which relays events to the browser over an authenticated cookie connection.
-- Postgres only emits change payloads for tables in this publication.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
EXCEPTION
  -- Fresh projects may not have the publication yet; the SSE stream falls back
  -- to polling in that case, so this must not abort the migration.
  WHEN undefined_object THEN NULL;
END $$;
