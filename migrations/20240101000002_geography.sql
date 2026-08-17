-- Migration: 20240101000002_geography
-- Description: Country / State / City / Language reference tables
-- Depends on: 20240101000000_extensions_and_enums

CREATE TABLE IF NOT EXISTS countries (
  id          SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code        CHAR(2) NOT NULL UNIQUE,
  name        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS states (
  id          SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  country_id  SMALLINT NOT NULL REFERENCES countries(id),
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  UNIQUE (country_id, code)
);

CREATE TABLE IF NOT EXISTS cities (
  id          INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  state_id    SMALLINT NOT NULL REFERENCES states(id),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  UNIQUE (state_id, slug)
);

CREATE TABLE IF NOT EXISTS languages (
  id    SMALLINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

-- Seed India
INSERT INTO countries (code, name) VALUES ('IN', 'India') ON CONFLICT (code) DO NOTHING;
