-- Migration: 20261125000001_lawyer_presence_lease
-- Description:
--   Makes advocate availability a lease that has to be renewed, rather than a
--   flag set once and never cleared.
--
--   The live table showed why: of seven profiles advertised as online, five had
--   never written last_seen_at at all and two had last renewed 70 and 76 days
--   earlier. Every advocate a client could pick was unreachable, so calls and
--   chats rang in an empty room and sat on "Connecting…" forever.
--
--   The rule itself lives in src/lib/presence.ts, not a constraint — "online"
--   is a question about the current time. This migration stops the stored data
--   lying and makes the lease query cheap.
-- Safe to re-run (idempotent).

-- Stop advertising advocates who are not there.
UPDATE lawyer_profiles
   SET is_online = false,
       updated_at = now()
 WHERE is_online = true
   AND (last_seen_at IS NULL OR last_seen_at < now() - INTERVAL '90 seconds');

-- The directory filters on both columns; the existing partial index on
-- is_online alone cannot answer the last_seen_at half.
CREATE INDEX IF NOT EXISTS idx_lawyer_profiles_presence
  ON lawyer_profiles (is_online, last_seen_at DESC)
  WHERE is_online = true;

COMMENT ON COLUMN lawyer_profiles.is_online IS
  'Advocate intends to take consultations. Not sufficient alone — presence is a lease: is_online AND last_seen_at within the window in src/lib/presence.ts. Read it through isLive().';

COMMENT ON COLUMN lawyer_profiles.last_seen_at IS
  'Last renewal from POST /api/lawyers/me/heartbeat. The lease lapses on its own when renewals stop, so there is no disconnect hook or sweep to get wrong.';

-- ROLLBACK:
-- DROP INDEX IF EXISTS idx_lawyer_profiles_presence;
-- The UPDATE is not reversible; the prior flags were not recoverable truth.
