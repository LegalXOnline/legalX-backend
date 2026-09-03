-- Migration: 20240906000001_knowledge_cards
-- Description:
--   "Know Your Rights" — the second Knowledge Centre section.
--
--   These are question-shaped explainers derived from judgments and NCRB
--   source documents, distinct from shorts_cards (the daily regulator feed).
--   They are kept in their own table rather than folded into shorts_cards
--   because the shapes genuinely differ: a rights card is a Q&A with a
--   direct_answer written for a featured snippet, has no expiry, and carries
--   reviewer attribution that Google weighs for YMYL content.
--
--   Column names mirror the source export exactly so a re-import is a plain
--   upsert and no card text is ever rewritten in transit.
-- Safe to re-run (idempotent).

CREATE TABLE IF NOT EXISTS knowledge_cards (
  id                  UUID PRIMARY KEY,

  -- URL identity. Generated from the title at import and then frozen: if a
  -- title is later corrected the slug stays put, so live URLs never break.
  slug                TEXT NOT NULL UNIQUE,

  content_type        TEXT NOT NULL DEFAULT 'rights_explainer',
  category            TEXT NOT NULL,

  title               TEXT NOT NULL,
  question            TEXT,
  -- One or two lines. This is what goes in the meta description and the
  -- FAQPage acceptedAnswer, so it is the single most load-bearing field.
  direct_answer       TEXT,
  explanation         TEXT,
  card_text           TEXT,
  case_reference      TEXT,
  suggested_questions TEXT[] DEFAULT '{}',

  -- Provenance. source_url is never dropped — it is what makes the card
  -- checkable, and indiankanoon.org additionally requires attribution.
  source_url          TEXT,
  source_tid          TEXT,
  source              TEXT,
  content_hash        TEXT,
  raw_document_id     UUID,

  cta_type            TEXT,

  -- Review gate. Nothing renders publicly until is_published is true.
  is_published        BOOLEAN NOT NULL DEFAULT false,
  published_at        TIMESTAMPTZ,
  reviewed_by         TEXT,
  last_reviewed_at    TIMESTAMPTZ,
  rejected_reason     TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the public list, which always filters on is_published.
CREATE INDEX IF NOT EXISTS idx_knowledge_published
  ON knowledge_cards(published_at DESC NULLS LAST)
  WHERE is_published = true;

CREATE INDEX IF NOT EXISTS idx_knowledge_category
  ON knowledge_cards(category, published_at DESC)
  WHERE is_published = true;

-- The admin review queue reads the other side of the gate.
CREATE INDEX IF NOT EXISTS idx_knowledge_review
  ON knowledge_cards(is_published, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_slug ON knowledge_cards(slug);

-- Full-text search over the question and the answer.
CREATE INDEX IF NOT EXISTS idx_knowledge_search
  ON knowledge_cards
  USING GIN (to_tsvector('english',
    coalesce(title,'') || ' ' || coalesce(direct_answer,'') || ' ' || coalesce(explanation,'')));

-- No CHECK constraint on category on purpose: the export currently carries
-- seven values and more sections are planned, so a rigid list here would
-- reject a future import rather than surface it.

CREATE OR REPLACE TRIGGER trg_knowledge_cards_updated_at
  BEFORE UPDATE ON knowledge_cards
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

-- Raw source documents the cards were derived from. Kept so a reviewer can
-- read what a card was built from without leaving the portal.
CREATE TABLE IF NOT EXISTS knowledge_raw_documents (
  id            UUID PRIMARY KEY,
  source        TEXT,
  external_id   TEXT,
  url           TEXT,
  title         TEXT,
  doc_type      TEXT,
  raw_text      TEXT,
  content_hash  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_raw_external
  ON knowledge_raw_documents(source, external_id);

-- RLS: these tables are read through the service-role backend only, which
-- applies the is_published gate itself. Enabling RLS with no permissive policy
-- means a leaked anon key still cannot read unreviewed drafts.
ALTER TABLE knowledge_cards        ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_raw_documents ENABLE ROW LEVEL SECURITY;
