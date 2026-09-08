-- Migration: 20260908000003_realtime_publication
-- Description: Puts the tables the app subscribes to into the realtime publication.
-- Depends on:  20240824000001_lawyer_onboarding, 20240902000001_notifications
-- Safe to re-run: yes — each table is added only if absent.
--
-- WHY
-- Postgres only streams changes for tables listed in a publication. Supabase
-- Realtime reads `supabase_realtime`, and neither of these tables was in it.
--
-- The effect was silent and total: the backend's SSE endpoint subscribed
-- successfully, every insert succeeded, and no event was ever delivered. A
-- client would place a call, the ring row would be written, and the lawyer's
-- browser would sit there holding an open, healthy, permanently empty stream
-- until the twenty-second window lapsed. Nothing in the logs looks wrong,
-- because nothing failed — the rows were simply never published.
--
--   consultation_notifications — the incoming-call ring
--   notifications              — the bell in the header
--
-- Verified by subscribing from Node, inserting a row, and receiving nothing.

DO $$
DECLARE
  t TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication not present — skipping (self-hosted?)';
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['consultation_notifications', 'notifications'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      RAISE NOTICE 'SKIP %: table does not exist', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE '% already published', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    RAISE NOTICE '% added to supabase_realtime', t;
  END LOOP;
END $$;
