-- Migration 3: accounts, soft-delete, live-only uniqueness.
-- Statements are separated by `-- @split`.

PRAGMA foreign_keys = OFF

-- @split

DROP TABLE IF EXISTS notes_v3

-- @split

CREATE TABLE notes_v3 (
  note_id       INTEGER PRIMARY KEY,
  workspace     TEXT NOT NULL,
  project       TEXT NOT NULL,
  topic         TEXT NOT NULL,
  subtopic      TEXT NOT NULL DEFAULT '',
  tags_json     TEXT,
  body_md       TEXT NOT NULL,
  created_by    TEXT,
  review_status TEXT DEFAULT 'DRAFT',
  repo_url         TEXT,
  repo_fingerprint TEXT,
  repo_provider    TEXT,
  repo_owner       TEXT,
  repo_name        TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  deleted_at    TEXT,
  deleted_by    TEXT
)

-- @split

INSERT INTO notes_v3 (
  note_id, workspace, project, topic, subtopic, tags_json, body_md, created_by, review_status,
  repo_url, repo_fingerprint, repo_provider, repo_owner, repo_name, created_at, updated_at,
  deleted_at, deleted_by
)
SELECT
  note_id, workspace, project, topic, subtopic, tags_json, body_md, created_by, review_status,
  repo_url, repo_fingerprint, repo_provider, repo_owner, repo_name, created_at, updated_at,
  NULL, NULL
FROM notes

-- @split

DROP TABLE notes

-- @split

ALTER TABLE notes_v3 RENAME TO notes

-- @split

CREATE UNIQUE INDEX uq_notes_scope_live
  ON notes(workspace, project, topic, subtopic)
  WHERE deleted_at IS NULL

-- @split

CREATE INDEX IF NOT EXISTS idx_notes_repo_url ON notes(repo_url)

-- @split

CREATE INDEX IF NOT EXISTS idx_notes_repo_fp ON notes(repo_fingerprint)

-- @split

CREATE INDEX IF NOT EXISTS idx_notes_owner_repo ON notes(repo_owner, repo_name)

-- @split

CREATE INDEX IF NOT EXISTS idx_notes_ws_proj ON notes(workspace, project)

-- @split

CREATE TABLE IF NOT EXISTS accounts (
  account_id   INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL CHECK (role IN ('engineer', 'tech_lead')),
  workspaces   TEXT,
  revoked_at   TEXT
)

-- @split

PRAGMA foreign_keys = ON
