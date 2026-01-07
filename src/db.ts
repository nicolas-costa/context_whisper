/**
 * Database Module - Backward Compatible API
 * 
 * This module provides backward compatibility with the original API
 * while using the new adapter-based architecture internally.
 * 
 * For new code, prefer using the adapters directly from ./db/adapters/
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Re-export types from adapters
export type { Note, NoteLink, SearchResult } from './db/adapters/interface.js';
import type { Note, NoteLink, SearchResult } from './db/adapters/interface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let dbInstance: Database.Database | null = null;

/**
 * Open SQLite database and load sqlite-vec extension
 * @deprecated Use createDatabaseAdapter from db/factory.ts for multi-database support
 */
export function openDB(dbPath: string, vecLibPath?: string): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const db = new Database(dbPath);
  
  // Configure SQLite pragmas first
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  
  // Load sqlite-vec extension - REQUIRED for RAG functionality
  if (!vecLibPath) {
    throw new Error('sqlite-vec extension not found. Vector search is REQUIRED for RAG. Run: npm install sqlite-vec');
  }

  try {
    db.loadExtension(vecLibPath);
    // Verify extension is loaded by attempting to use vec0
    try {
      // Try creating a test virtual table to ensure vec0 is actually available
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _vec_init_test USING vec0(id INTEGER PRIMARY KEY, embedding FLOAT[384])');
      db.exec('DROP TABLE IF EXISTS _vec_init_test');
    } catch (verifyError) {
      const verifyMsg = verifyError instanceof Error ? verifyError.message : String(verifyError);
      if (verifyMsg.includes('no such module') && (verifyMsg.includes('vec0') || verifyMsg.includes('cev0'))) {
        throw new Error(`sqlite-vec extension loaded but vec0 module not available. Extension may be corrupted or incompatible. Path: ${vecLibPath}`);
      }
      // Other errors might be okay (e.g., table already exists)
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[context-whisper] ERROR: Failed to load sqlite-vec extension from ${vecLibPath}:`, errorMsg);
    console.error(`[context-whisper] Vector search is REQUIRED for RAG functionality.`);
    console.error(`[context-whisper] Please ensure sqlite-vec is properly installed: npm install sqlite-vec`);
    throw error;
  }

  dbInstance = db;
  return db;
}

/**
 * Initialize database schema
 * All statements in schema.sql are idempotent (IF NOT EXISTS, INSERT OR IGNORE)
 * @deprecated Use adapter.initSchema() for multi-database support
 */
export function initSchema(db: Database.Database): void {
  const schemaPath = join(__dirname, '..', 'sql', 'sqlite', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  
  // Split schema into statements and execute individually to handle vec0 gracefully
  const statements = schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'));
  
  for (const statement of statements) {
    try {
      // Skip vec0 virtual table creation if module is not available
      if (statement.includes('CREATE VIRTUAL TABLE') && statement.includes('vec0')) {
        // Try to verify vec0 is available first
        try {
          db.exec('SELECT 1');
          // If we get here, try creating the table
          db.exec(statement + ';');
        } catch (vecError) {
          const vecErrorMsg = vecError instanceof Error ? vecError.message : String(vecError);
          if (vecErrorMsg.includes('no such module') && (vecErrorMsg.includes('vec0') || vecErrorMsg.includes('cev0'))) {
            // This should not happen if extension was loaded correctly
            console.error(`[context-whisper] ERROR: vec0 module not available. Vector search is required for RAG.`);
            console.error(`[context-whisper] Please ensure sqlite-vec extension is properly loaded.`);
            throw new Error('vec0 module is required but not available. Vector search is essential for RAG.');
          }
          throw vecError;
        }
      } else {
        db.exec(statement + ';');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      
      // Handle migration errors (e.g., duplicate column name)
      if (errorMsg.includes('duplicate column name')) {
        // Ignore this error, it means the column already exists
        continue;
      }

      // If vec0 module is not available, fail - this is critical
      if (errorMsg.includes('no such module') && (errorMsg.includes('vec0') || errorMsg.includes('cev0'))) {
        console.error(`[context-whisper] ERROR: vec0 module not available. Vector search is required for RAG.`);
        console.error(`[context-whisper] Please ensure sqlite-vec extension is properly loaded.`);
        throw new Error('vec0 module is required but not available. Vector search is essential for RAG.');
      }
      // Re-throw other errors
      throw error;
    }
  }
}

/**
 * Upsert a note into the database
 * @deprecated Use adapter.relational.upsertNote() for multi-database support
 */
export function upsertNote(
  db: Database.Database,
  workspace: string,
  project: string,
  topic: string,
  subtopic: string | null,
  tagsJson: string | null,
  bodyMd: string,
  createdBy: string | null,
  reviewStatus: string = 'DRAFT',
  repoUrl?: string | null,
  repoFingerprint?: string | null,
  repoProvider?: string | null,
  repoOwner?: string | null,
  repoName?: string | null
): number {
  // Normalize subtopic: NULL becomes empty string for UNIQUE constraint compatibility
  const normalizedSubtopic = subtopic || '';
  
  const stmt = db.prepare(`
    INSERT INTO notes (workspace, project, topic, subtopic, tags_json, body_md, created_by, review_status,
                       repo_url, repo_fingerprint, repo_provider, repo_owner, repo_name)
    VALUES (:workspace, :project, :topic, :subtopic, :tags_json, :body_md, :created_by, COALESCE(:review_status, 'DRAFT'),
            :repo_url, :repo_fingerprint, :repo_provider, :repo_owner, :repo_name)
    ON CONFLICT(workspace, project, topic, subtopic)
    DO UPDATE SET
      tags_json=excluded.tags_json,
      body_md=excluded.body_md,
      created_by=excluded.created_by,
      review_status=excluded.review_status,
      repo_url=excluded.repo_url,
      repo_fingerprint=excluded.repo_fingerprint,
      repo_provider=excluded.repo_provider,
      repo_owner=excluded.repo_owner,
      repo_name=excluded.repo_name,
      updated_at=datetime('now')
  `);

  const result = stmt.run({
    workspace,
    project,
    topic,
    subtopic: normalizedSubtopic,
    tags_json: tagsJson,
    body_md: bodyMd,
    created_by: createdBy || null,
    review_status: reviewStatus,
    repo_url: repoUrl || null,
    repo_fingerprint: repoFingerprint || null,
    repo_provider: repoProvider || null,
    repo_owner: repoOwner || null,
    repo_name: repoName || null,
  }) as { lastInsertRowid: number | bigint; changes: number };

  // If it was an update, get the existing note_id
  if (result.changes === 0) {
    const existing = getNote(db, workspace, project, topic, subtopic);
    const existingId = existing?.note_id ?? result.lastInsertRowid;
    // Ensure we return an integer (handle both number and bigint)
    const noteId = typeof existingId === 'bigint' ? Number(existingId) : existingId;
    return Math.floor(Number(noteId));
  }

  // Ensure we return an integer (handle both number and bigint)
  const noteId = typeof result.lastInsertRowid === 'bigint' ? Number(result.lastInsertRowid) : result.lastInsertRowid;
  return Math.floor(Number(noteId));
}

/**
 * Upsert repo path mapping (for resilience to moves/reclones)
 * @deprecated Use adapter.relational.upsertRepoPath() for multi-database support
 */
export function upsertRepoPath(
  db: Database.Database,
  repoFingerprint: string,
  localPath: string
): void {
  const stmt = db.prepare(`
    INSERT INTO repo_paths (repo_fingerprint, local_path, last_seen_at)
    VALUES (:repo_fingerprint, :local_path, datetime('now'))
    ON CONFLICT(repo_fingerprint, local_path)
    DO UPDATE SET last_seen_at=datetime('now')
  `);

  stmt.run({
    repo_fingerprint: repoFingerprint,
    local_path: localPath,
  });
}

/**
 * Upsert embedding vector for a note
 * Note: vec0 virtual tables don't support ON CONFLICT, so we DELETE then INSERT
 * @deprecated Use adapter.vector.upsertVector() for multi-database support
 */
export function upsertVector(
  db: Database.Database,
  noteId: number | bigint,
  embedding: Float32Array
): void {
  // Ensure noteId is an integer (vec0 requires integer primary keys)
  // Handle both number and bigint types
  const numNoteId = typeof noteId === 'bigint' ? Number(noteId) : noteId;
  let intNoteId: number;
  
  // Force conversion to integer using multiple strategies
  if (Number.isInteger(numNoteId)) {
    intNoteId = numNoteId;
  } else if (Number.isFinite(numNoteId)) {
    intNoteId = Math.floor(numNoteId);
  } else {
    throw new Error(`Invalid note_id: ${noteId} (${typeof noteId}). Must be a finite number.`);
  }
  
  // Validate it's a safe integer and positive
  if (!Number.isSafeInteger(intNoteId) || intNoteId <= 0 || intNoteId > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid note_id: ${intNoteId}. Must be a safe positive integer (1-${Number.MAX_SAFE_INTEGER}).`);
  }
  
  // Convert Float32Array to Buffer without copying
  const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

  // vec0 doesn't support ON CONFLICT, so we need to DELETE then INSERT
  const deleteStmt = db.prepare('DELETE FROM note_vectors WHERE note_id = ?');
  deleteStmt.run(intNoteId);
  
  // Force to 32-bit signed integer (bitwise OR with 0 ensures integer type)
  const finalNoteId = intNoteId | 0;
  
  // Verify it's still a valid integer after bitwise operation
  if (!Number.isInteger(finalNoteId) || finalNoteId <= 0) {
    throw new Error(`Failed to ensure integer type: ${intNoteId} -> ${finalNoteId}`);
  }
  
  // sqlite-vec requires strict INTEGER type for primary key
  // The vec0 virtual table requires the INTEGER to be a literal in the SQL query,
  // not a bound parameter. We use db.exec() with a raw SQL string containing
  // the integer literal and hex blob literal.
  
  // Validate finalNoteId is safe to embed in SQL (no SQL injection risk)
  if (!Number.isSafeInteger(finalNoteId) || finalNoteId <= 0) {
    throw new Error(`Cannot insert unsafe integer: ${finalNoteId}`);
  }
  
  // Convert buffer to hex blob literal for SQL
  const hexBlob = buffer.toString('hex');
  
  // Use db.exec with raw SQL containing integer literal and hex blob
  // This ensures the integer is treated as a literal INTEGER type by SQLite/vec0
  const insertSql = `INSERT INTO note_vectors(note_id, embedding) VALUES (${finalNoteId}, x'${hexBlob}')`;
  
  db.exec(insertSql);
}

