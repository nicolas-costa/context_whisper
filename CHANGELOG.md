# Changelog

All notable changes to this project will be documented in this file.

## [1.4.0] - 2026-01-07

### Added
- **Multi-database support**: SQLite, PostgreSQL, MySQL for relational data; sqlite-vec, pgvector, Qdrant for vectors.
- **Flexible combinations**: Any relational DB can use Qdrant as vector store (MySQL/PostgreSQL/SQLite + Qdrant).
- **Environment-based configuration**: Configure multiple database environments via environment variables (e.g., `ACME_CORP_PG_HOST`, `STARTUP_XYZ_MYSQL_HOST`, `LOCAL_SQLITE_PATH`).
- **Database adapters architecture**: New modular adapter system for relational and vector databases.
- **Qdrant integration**: Support for Qdrant as external vector store (useful when native extensions aren't available or you prefer managed vector search).
- **PostgreSQL adapter**: Full support for PostgreSQL with pgvector extension for vector operations.
- **MySQL adapter**: Support for MySQL as relational store (use with Qdrant for vector operations).

### Changed
- **Configuration system**: Enhanced `config.ts` to support multi-environment database configurations.
- **Schema migrations**: Separate migration files for each database type (`sql/sqlite/`, `sql/postgres/`, `sql/mysql/`).
- **Package description**: Updated to reflect multi-database capabilities.

### Backward Compatibility
- **Default behavior**: Without any environment configuration, the server uses SQLite + sqlite-vec (same as v1.3.0).
- **Legacy API**: The `db.ts` module maintains backward-compatible functions (marked as deprecated).
- **Environment variables**: Existing `CONTEXT_WHISPER_DB_PATH` and `CONTEXT_WHISPER_VEC_LIB` continue to work.

### Configuration Examples

Ambientes representam bancos locais ou corporativos (ex: `LOCAL_`, `ACME_CORP_`, `STARTUP_XYZ_`).

#### Single SQLite (default, backward compatible)
```bash
# No configuration needed - uses ~/.local/share/context-whisper/meta.sqlite
```

#### PostgreSQL + pgvector (empresa com infra própria)
```bash
export ACME_CORP_PG_HOST=db.acme-corp.internal
export ACME_CORP_PG_PORT=5432
export ACME_CORP_PG_USER=whisper_user
export ACME_CORP_PG_PASSWORD=secret123
export ACME_CORP_PG_DATABASE=context_whisper
```

#### MySQL + Qdrant (empresa sem vetores nativos)
```bash
export STARTUP_XYZ_MYSQL_HOST=mysql.startup-xyz.com
export STARTUP_XYZ_MYSQL_USER=app_user
export STARTUP_XYZ_MYSQL_PASSWORD=secure_pass
export STARTUP_XYZ_MYSQL_DATABASE=tech_docs
export STARTUP_XYZ_QDRANT_HOST=qdrant.startup-xyz.com
export STARTUP_XYZ_QDRANT_PORT=6333
```

#### SQLite local + Qdrant Cloud
```bash
export LOCAL_SQLITE_PATH=~/.local/share/context-whisper/notes.sqlite
export LOCAL_QDRANT_HOST=abc123.qdrant.cloud
export LOCAL_QDRANT_API_KEY=your_api_key
export LOCAL_QDRANT_HTTPS=true
export LOCAL_VECTOR_STORE=qdrant
```

## [1.3.0] - 2025-12-31

### Added
- **Web UI editing**: Edit note `topic`, `subtopic`, and `review_status` directly in the browser header (with Save button).

### Changed
- **Workspace derivation**: Removed `--workspace` override; workspace is derived from git remote `repo_url` (no silent "default").

### Fixed
- **Web UI API contract**: `/api/topics`, `/api/search`, and `/api/note` return a consistent `{ ok: true|false, ... }` payload (UI no longer ignores successful responses).
- **Global search note navigation**: Clicking results from "Search all projects" loads the correct note by passing `workspace/project` to `/api/note`.
- **Web UI readability**: Note content uses an explicit light background (no dark-theme bleed-through).

## [1.2.0] - 2025-12-31

### Added
- **Web UI for Notes**: Introduced a local web interface for browsing and reading technical notes.
  - New tool `serve_notes_ui` starts a local server and provides a URL for the agent/user.
  - New tool `stop_notes_server` manually stops the server.
  - Automatic shutdown after 10 minutes of inactivity to preserve resources.
  - Markdown rendering with code highlighting support.
  - Full-text search and topic navigation directly in the browser.

## [1.1.0] - 2025-11-30

### Added
- **Inline Code Links**: Support for referencing code directly in markdown notes using the `[text](code:path:lines)` syntax.
  - Links are automatically parsed and stored as structured `NoteLink` entries.
  - Added `markdown_context` and `markdown_line` columns to `note_links` table for precise tracking.
- **Enhanced System Prompt**: Updated system prompt to instruct LLMs on using the new inline link syntax for better documentation.

### Changed
- **Database Schema**: Added fields to `note_links` table to support markdown context tracking.
- **Upsert Logic**: `upsert_note` now parses the `body_md` for code links and merges them with explicitly provided links.
- **Get Note Response**: `get_note` now returns associated links with their markdown context.

## [1.0.0] - 2025-11-21

### Added
- Initial release of Context Whisper MCP Server.
- Vectorized technical notes repository using SQLite + sqlite-vec.
- Semantic search with local embeddings (Xenova/all-MiniLM-L6-v2).
- Automatic context detection (workspace/project) from git repository.
- Tools: `upsert_note`, `get_note`, `search_notes`, `list_topics`, `delete_note`.
- Health check and diagnostic tools.
