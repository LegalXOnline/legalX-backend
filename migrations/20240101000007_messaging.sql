-- Migration: 20240101000007_messaging
-- Description: In-app conversations and messages
-- Depends on: 20240101000003, 20240101000006

CREATE TABLE IF NOT EXISTS conversations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        conversation_type NOT NULL DEFAULT 'consultation',
  booking_id  UUID REFERENCES bookings(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, account_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       UUID NOT NULL REFERENCES accounts(id),
  msg_type        message_type NOT NULL DEFAULT 'text',
  body            TEXT,
  storage_path    TEXT,
  is_read         BOOLEAN NOT NULL DEFAULT false,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_convo  ON messages(conversation_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id);

-- RLS
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_participant_read ON messages;
DROP POLICY IF EXISTS messages_participant_send ON messages;

CREATE POLICY messages_participant_read ON messages FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = messages.conversation_id AND cp.account_id = auth.uid()
  ));

CREATE POLICY messages_participant_send ON messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id AND EXISTS (
      SELECT 1 FROM conversation_participants cp
      WHERE cp.conversation_id = messages.conversation_id AND cp.account_id = auth.uid()
    )
  );
