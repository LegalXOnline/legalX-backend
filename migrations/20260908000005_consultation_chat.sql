-- Migration: 20260908000005_consultation_chat
-- Description: Links a conversation to its consultation, and publishes messages.
-- Depends on:  20240101000006_consultations, 20240101000007_messaging,
--              20260908000003_realtime_publication
-- Safe to re-run: yes.
--
-- WHY
-- conversations, conversation_participants and messages have existed since the
-- first schema and have never held a row, because a chat consultation opened
-- the video room instead — a phone icon and "Waiting for lawyer…", with no
-- message list, no composer and no send path.
--
-- The tables need one thing to be usable: a way to find the conversation for a
-- consultation. There is no column joining them, so there is no way to answer
-- "what was said during this consultation" — which the lawyer, the client, a
-- dispute and the audit trail all eventually need to ask.

-- ── Link a conversation to its consultation ──────────────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS consultation_id UUID REFERENCES consultations(id) ON DELETE CASCADE;

-- One conversation per consultation. A partial index rather than a constraint,
-- because rows predating this (and any conversation not tied to a call) keep a
-- null and must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_consultation
  ON conversations (consultation_id)
  WHERE consultation_id IS NOT NULL;

-- The only read a chat ever does: this conversation, in order.
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages (conversation_id, created_at);

COMMENT ON COLUMN conversations.consultation_id IS
  'The consultation this conversation belongs to. Null for conversations not tied to a call.';


-- ── Publish messages for realtime ────────────────────────────────────────────
-- The lesson from the ring: Postgres only streams changes for tables a
-- publication lists, and a missing one fails silently — the subscription
-- reports success and no event ever arrives. Chat rides the same relay, so it
-- needs the same entry.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime not present — skipping (self-hosted?)';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
  ) THEN
    RAISE NOTICE 'messages already published';
    RETURN;
  END IF;

  ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  RAISE NOTICE 'messages added to supabase_realtime';
END $$;
