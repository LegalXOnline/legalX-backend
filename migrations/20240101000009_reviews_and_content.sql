-- Migration: 20240101000009_reviews_and_content
-- Description: Reviews, articles/blog, and moderation reports
-- Depends on: 20240101000003, 20240101000004, 20240101000006

CREATE TABLE IF NOT EXISTS reviews (
  id          UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  UUID  UNIQUE REFERENCES bookings(id) ON DELETE SET NULL,
  author_id   UUID  NOT NULL REFERENCES accounts(id),
  target_type target_type NOT NULL,
  target_id   UUID  NOT NULL,
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        TEXT,
  is_visible  BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS articles (
  id            UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id     UUID  NOT NULL REFERENCES accounts(id),
  title         TEXT  NOT NULL,
  slug          TEXT  NOT NULL UNIQUE,
  body          TEXT  NOT NULL,
  excerpt       TEXT,
  cover_url     TEXT,
  status        article_status NOT NULL DEFAULT 'draft',
  published_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_target   ON reviews(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_articles_slug    ON articles(slug);
CREATE INDEX IF NOT EXISTS idx_articles_status  ON articles(status, published_at DESC);

CREATE OR REPLACE TRIGGER trg_reviews_updated_at
  BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();

CREATE OR REPLACE TRIGGER trg_articles_updated_at
  BEFORE UPDATE ON articles
  FOR EACH ROW EXECUTE FUNCTION tg_set_updated_at();
