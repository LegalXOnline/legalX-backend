-- Migration: 20240904000001_knowledge_center
-- Description:
--   Turns shorts_cards into a curated suggestion queue for the Knowledge Center.
--
--   The pipeline now proposes 5–10 candidates per run and an editor approves
--   3–4. Rejected candidates are KEPT, not deleted: they are the record of what
--   was considered and declined, and they stop the same item being re-suggested
--   every morning.
-- Safe to re-run (idempotent).

-- ── Review lifecycle ──────────────────────────────────────────────────────────
-- is_published still drives the public feed and is untouched. review_status
-- drives the editor's queue, so a rejected card leaves the queue without
-- leaving the database.
ALTER TABLE shorts_cards
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shorts_cards_review_status_check'
  ) THEN
    ALTER TABLE shorts_cards
      ADD CONSTRAINT shorts_cards_review_status_check
      CHECK (review_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

-- ── Grounding and quality signals ─────────────────────────────────────────────
-- The verbatim sentence from the source that supports the summary. The pipeline
-- rejects any suggestion whose evidence cannot be found in the source text —
-- this is the primary defence against a fabricated holding.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS evidence TEXT;

-- 1–5, how much this matters to an ordinary citizen. Low scores are filtered
-- out before an editor ever sees them.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS relevance_score SMALLINT;

-- The model's own confidence. Surfaced in the queue so a shaky card gets read
-- more carefully rather than skimmed.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS confidence TEXT;

-- Human-readable provenance, e.g. "Press Information Bureau". Shown on the
-- public card so readers can see where it came from.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS source_name TEXT;

-- Which configured feed produced it, for tuning the source list later.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS source_feed TEXT;

-- ── Indexes ───────────────────────────────────────────────────────────────────
-- The editor's queue: pending suggestions, best first.
CREATE INDEX IF NOT EXISTS idx_shorts_pending
  ON shorts_cards(relevance_score DESC, created_at DESC)
  WHERE review_status = 'pending';

-- The public archive: browse by month.
CREATE INDEX IF NOT EXISTS idx_shorts_archive
  ON shorts_cards(published_at DESC)
  WHERE is_published = true;

-- Existing rows predate the queue. Anything already live is approved by
-- definition; anything not live was a draft, which is exactly 'pending'.
UPDATE shorts_cards
   SET review_status = 'approved'
 WHERE is_published = true AND review_status = 'pending';
