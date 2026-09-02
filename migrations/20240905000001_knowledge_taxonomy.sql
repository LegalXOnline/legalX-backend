-- Migration: 20240905000001_knowledge_taxonomy
-- Description:
--   Restructures the Knowledge Centre around the reader's problem rather than
--   the source, and adds the fields the relevance gate produces.
--
--   The old categories (Civil / Consumer / Corporate …) described legal
--   disciplines, so a model with no legal subject in front of it tagged
--   arbitrarily — a forex-reserves release landed in "Consumer", a current
--   account deficit in "Corporate". The six below describe situations a person
--   is actually in, and each maps to a service the platform sells.
-- Safe to re-run (idempotent).

-- ── Gate output ───────────────────────────────────────────────────────────────
-- Who the source document is written for. Institution-only material is the
-- single biggest source of noise, so it is recorded rather than inferred later.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS audience TEXT;
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS affects_whom TEXT;

-- 'yes' | 'no' | 'conditional' — whether the reader must do something.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS action_required TEXT;
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS deadline DATE;

-- Time-bound items stop being useful. An auction "on Sep 1" was dead on Sep 2
-- but stayed in the feed; the public queries now exclude expired rows.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS expires_on DATE;

ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS key_points TEXT[] DEFAULT '{}';
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS statute_reference TEXT;

-- Why the gate accepted or rejected it. Kept for rejected rows too: it is how
-- the filter gets tuned.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS gate_reason TEXT;

-- Normalised headline, for catching near-duplicates that a UNIQUE source_url
-- cannot — two VRRR auction notices a day apart are different URLs and the
-- same card.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE INDEX IF NOT EXISTS idx_shorts_dedupe ON shorts_cards(dedupe_key);

-- ── Category migration ────────────────────────────────────────────────────────
-- Old values map onto the closest new one. Anything ambiguous goes to
-- money_consumer, which is the broadest consumer-facing bucket, and will be
-- re-tagged by hand or on the next regeneration.
UPDATE shorts_cards SET category = CASE
  WHEN category IN ('Property')                      THEN 'property_rent'
  WHEN category IN ('Family')                        THEN 'family_marriage'
  WHEN category IN ('Consumer', 'Civil')             THEN 'money_consumer'
  WHEN category IN ('Criminal')                      THEN 'crime_safety'
  WHEN category IN ('Corporate', 'Tax', 'Labour')    THEN 'business_compliance'
  WHEN category IN ('Constitutional')                THEN 'crime_safety'
  ELSE 'money_consumer'
END
WHERE category IN ('Property','Family','Consumer','Civil','Criminal','Corporate','Tax','Labour','Constitutional');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shorts_cards_category_check'
  ) THEN
    ALTER TABLE shorts_cards ADD CONSTRAINT shorts_cards_category_check
      CHECK (category IN (
        'property_rent', 'family_marriage', 'money_consumer',
        'crime_safety', 'business_compliance', 'cyber_online'
      ));
  END IF;
END $$;

-- ── Retire the current feed ───────────────────────────────────────────────────
-- All five live cards are RBI monetary operations and macro statistics; none
-- passes the relevance gate. They are unpublished rather than deleted so the
-- gate can be measured against them.
UPDATE shorts_cards
   SET is_published = false,
       review_status = 'rejected',
       rejected_reason = 'Retired by the relevance audit: institution-facing monetary operations and macro statistics.'
 WHERE is_published = true;

-- Serves the public feed, which now also excludes expired rows.
CREATE INDEX IF NOT EXISTS idx_shorts_live
  ON shorts_cards(published_at DESC)
  WHERE is_published = true;

-- ── Relevance tier ────────────────────────────────────────────────────────────
-- A binary gate produced an empty feed on days when nothing was directly
-- actionable, while still spending a model call per rejection. Three tiers keep
-- genuinely useful legal news ("moderate") without letting monetary operations
-- and macro statistics back in.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS relevance_tier TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shorts_cards_tier_check') THEN
    ALTER TABLE shorts_cards ADD CONSTRAINT shorts_cards_tier_check
      CHECK (relevance_tier IS NULL OR relevance_tier IN ('high', 'moderate'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shorts_tier
  ON shorts_cards(relevance_tier, published_at DESC) WHERE is_published = true;

-- ── Stage 3 verifier output ───────────────────────────────────────────────────
-- An independent pass over each generated card. Stored so a reviewer can see
-- what was questioned, not just whether it passed.
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS verified BOOLEAN;
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS verifier_notes TEXT;
ALTER TABLE shorts_cards ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(3,2);
