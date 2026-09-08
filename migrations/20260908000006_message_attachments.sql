-- Migration: 20260908000006_message_attachments
-- Description: Lets a chat message carry a document.
-- Depends on:  20260908000005_consultation_chat
-- Safe to re-run: yes.
--
-- A legal consultation is largely about documents — a notice, a receipt, a
-- lease — and a text consultation that cannot carry one sends people back to
-- email, where nothing is attached to the matter and nobody can find it later.
--
-- The file itself goes to the same private bucket as everything else; only the
-- storage path is kept here, and it is signed on demand when read. A public URL
-- in a row would outlive the consultation, the account and any later deletion.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS attachment_url  TEXT,
  ADD COLUMN IF NOT EXISTS attachment_name TEXT,
  ADD COLUMN IF NOT EXISTS attachment_size INTEGER;

-- content is NOT NULL in some deployments of this table, and an attachment sent
-- with no words is a normal thing to do. Relaxed so the caption can be empty.
DO $$ BEGIN
  ALTER TABLE messages ALTER COLUMN content DROP NOT NULL;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'messages.content already nullable, or not droppable — leaving as is';
END $$;

-- A message must say something or carry something. Both empty is a row nobody
-- meant to create.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_has_content_or_attachment;
ALTER TABLE messages
  ADD CONSTRAINT messages_has_content_or_attachment
  CHECK (
    (content IS NOT NULL AND length(btrim(content)) > 0)
    OR attachment_url IS NOT NULL
  );

COMMENT ON COLUMN messages.attachment_url IS
  'Storage path in the private bucket, never a public URL. Signed on read.';
