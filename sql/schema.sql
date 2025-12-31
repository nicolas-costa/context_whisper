PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

/* Schema versioning table */
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

/* Tabela principal de notas técnicas (com escopo lógico por workspace/project) */
CREATE TABLE IF NOT EXISTS notes (
  note_id       INTEGER PRIMARY KEY,
  workspace     TEXT NOT NULL,            -- = owner
  project       TEXT NOT NULL,            -- = repo
  topic         TEXT NOT NULL,
  subtopic      TEXT,
  tags_json     TEXT,                     -- JSON string (["backend","auth"])
  body_md       TEXT NOT NULL,            -- conteúdo em markdown (doc técnica)
  created_by    TEXT,
  review_status TEXT DEFAULT 'DRAFT',     -- DRAFT | APPROVED
  
  /* rastreabilidade do repositório */
  repo_url         TEXT,
  repo_fingerprint TEXT,
  repo_provider    TEXT,                  -- github|gitlab|bitbucket|other
  repo_owner       TEXT,
  repo_name        TEXT,
  
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace, project, topic, subtopic)
);

/* Links para rastreabilidade com código (opcional, mas útil) */
CREATE TABLE IF NOT EXISTS note_links (
  note_id    INTEGER NOT NULL,
  repo       TEXT,
  path       TEXT,
  symbol     TEXT,
  commit_sha TEXT,
  line_start INTEGER,
  line_end   INTEGER,
  
  /* Contexto no markdown (para links inline) */
  markdown_context TEXT,
  markdown_line    INTEGER,
  
  FOREIGN KEY(note_id) REFERENCES notes(note_id) ON DELETE CASCADE
);

/* Cache de paths locais -> resiliência a moves/reclones */
CREATE TABLE IF NOT EXISTS repo_paths (
  repo_fingerprint TEXT NOT NULL,
  local_path TEXT NOT NULL,
  last_seen_at TEXT DEFAULT (datetime('now')),
  UNIQUE(repo_fingerprint, local_path)
);

/* Índice para melhor performance em buscas por note_id */
CREATE INDEX IF NOT EXISTS idx_note_links_note_id ON note_links(note_id);

/* Índices úteis para notas */
CREATE INDEX IF NOT EXISTS idx_notes_repo_url ON notes(repo_url);
CREATE INDEX IF NOT EXISTS idx_notes_repo_fp ON notes(repo_fingerprint);
CREATE INDEX IF NOT EXISTS idx_notes_owner_repo ON notes(repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_notes_ws_proj ON notes(workspace, project);
CREATE INDEX IF NOT EXISTS idx_repo_paths_fp ON repo_paths(repo_fingerprint);

/* Índice vetorial embutido (sqlite-vec).
   Ajuste a dimensão (FLOAT[384]) ao encoder escolhido.
   MiniLM-L6-v2 (Xenova) → 384 dims (normalize)
*/
CREATE VIRTUAL TABLE IF NOT EXISTS note_vectors USING vec0(
  note_id   INTEGER PRIMARY KEY,
  embedding FLOAT[384]
);

/* Insert initial schema version if not exists */
INSERT OR IGNORE INTO schema_version (version) VALUES (1);

/* Migrations - Try to add columns if they don't exist (handled by code to ignore duplicate column error) */
/* These are for existing databases that were created before these columns were added to CREATE TABLE */
ALTER TABLE note_links ADD COLUMN markdown_context TEXT;
ALTER TABLE note_links ADD COLUMN markdown_line INTEGER;
