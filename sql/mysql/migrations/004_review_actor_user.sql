-- Migration 4: approval trigger must see the connecting account.
-- CURRENT_USER() inside a DEFINER routine is the creator, not the session.
-- Statements are separated by `-- @split`.

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
