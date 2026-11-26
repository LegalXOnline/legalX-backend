-- Migration: 20261126000003_client_account_tables
-- Description:
--   Tables behind the client's own account area. The Android screens for
--   saved articles and support have been built and shipping as permanent
--   empty states because nothing existed to read.
--
--   saved_lawyers already exists and is reused as-is. Orders need no table:
--   a client's history is a view across applications, consultations and
--   wallet top-ups, which are each already recorded.
-- Safe to re-run (idempotent).

-- ── Saved articles ──────────────────────────────────────────────────────────
-- The Knowledge Centre has two kinds of content, cards and shorts, each keyed
-- by slug. One table with a kind column rather than two near-identical ones.
CREATE TABLE IF NOT EXISTS saved_articles (
  account_id  UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL CHECK (kind IN ('knowledge', 'short')),
  slug        TEXT        NOT NULL,
  saved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, kind, slug)
);

CREATE INDEX IF NOT EXISTS idx_saved_articles_account
  ON saved_articles (account_id, saved_at DESC);

COMMENT ON TABLE saved_articles IS
  'A client bookmarking a Knowledge Centre card or short. Keyed by slug, not id: slugs are what the clients route on, and a re-ingested card keeps its slug.';

-- ── Support tickets ─────────────────────────────────────────────────────────
-- Separate from `disputes`, which is about one consultation or order going
-- wrong and is an admin moderation record. A support ticket is a conversation
-- a client opens about anything.
CREATE TABLE IF NOT EXISTS support_tickets (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category     TEXT        NOT NULL
               CHECK (category IN ('payments','documents','verification','consultation','account','other')),
  subject      TEXT        NOT NULL,
  description  TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','in_progress','resolved','closed')),
  -- Set when an admin picks it up, so a queue can show who owns what.
  assigned_to  UUID        REFERENCES accounts(id) ON DELETE SET NULL,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   UUID        NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  -- Who wrote it. The author's account is kept separately so a support reply
  -- is attributable even though the client only ever sees "Support".
  sender      TEXT        NOT NULL CHECK (sender IN ('user','support')),
  author_id   UUID        REFERENCES accounts(id) ON DELETE SET NULL,
  body        TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_account ON support_tickets (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status  ON support_tickets (status) WHERE status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_ticket_messages (ticket_id, created_at);

CREATE OR REPLACE TRIGGER trg_support_tickets_updated_at
  BEFORE UPDATE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- ── Locked down like everything else ────────────────────────────────────────
-- Read and written only through /api/account/*, which runs as service_role.
ALTER TABLE saved_articles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_ticket_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON saved_articles, support_tickets, support_ticket_messages FROM anon, authenticated;
GRANT  ALL ON saved_articles, support_tickets, support_ticket_messages TO service_role;

-- ROLLBACK:
-- DROP TABLE IF EXISTS support_ticket_messages, support_tickets, saved_articles;