/**
 * Get a note by its unique key
 * @deprecated Use adapter.relational.getNote() for multi-database support
 */
export function getNote(
  db: Database.Database,
  workspace: string,
  project: string,
  topic: string,
  subtopic?: string | null
): Note | null {
  // Normalize subtopic: NULL becomes empty string for consistency
  const normalizedSubtopic = subtopic || '';
  
  const stmt = db.prepare(`
    SELECT *
    FROM notes
    WHERE workspace=:ws AND project=:project AND topic=:topic AND subtopic=:subtopic
    LIMIT 1
  `);

  const result = stmt.get({
    ws: workspace,
    project,
    topic,
    subtopic: normalizedSubtopic,
  }) as Note | undefined;

  return result || null;
}

/**
 * Get a note by its numeric ID
 * @deprecated Use adapter.relational.getNoteById() for multi-database support
 */
export function getNoteById(
  db: Database.Database,
  noteId: number
): Note | null {
  const stmt = db.prepare(`
    SELECT *
    FROM notes
    WHERE note_id = ?
    LIMIT 1
  `);

  const result = stmt.get(noteId) as Note | undefined;
  return result || null;
}

/**
 * Update note metadata (topic/subtopic/review_status) by note_id.
 * IMPORTANT: subtopic is stored as '' (empty string) for UNIQUE constraint compatibility.
 * @deprecated Use adapter.relational.updateNoteMeta() for multi-database support
 */
