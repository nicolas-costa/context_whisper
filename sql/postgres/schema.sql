-- PostgreSQL Schema for context-whisper
-- Uses pgvector extension for vector search

/* Enable pgvector extension */
CREATE EXTENSION IF NOT EXISTS vector;

/* Schema versioning table */
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

/* Main technical notes table (scoped by workspace/project) */
CREATE TABLE IF NOT EXISTS notes (
  note_id       SERIAL PRIMARY KEY,
  workspace     TEXT NOT NULL,            -- = owner
  project       TEXT NOT NULL,            -- = repo
  topic         TEXT NOT NULL,
  subtopic      TEXT NOT NULL DEFAULT '', -- Empty string for UNIQUE constraint compatibility
  tags_json     TEXT,                     -- JSON string (["backend","auth"])
  body_md       TEXT NOT NULL,            -- Markdown content
  created_by    TEXT,
  review_status TEXT DEFAULT 'DRAFT',     -- DRAFT | APPROVED
  
  /* Repository traceability */
  repo_url         TEXT,
  repo_fingerprint TEXT,
  repo_provider    TEXT,                  -- github|gitlab|bitbucket|other
  repo_owner       TEXT,
  repo_name        TEXT,
  
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace, project, topic, subtopic)
);

/* Links for code traceability */
CREATE TABLE IF NOT EXISTS note_links (
  link_id      SERIAL PRIMARY KEY,
  note_id      INTEGER NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
  repo         TEXT,
  path         TEXT,
  symbol       TEXT,
  commit_sha   TEXT,
  line_start   INTEGER,
  line_end     INTEGER,
  markdown_context TEXT,
  markdown_line    INTEGER
);

/* Cache of local paths -> resilience to moves/reclones */
CREATE TABLE IF NOT EXISTS repo_paths (
  repo_fingerprint TEXT NOT NULL,
  local_path TEXT NOT NULL,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(repo_fingerprint, local_path)
);

/* Vector storage table using pgvector */
CREATE TABLE IF NOT EXISTS note_vectors (
  note_id    INTEGER PRIMARY KEY REFERENCES notes(note_id) ON DELETE CASCADE,
  embedding  vector(384)  -- MiniLM-L6-v2 output dimension
);

/* Indexes for better performance */
CREATE INDEX IF NOT EXISTS idx_note_links_note_id ON note_links(note_id);
CREATE INDEX IF NOT EXISTS idx_notes_repo_url ON notes(repo_url);
CREATE INDEX IF NOT EXISTS idx_notes_repo_fp ON notes(repo_fingerprint);
CREATE INDEX IF NOT EXISTS idx_notes_owner_repo ON notes(repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_notes_ws_proj ON notes(workspace, project);
CREATE INDEX IF NOT EXISTS idx_repo_paths_fp ON repo_paths(repo_fingerprint);

/* Vector similarity index using IVFFlat (good for medium-sized datasets) */
/* For larger datasets, consider HNSW: CREATE INDEX ... USING hnsw (embedding vector_cosine_ops) */
CREATE INDEX IF NOT EXISTS idx_note_vectors_embedding ON note_vectors 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

/* Function to update updated_at timestamp */
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ language 'plpgsql';

/* Trigger to auto-update updated_at */
DROP TRIGGER IF EXISTS update_notes_updated_at ON notes;
CREATE TRIGGER update_notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

/* Insert initial schema version */
INSERT INTO schema_version (version) VALUES (2) ON CONFLICT (version) DO NOTHING;
