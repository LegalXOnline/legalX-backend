-- Migration: 20240816000001_add_lawyer_profile_fields
-- Description: Add verified_at and rejection_reason columns to lawyer_profiles
--              if upgrading from an older schema version that didn't have them.
-- Depends on: 20240101000004_lawyer_profiles
-- Safe to re-run: uses IF NOT EXISTS / ALTER ... IF NOT EXISTS pattern

ALTER TABLE lawyer_profiles
  ADD COLUMN IF NOT EXISTS verified_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason  TEXT;