export function updateNoteMeta(
  db: Database.Database,
  noteId: number,
  topic: string,
  subtopic: string | null,
  reviewStatus: 'DRAFT' | 'APPROVED'
): Note | null {
  const normalizedSubtopic = subtopic || '';

  const stmt = db.prepare(`
    UPDATE notes
    SET topic = :topic,
        subtopic = :subtopic,
        review_status = :review_status,
        updated_at = datetime('now')
    WHERE note_id = :note_id
  `);

  const result = stmt.run({
    note_id: noteId,
    topic,
    subtopic: normalizedSubtopic,
    review_status: reviewStatus,
  }) as { changes: number };

  if (!result.changes) return null;

  return getNoteById(db, noteId);
}

/**
 * Search notes using vector similarity (KNN)
 * @deprecated Use adapter.searchNotes() for multi-database support
 */
export function searchNotes(
  db: Database.Database,
  queryVector: Float32Array,
  workspace?: string | null,
  project?: string | null,
  topK: number = 5,
  tags?: string[] | null,
  reviewStatus?: string | null,
  repoFingerprint?: string | null,
  repoUrl?: string | null
): SearchResult[] {
  const buffer = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);

  // Build WHERE conditions for notes table
  const noteConditions: string[] = [];
  const params: any[] = [];

  // Prioritize repo_fingerprint if available
  if (repoFingerprint) {
    noteConditions.push('n.repo_fingerprint = ?');
    params.push(repoFingerprint);
  } else if (repoUrl) {
    noteConditions.push('n.repo_url = ?');
    params.push(repoUrl);
  }

  if (workspace) {
    noteConditions.push('n.workspace = ?');
    params.push(workspace);
  }

  if (project) {
    noteConditions.push('n.project = ?');
    params.push(project);
  }

  if (tags && tags.length > 0) {
    // SQLite JSON support - check if tags_json contains any of the requested tags
    const tagConditions: string[] = [];
    tags.forEach((tag) => {
      tagConditions.push(`json_extract(n.tags_json, '$') LIKE ?`);
      params.push(`%"${tag}"%`);
    });
    noteConditions.push(`(${tagConditions.join(' OR ')})`);
  }

  if (reviewStatus) {
    noteConditions.push('n.review_status = ?');
    params.push(reviewStatus);
  }

  // sqlite-vec requires 'k = ?' constraint - use subquery approach
  // Format: SELECT ... FROM (SELECT ... FROM note_vectors WHERE embedding MATCH ? AND k = ?) ...
  const whereClause = noteConditions.length > 0 ? `WHERE ${noteConditions.join(' AND ')}` : '';

  // sqlite-vec KNN query: must have 'k = ?' constraint in WHERE clause
  // Using subquery to isolate the KNN search and then join with notes
  // Note: sqlite-vec requires positional parameters for MATCH and k
  let query = `
    SELECT
      n.note_id, n.workspace, n.project, n.topic, n.subtopic,
      n.tags_json, n.body_md, n.created_by, n.review_status,
      n.repo_url, n.repo_fingerprint, n.repo_provider, n.repo_owner, n.repo_name,
      n.created_at, n.updated_at,
      v.distance
    FROM (
      SELECT note_id, distance
      FROM note_vectors
      WHERE embedding MATCH ? AND k = ?
    ) AS v
    JOIN notes n ON v.note_id = n.note_id
    ${whereClause}
    ORDER BY v.distance
  `;

  // Prepare statement with positional parameters
  // First two params are for the subquery (embedding MATCH and k)
  const finalParams: any[] = [buffer, topK, ...params];

  const stmt = db.prepare(query);
  const results = stmt.all(...finalParams) as SearchResult[];

  return results;
}

