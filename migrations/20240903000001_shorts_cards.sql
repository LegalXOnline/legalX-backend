-- Migration: 20240903000001_shorts_cards
-- Description:
--   Bite-sized legal updates ("shorts") summarised from official court
--   judgments and published to the public /shorts feed.
--
--   Sourcing is restricted to official court sites. Section 52(1)(q)(iv) of the
--   Copyright Act exempts reproduction of judgments from copyright; the
--   editorial write-ups on news and reporter sites are NOT exempt, so they must
--   never be ingested.
-- Safe to re-run (idempotent).

CREATE TABLE IF NOT EXISTS shorts_cards (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           VARCHAR(255) NOT NULL,
  slug            TEXT UNIQUE,
  summary         TEXT NOT NULL,
  takeaway        TEXT,
  category        VARCHAR(100) NOT NULL,
  court           VARCHAR(150),
  judgment_date   DATE DEFAULT CURRENT_DATE,
  source_url      TEXT UNIQUE,
  tags            TEXT[] DEFAULT '{}',

  -- Review-first. An AI summary of case law goes out under the LegalX name, so
  -- nothing reaches the public feed until a human has approved it in the admin
  -- portal. This default is deliberate — do not flip it to true.
  is_published    BOOLEAN NOT NULL DEFAULT false,
  published_at    TIMESTAMPTZ,
  reviewed_by     UUID REFERENCES accounts(id),

  -- Original extracted text, kept so a card can be re-summarised (better model,
  -- better prompt) without re-fetching the court site.
  raw_source      JSONB,

  likes_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shorts_category ON shorts_cards(category);

-- Serves the public feed query: published cards, newest first.
CREATE INDEX IF NOT EXISTS idx_shorts_published
  ON shorts_cards(is_published, created_at DESC);

-- Serves the admin review queue: unpublished cards, oldest first.
CREATE INDEX IF NOT EXISTS idx_shorts_review_queue
  ON shorts_cards(created_at) WHERE is_published = false;

ALTER TABLE shorts_cards ENABLE ROW LEVEL SECURITY;

-- The backend reads this with the service_role key, which bypasses RLS. This
-- policy only matters if the anon key ever touches the table — and then it must
-- expose published cards only, never the unreviewed queue.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'shorts_cards'
      AND policyname = 'Public read access for published shorts'
  ) THEN
    CREATE POLICY "Public read access for published shorts"
      ON shorts_cards FOR SELECT USING (is_published = true);
  END IF;
END $$;
