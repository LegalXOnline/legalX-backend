-- Migration: 20240908000001_account_deletion
-- Description: Makes deleting an account a single, complete operation.
-- Depends on:  every earlier migration (it rewrites their foreign keys)
-- Safe to re-run: yes — every statement is idempotent or guarded.
--
-- THE PROBLEM THIS SOLVES
-- Most tables were created with `REFERENCES accounts(id)` and no ON DELETE
-- clause, which Postgres reads as NO ACTION. Deleting a user from the Supabase
-- Auth dashboard then either fails outright or — where a table pointed at the
-- account without a constraint being checked — leaves the row behind. Cleaning
-- one account up by hand meant walking a dozen tables in the right order and
-- getting it right every time.
--
-- THE RULE
-- Every foreign key that points at an identity row now declares what happens
-- when that identity goes away, and the rule is derived from the column itself:
--
--   column is NOT NULL  ->  ON DELETE CASCADE
--        The row cannot exist without the account: their profile, their
--        bookings, their wallet, their messages. It goes with them.
--
--   column is NULLABLE  ->  ON DELETE SET NULL
--        The row outlives the account and simply loses its pointer: an audit
--        entry, a published card's reviewer, a review's author.
--
-- That rule is not a list to maintain — it is read off the live schema, so a
-- table added next month inherits the behaviour by choosing its nullability.
--
-- ROLLBACK (manual): there is no meaningful rollback. The previous state was
-- "deletion is impossible"; restoring it would mean dropping the ON DELETE
-- clauses again, which is what broke deletion in the first place.


-- ── 1. Rewrite every identity foreign key ────────────────────────────────────
DO $$
DECLARE
  fk           RECORD;
  parent_tbl   TEXT;
  parent_col   TEXT;
  child_tbl    TEXT;
  want         TEXT;
  changed      INT := 0;
  skipped      INT := 0;
BEGIN
  FOR fk IN
    SELECT
      c.conname,
      c.conrelid,
      c.confrelid,
      c.confdeltype,
      child.attname   AS child_col,
      child.attnotnull AS child_notnull,
      parent.attname  AS parent_col
    FROM pg_constraint c
    JOIN pg_attribute child
      ON child.attrelid = c.conrelid AND child.attnum = c.conkey[1]
    JOIN pg_attribute parent
      ON parent.attrelid = c.confrelid AND parent.attnum = c.confkey[1]
    WHERE c.contype = 'f'
      AND array_length(c.conkey, 1) = 1          -- composite keys are out of scope
      AND c.confrelid IN (
        'public.accounts'::regclass,
        'public.lawyer_profiles'::regclass
      )
  LOOP
    child_tbl  := fk.conrelid::regclass::text;
    parent_tbl := fk.confrelid::regclass::text;
    parent_col := fk.parent_col;

    -- A NOT NULL self-reference on accounts would make deleting one admin
    -- delete every account they created. Refuse rather than guess.
    IF fk.conrelid = fk.confrelid AND fk.child_notnull THEN
      RAISE NOTICE 'SKIP % on % — NOT NULL self-reference, resolve by hand',
        fk.conname, child_tbl;
      skipped := skipped + 1;
      CONTINUE;
    END IF;

    want := CASE WHEN fk.child_notnull THEN 'CASCADE' ELSE 'SET NULL' END;

    -- 'c' = cascade, 'n' = set null. Already correct: leave it alone.
    IF (fk.confdeltype = 'c' AND want = 'CASCADE')
       OR (fk.confdeltype = 'n' AND want = 'SET NULL') THEN
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', child_tbl, fk.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %s(%I) ON DELETE %s',
      child_tbl, fk.conname, fk.child_col, parent_tbl, parent_col, want
    );

    RAISE NOTICE 'FK %.% -> %.% now ON DELETE %',
      child_tbl, fk.child_col, parent_tbl, parent_col, want;
    changed := changed + 1;
  END LOOP;

  RAISE NOTICE 'account deletion: % foreign keys rewritten, % skipped', changed, skipped;
END $$;


-- ── 1b. accounts -> auth.users ───────────────────────────────────────────────
-- With section 1 in place, deleting the public.accounts row unwinds the whole
-- graph. This makes the reverse true as well: removing the user from the
-- Supabase Auth dashboard cascades into accounts and therefore into everything
-- below it, instead of leaving a disconnected row behind.
--
-- Only applied when the two tables already agree. If accounts holds rows whose
-- auth user is already gone, adding the constraint would fail — clean those up
-- from the admin portal first, then re-run this migration.
DO $$
DECLARE
  orphans   INT;
  existing  RECORD;
