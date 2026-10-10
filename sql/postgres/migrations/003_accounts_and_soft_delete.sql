-- Migration 3: accounts, soft-delete, live-only uniqueness, review trigger.
-- Statements are separated by `-- @split`.

ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP

-- @split

ALTER TABLE notes ADD COLUMN IF NOT EXISTS deleted_by TEXT

-- @split

DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  WHERE con.conrelid = 'notes'::regclass
    AND con.contype = 'u'
    AND pg_get_constraintdef(con.oid) ILIKE '%workspace%'
    AND pg_get_constraintdef(con.oid) ILIKE '%subtopic%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notes DROP CONSTRAINT %I', cname);
  END IF;
END $$

-- @split

CREATE UNIQUE INDEX IF NOT EXISTS uq_notes_scope_live
  ON notes (workspace, project, topic, subtopic)
  WHERE deleted_at IS NULL

-- @split

CREATE TABLE IF NOT EXISTS accounts (
  account_id   SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('engineer', 'tech_lead')),
  workspaces   TEXT,
  revoked_at   TIMESTAMP
)

-- @split

CREATE OR REPLACE FUNCTION resolve_account(p_token_hash TEXT)
RETURNS TABLE (account_id INT, name TEXT, role TEXT, workspaces TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.account_id, a.name, a.role, a.workspaces
  FROM accounts a
  WHERE a.token_hash = p_token_hash
    AND a.revoked_at IS NULL
$$

-- @split

REVOKE ALL ON FUNCTION resolve_account(TEXT) FROM PUBLIC

-- @split

GRANT EXECUTE ON FUNCTION resolve_account(TEXT) TO PUBLIC

-- @split

CREATE OR REPLACE FUNCTION cw_enforce_review_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  actor text := current_user;
  is_engineer boolean := actor = 'engineer';
  is_tech_lead boolean := actor = 'tech_lead';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'engineer') THEN
    is_engineer := is_engineer OR pg_has_role(actor, 'engineer', 'member');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tech_lead') THEN
    is_tech_lead := is_tech_lead OR pg_has_role(actor, 'tech_lead', 'member');
  END IF;

  IF is_engineer AND NOT is_tech_lead THEN
    IF NEW.review_status = 'APPROVED'
       AND (TG_OP = 'INSERT' OR OLD.review_status IS DISTINCT FROM 'APPROVED') THEN
      RAISE EXCEPTION 'engineer cannot set review_status to APPROVED'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$

-- @split

DROP TRIGGER IF EXISTS cw_notes_review_status ON notes

-- @split

CREATE TRIGGER cw_notes_review_status
  BEFORE INSERT OR UPDATE ON notes
  FOR EACH ROW
  EXECUTE FUNCTION cw_enforce_review_status()