/**
 * List topics for a workspace/project
 * @deprecated Use adapter.relational.listTopics() for multi-database support
 */
export function listTopics(
  db: Database.Database,
  workspace: string,
  project: string
): Array<{ topic: string; subtopic: string | null }> {
  const stmt = db.prepare(`
    SELECT DISTINCT topic, subtopic
    FROM notes
    WHERE workspace=:ws AND project=:project
    ORDER BY topic, subtopic
  `);

  const results = stmt.all({ ws: workspace, project }) as Array<{ topic: string; subtopic: string | null }>;
  
  // Convert empty string back to null for API consistency
  return results.map((r) => ({
    topic: r.topic,
    subtopic: r.subtopic === '' ? null : r.subtopic,
  }));
}

/**
 * Delete a note and its associated vector and links
 * @deprecated Use adapter.relational.deleteNote() for multi-database support
 */
export function deleteNote(
  db: Database.Database,
  workspace: string,
  project: string,
  topic: string,
  subtopic?: string | null
): boolean {
  const note = getNote(db, workspace, project, topic, subtopic);
  if (!note) {
    return false;
  }

  // Ensure note_id is an integer
  const intNoteId = Math.floor(Number(note.note_id));

  // Delete in transaction
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM note_links WHERE note_id = ?').run(intNoteId);
    db.prepare('DELETE FROM note_vectors WHERE note_id = ?').run(intNoteId);
    db.prepare('DELETE FROM notes WHERE note_id = ?').run(intNoteId);
  });

  transaction();
  return true;
}

