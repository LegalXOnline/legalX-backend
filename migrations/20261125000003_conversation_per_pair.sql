-- Migration: 20261125000003_conversation_per_pair
-- Description:
--   One conversation per client and advocate, instead of one per consultation.
--
--   A new consultation opened a new conversation, so the chat was empty every
--   time. One pair in production had seven separate threads: the client came
--   back to the same advocate seven times and started from nothing on each.
--   Nobody can hold a legal matter together that way.
--
--   Messages keep the consultation they were sent during, so a thread still
--   says which session each message belongs to and billing can still be
--   reconciled against it.
-- Safe to re-run (idempotent).

-- ── 1. Key conversations by the pair ────────────────────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS lawyer_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

-- ── 2. Remember which session a message belonged to ─────────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS consultation_id UUID REFERENCES consultations(id) ON DELETE SET NULL;

-- ── 3. Backfill from the existing consultation link ─────────────────────────
UPDATE conversations AS cv
   SET client_id = c.client_id,
       lawyer_id = c.lawyer_id
  FROM consultations AS c
 WHERE cv.consultation_id = c.id
   AND cv.client_id IS NULL;

UPDATE messages AS m
   SET consultation_id = cv.consultation_id
  FROM conversations AS cv
 WHERE m.conversation_id = cv.id
   AND m.consultation_id IS NULL
   AND cv.consultation_id IS NOT NULL;

-- ── 4. Merge the duplicates, oldest thread wins ─────────────────────────────
-- Messages and participants move onto the keeper; the empty shells go.
WITH keeper AS (
  SELECT DISTINCT ON (client_id, lawyer_id)
         id, client_id, lawyer_id
    FROM conversations
   WHERE type = 'consultation' AND client_id IS NOT NULL AND lawyer_id IS NOT NULL
   ORDER BY client_id, lawyer_id, created_at ASC
),
dupe AS (
  SELECT cv.id AS from_id, k.id AS to_id
    FROM conversations cv
    JOIN keeper k ON k.client_id = cv.client_id AND k.lawyer_id = cv.lawyer_id
   WHERE cv.type = 'consultation' AND cv.id <> k.id
)
UPDATE messages m
   SET conversation_id = d.to_id
  FROM dupe d
 WHERE m.conversation_id = d.from_id;

WITH keeper AS (
  SELECT DISTINCT ON (client_id, lawyer_id) id, client_id, lawyer_id
    FROM conversations
   WHERE type = 'consultation' AND client_id IS NOT NULL AND lawyer_id IS NOT NULL
   ORDER BY client_id, lawyer_id, created_at ASC
)
DELETE FROM conversations cv
 USING keeper k
 WHERE cv.type = 'consultation'
   AND cv.client_id = k.client_id
   AND cv.lawyer_id = k.lawyer_id
   AND cv.id <> k.id;

-- Participants may now duplicate on the keeper.
DELETE FROM conversation_participants a
 USING conversation_participants b
 WHERE a.ctid > b.ctid
   AND a.conversation_id = b.conversation_id
   AND a.account_id = b.account_id;

-- ── 5. One thread per pair, enforced ────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_pair
  ON conversations (client_id, lawyer_id)
  WHERE type = 'consultation';

CREATE INDEX IF NOT EXISTS idx_messages_consultation ON messages (consultation_id);

COMMENT ON COLUMN conversations.client_id IS
  'The client side of this thread. With lawyer_id this is the identity of the conversation — one per pair, carried across every consultation they have.';
COMMENT ON COLUMN messages.consultation_id IS
  'Which consultation this message was sent during. The thread spans sessions; this says where each message sits inside it.';

-- ROLLBACK:
-- The merge is not reversible — the duplicate threads are gone.
-- DROP INDEX IF EXISTS idx_conversations_pair;
-- DROP INDEX IF EXISTS idx_messages_consultation;
-- ALTER TABLE messages DROP COLUMN IF EXISTS consultation_id;
-- ALTER TABLE conversations DROP COLUMN IF EXISTS client_id, DROP COLUMN IF EXISTS lawyer_id;
