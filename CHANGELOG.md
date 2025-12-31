# Changelog

All notable changes to this project will be documented in this file.

## [1.2.0] - 2025-12-31

### Added
- **Web UI for Notes**: Introduced a local web interface for browsing and reading technical notes.
  - New tool `serve_notes_ui` starts a local server and provides a URL for the agent/user.
  - New tool `stop_notes_server` manually stops the server.
  - Automatic shutdown after 10 minutes of inactivity to preserve resources.
  - Markdown rendering with code highlighting support.
  - Full-text search and topic navigation directly in the browser.

### Fixed
- **Web UI API contract**: `/api/topics`, `/api/search`, and `/api/note` now return a consistent `{ ok: true|false, ... }` payload so the UI renders results instead of silently ignoring successful responses.
- **Global search note navigation**: Clicking a search result from “Search all projects” now loads the correct note by passing `workspace/project` to `/api/note` (previously caused 404 due to context mismatch).

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
