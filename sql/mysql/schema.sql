-- MySQL Schema for context-whisper
-- Note: MySQL does not have native vector support
-- Use Qdrant for vector operations when using MySQL

/* Schema versioning table */
CREATE TABLE IF NOT EXISTS schema_version (
  version INT PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Main technical notes table (scoped by workspace/project) */
CREATE TABLE IF NOT EXISTS notes (
  note_id       INT AUTO_INCREMENT PRIMARY KEY,
  workspace     VARCHAR(255) NOT NULL,    -- = owner
  project       VARCHAR(255) NOT NULL,    -- = repo
  topic         VARCHAR(500) NOT NULL,
  subtopic      VARCHAR(500) NOT NULL DEFAULT '', -- Empty string for UNIQUE constraint compatibility
  tags_json     TEXT,                     -- JSON string (["backend","auth"])
  body_md       LONGTEXT NOT NULL,        -- Markdown content
  created_by    VARCHAR(255),
  review_status VARCHAR(20) DEFAULT 'DRAFT', -- DRAFT | APPROVED
  
  /* Repository traceability */
  repo_url         TEXT,
  repo_fingerprint VARCHAR(255),
  repo_provider    VARCHAR(50),           -- github|gitlab|bitbucket|other
  repo_owner       VARCHAR(255),
  repo_name        VARCHAR(255),
  
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_notes_scope (workspace(100), project(100), topic(200), subtopic(200))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Links for code traceability */
CREATE TABLE IF NOT EXISTS note_links (
  link_id      INT AUTO_INCREMENT PRIMARY KEY,
  note_id      INT NOT NULL,
  repo         TEXT,
  path         TEXT,
  symbol       VARCHAR(255),
  commit_sha   VARCHAR(64),
  line_start   INT,
  line_end     INT,
  markdown_context TEXT,
  markdown_line    INT,
  FOREIGN KEY (note_id) REFERENCES notes(note_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Cache of local paths -> resilience to moves/reclones */
CREATE TABLE IF NOT EXISTS repo_paths (
  repo_fingerprint VARCHAR(255) NOT NULL,
  local_path TEXT NOT NULL,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (repo_fingerprint, local_path(255))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* Indexes for better performance */
CREATE INDEX idx_note_links_note_id ON note_links(note_id);
CREATE INDEX idx_notes_repo_url ON notes(repo_url(255));
CREATE INDEX idx_notes_repo_fp ON notes(repo_fingerprint);
CREATE INDEX idx_notes_owner_repo ON notes(repo_owner, repo_name);
CREATE INDEX idx_notes_ws_proj ON notes(workspace, project);
CREATE INDEX idx_repo_paths_fp ON repo_paths(repo_fingerprint);

/* Insert initial schema version (use INSERT IGNORE for idempotency) */
INSERT IGNORE INTO schema_version (version) VALUES (2);