BEGIN
  -- Look the constraint up by what it does, not by what it is called: an
  -- earlier migration may have named it something else, and adding a second
  -- constraint alongside a NO ACTION one would leave the delete still blocked.
  SELECT c.conname, c.confdeltype INTO existing
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype = 'f'
    AND c.conrelid  = 'public.accounts'::regclass
    AND c.confrelid = 'auth.users'::regclass
    AND array_length(c.conkey, 1) = 1
    AND a.attname = 'id'
  LIMIT 1;

  IF FOUND AND existing.confdeltype = 'c' THEN
    RAISE NOTICE 'accounts -> auth.users cascade already in place';
    RETURN;
  END IF;

  SELECT count(*) INTO orphans
  FROM accounts a
  WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = a.id);

  IF orphans > 0 THEN
    RAISE NOTICE 'SKIP accounts -> auth.users: % account row(s) have no auth user. Purge them from the admin portal, then re-run this migration.', orphans;
    RETURN;
  END IF;

  IF FOUND THEN
    EXECUTE format('ALTER TABLE accounts DROP CONSTRAINT %I', existing.conname);
  END IF;

  ALTER TABLE accounts
    ADD CONSTRAINT accounts_id_fkey
    FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

  RAISE NOTICE 'accounts -> auth.users now ON DELETE CASCADE';
END $$;


-- ── 2. Tombstone ─────────────────────────────────────────────────────────────
-- A purge removes the rows; this records that it happened. Written before the
-- delete, inside the same request, so there is always an answer to "who removed
-- this account, when, and why" even though nothing of the account survives.
--
-- deleted_by deliberately carries no foreign key: the admin who performed the
-- deletion may themselves be deleted later, and that must not erase the record
-- of what they did.
CREATE TABLE IF NOT EXISTS deleted_accounts (
  id                  UUID        PRIMARY KEY,
  email               TEXT,
  phone               TEXT,
  first_name          TEXT,
  last_name           TEXT,
  role                TEXT,
  status              TEXT,
  account_created_at  TIMESTAMPTZ,
  snapshot            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  impact              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  reason              TEXT        NOT NULL,
  deleted_by          UUID,
  deleted_by_email    TEXT,
  deleted_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deleted_accounts_deleted_at
  ON deleted_accounts (deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_deleted_accounts_email
  ON deleted_accounts (lower(email));

-- Deny by default. No policy is defined, so anon and authenticated see nothing;
-- the API reaches this table as service_role, which bypasses RLS.
ALTER TABLE deleted_accounts ENABLE ROW LEVEL SECURITY;


-- ── 3. Impact preview ────────────────────────────────────────────────────────
-- Answers "what exactly disappears if I delete this account?" by counting the
-- rows that point at it, discovered from the live foreign keys rather than a
-- hardcoded table list. The admin portal shows this before asking to confirm.
--
-- Counts are for rows referencing the account directly (or its lawyer profile).
-- Rows that hang off those — a session under a booking, say — go too and are
-- not counted separately; the caller labels the figure accordingly.
CREATE OR REPLACE FUNCTION public.admin_account_impact(p_account_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  fk       RECORD;
  n        BIGINT;
  result   JSONB := '{}'::jsonb;
  auth_ok  BOOLEAN;
  acct_ok  BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM auth.users WHERE id = p_account_id) INTO auth_ok;
  SELECT EXISTS (SELECT 1 FROM accounts  WHERE id = p_account_id) INTO acct_ok;

  FOR fk IN
    SELECT
      c.conrelid::regclass::text AS child_tbl,
      child.attname             AS child_col,
      c.confrelid::regclass::text AS parent_tbl
    FROM pg_constraint c
    JOIN pg_attribute child
      ON child.attrelid = c.conrelid AND child.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND array_length(c.conkey, 1) = 1
      AND c.confrelid IN (
        'public.accounts'::regclass,
        'public.lawyer_profiles'::regclass
      )
      -- deleted_accounts has no FK, but guard anyway: never count the tombstone.
      AND c.conrelid <> 'public.deleted_accounts'::regclass
  LOOP
    EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', fk.child_tbl, fk.child_col)
      INTO n USING p_account_id;

    IF n > 0 THEN
      result := result || jsonb_build_object(
        replace(fk.child_tbl, 'public.', '') || '.' || fk.child_col, n
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'account_exists',   acct_ok,
    'auth_user_exists', auth_ok,
    'tables',           result
  );
END $$;

-- The API reaches this as service_role. Nothing else needs it, and it can read
-- auth.users, so the default grant to anon/authenticated is taken back.
DO $$ BEGIN
  REVOKE ALL ON FUNCTION public.admin_account_impact(UUID) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.admin_account_impact(UUID) FROM anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.admin_account_impact(UUID) TO service_role;
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'anon/authenticated/service_role not present — grants left at defaults';
END $$;
