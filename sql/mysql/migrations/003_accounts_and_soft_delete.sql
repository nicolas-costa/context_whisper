-- Migration 3: accounts, soft-delete, live-only uniqueness, review trigger.
-- Statements are separated by `-- @split`.

ALTER TABLE notes
  ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL

-- @split

ALTER TABLE notes
  ADD COLUMN deleted_by VARCHAR(255) NULL

-- @split

ALTER TABLE notes DROP INDEX uq_notes_scope

-- @split

ALTER TABLE notes DROP COLUMN scope_hash

-- @split

ALTER TABLE notes
  ADD COLUMN live_scope_hash CHAR(64)
    GENERATED ALWAYS AS (
      CASE
        WHEN deleted_at IS NULL THEN SHA2(CONCAT_WS(UNHEX('1F'), workspace, project, topic, subtopic), 256)
        ELSE NULL
      END
    ) STORED

-- @split

ALTER TABLE notes
  ADD UNIQUE KEY uq_notes_live (live_scope_hash)

-- @split

CREATE TABLE IF NOT EXISTS accounts (
  account_id   INT AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  token_hash   CHAR(64) NOT NULL,
  role         VARCHAR(20) NOT NULL,
  workspaces   TEXT,
  revoked_at   TIMESTAMP NULL DEFAULT NULL,
  UNIQUE KEY uq_accounts_token (token_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci

-- @split

DROP FUNCTION IF EXISTS resolve_account

-- @split

CREATE FUNCTION resolve_account(p_token_hash CHAR(64))
RETURNS JSON
READS SQL DATA
SQL SECURITY DEFINER
BEGIN
  DECLARE result JSON;
  SELECT JSON_OBJECT(
    'account_id', account_id,
    'name', name,
    'role', role,
    'workspaces', workspaces
  ) INTO result
  FROM accounts
  WHERE token_hash = p_token_hash
    AND revoked_at IS NULL
  LIMIT 1;
  RETURN result;
END

-- @split

DROP FUNCTION IF EXISTS cw_is_engineer_session

-- @split

CREATE FUNCTION cw_is_engineer_session()
RETURNS TINYINT
NOT DETERMINISTIC
READS SQL DATA
SQL SECURITY DEFINER
BEGIN
  DECLARE actor VARCHAR(255);
  DECLARE has_lead INT DEFAULT 0;
  DECLARE has_engineer INT DEFAULT 0;

  -- USER() is the connecting account. CURRENT_USER() inside a DEFINER routine is the creator.
  SET actor = SUBSTRING_INDEX(USER(), '@', 1);
  IF actor = 'tech_lead' THEN
    RETURN 0;
  END IF;
  IF actor = 'engineer' THEN
    RETURN 1;
  END IF;

  -- Inherited role. Each lookup fails open when the definer cannot read mysql.role_edges.
  -- Column GRANT on notes.review_status is the barrier in that case.
  BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET has_lead = 0;
    SELECT COUNT(*) INTO has_lead
    FROM mysql.role_edges
    WHERE TO_USER = actor AND FROM_USER = 'tech_lead';
  END;
  BEGIN
    DECLARE CONTINUE HANDLER FOR SQLEXCEPTION SET has_engineer = 0;
    SELECT COUNT(*) INTO has_engineer
    FROM mysql.role_edges
    WHERE TO_USER = actor AND FROM_USER = 'engineer';
  END;

  IF has_lead > 0 THEN
    RETURN 0;
  END IF;
  IF has_engineer > 0 THEN
    RETURN 1;
  END IF;
  RETURN 0;
END

-- @split

DROP TRIGGER IF EXISTS cw_notes_review_status_ins

-- @split

CREATE TRIGGER cw_notes_review_status_ins
BEFORE INSERT ON notes
FOR EACH ROW
BEGIN
  IF NEW.review_status = 'APPROVED' AND cw_is_engineer_session() = 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'engineer cannot set review_status to APPROVED';
  END IF;
END

-- @split

DROP TRIGGER IF EXISTS cw_notes_review_status_upd

-- @split

CREATE TRIGGER cw_notes_review_status_upd
BEFORE UPDATE ON notes
FOR EACH ROW
BEGIN
  IF NEW.review_status = 'APPROVED'
     AND (OLD.review_status IS NULL OR OLD.review_status <> 'APPROVED')
     AND cw_is_engineer_session() = 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'engineer cannot set review_status to APPROVED';
  END IF;
END