/**
 * Upsert note links
 * @deprecated Use adapter.relational.upsertNoteLinks() for multi-database support
 */
export function upsertNoteLinks(
  db: Database.Database,
  noteId: number,
  links: Array<Partial<NoteLink>>
): void {
  // Delete existing links for this note
  db.prepare('DELETE FROM note_links WHERE note_id = ?').run(noteId);

  // Insert new links
  if (links.length > 0) {
    const stmt = db.prepare(`
      INSERT INTO note_links (note_id, repo, path, symbol, commit_sha, line_start, line_end, markdown_context, markdown_line)
      VALUES (:note_id, :repo, :path, :symbol, :commit_sha, :line_start, :line_end, :markdown_context, :markdown_line)
    `);

    const insertMany = db.transaction((linksToInsert: Array<Partial<NoteLink>>) => {
      for (const link of linksToInsert) {
        stmt.run({
          note_id: noteId,
          repo: link.repo || null,
          path: link.path || null,
          symbol: link.symbol || null,
          commit_sha: link.commit_sha || null,
          line_start: link.line_start || null,
          line_end: link.line_end || null,
          markdown_context: link.markdown_context || null,
          markdown_line: link.markdown_line || null,
        });
      }
    });

    insertMany(links);
  }
}

/**
 * Get links for a note
 * @deprecated Use adapter.relational.getNoteLinks() for multi-database support
 */
export function getNoteLinks(db: Database.Database, noteId: number): NoteLink[] {
  const stmt = db.prepare(`
    SELECT *
    FROM note_links
    WHERE note_id = ?
    ORDER BY markdown_line, line_start
  `);
  return stmt.all(noteId) as NoteLink[];
}

/**
 * Get schema version
 * @deprecated Use adapter.relational.getSchemaVersion() for multi-database support
 */
export function getSchemaVersion(db: Database.Database): number {
  try {
    const result = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number } | undefined;
    return result?.version || 1;
  } catch {
    return 1;
  }
}
