-- Migration 3: accounts, soft-delete, live-only uniqueness, review trigger.
-- Statements are separated by `-- @split`.

ALTER TABLE notes
  ADD COLUMN deleted_at TIMESTAMP NULL DEFAULT NULL,
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
    ) STORED,
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
DETERMINISTIC
BEGIN
  DECLARE actor VARCHAR(255);
  DECLARE active_role VARCHAR(255);
  SET actor = SUBSTRING_INDEX(CURRENT_USER(), '@', 1);
  SET active_role = IFNULL(CURRENT_ROLE(), '');
  IF actor = 'tech_lead' OR active_role LIKE '%`tech_lead`%' OR active_role LIKE '%''tech_lead''%' THEN
    RETURN 0;
  END IF;
  IF actor = 'engineer' OR active_role LIKE '%`engineer`%' OR active_role LIKE '%''engineer''%' THEN
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
