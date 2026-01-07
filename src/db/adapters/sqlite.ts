/**
 * SQLite Adapter for context-whisper
 * Uses better-sqlite3 for relational data and sqlite-vec for vector search
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  RelationalAdapter,
  VectorAdapter,
  DatabaseAdapter,
  Note,
  NoteLink,
  SearchResult,
  SQLiteConfig,
} from './interface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * SQLite Relational Adapter
 */
export class SQLiteRelationalAdapter implements RelationalAdapter {
  readonly type = 'sqlite' as const;
  private db: Database.Database;
  private schemaPath: string;

  constructor(db: Database.Database) {
    this.db = db;
    // Schema is in sql/sqlite/schema.sql relative to project root
    this.schemaPath = join(__dirname, '..', '..', '..', 'sql', 'sqlite', 'schema.sql');
  }

  async isHealthy(): Promise<boolean> {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  async initSchema(): Promise<void> {
    const schema = readFileSync(this.schemaPath, 'utf-8');
    
    // Split schema into statements and execute individually
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    for (const statement of statements) {
      try {
        // Skip vec0 virtual table - handled by vector adapter
        if (statement.includes('CREATE VIRTUAL TABLE') && statement.includes('vec0')) {
          continue;
        }
        this.db.exec(statement + ';');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // Ignore duplicate column errors (from migrations)
        if (errorMsg.includes('duplicate column name')) {
          continue;
        }
        throw error;
      }
    }
  }

  async getSchemaVersion(): Promise<number> {
    try {
      const result = this.db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number } | undefined;
      return result?.version || 1;
    } catch {
      return 1;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async upsertNote(params: {
    workspace: string;
    project: string;
    topic: string;
    subtopic: string | null;
    tagsJson: string | null;
    bodyMd: string;
    createdBy: string | null;
    reviewStatus: string;
    repoUrl?: string | null;
    repoFingerprint?: string | null;
    repoProvider?: string | null;
    repoOwner?: string | null;
    repoName?: string | null;
  }): Promise<number> {
    const normalizedSubtopic = params.subtopic || '';
    
    const stmt = this.db.prepare(`
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
      workspace: params.workspace,
      project: params.project,
      topic: params.topic,
      subtopic: normalizedSubtopic,
      tags_json: params.tagsJson,
      body_md: params.bodyMd,
      created_by: params.createdBy || null,
      review_status: params.reviewStatus,
      repo_url: params.repoUrl || null,
      repo_fingerprint: params.repoFingerprint || null,
      repo_provider: params.repoProvider || null,
      repo_owner: params.repoOwner || null,
      repo_name: params.repoName || null,
    }) as { lastInsertRowid: number | bigint; changes: number };

    // If it was an update, get the existing note_id
    if (result.changes === 0) {
      const existing = await this.getNote(params.workspace, params.project, params.topic, params.subtopic);
      const existingId = existing?.note_id ?? result.lastInsertRowid;
      const noteId = typeof existingId === 'bigint' ? Number(existingId) : existingId;
      return Math.floor(Number(noteId));
    }

    const noteId = typeof result.lastInsertRowid === 'bigint' ? Number(result.lastInsertRowid) : result.lastInsertRowid;
    return Math.floor(Number(noteId));
  }

  async getNote(
    workspace: string,
    project: string,
    topic: string,
    subtopic?: string | null
  ): Promise<Note | null> {
    const normalizedSubtopic = subtopic || '';
    
    const stmt = this.db.prepare(`
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

  async getNoteById(noteId: number): Promise<Note | null> {
    const stmt = this.db.prepare(`
      SELECT *
      FROM notes
      WHERE note_id = ?
      LIMIT 1
    `);

    const result = stmt.get(noteId) as Note | undefined;
    return result || null;
  }

  async updateNoteMeta(
    noteId: number,
    topic: string,
    subtopic: string | null,
    reviewStatus: 'DRAFT' | 'APPROVED'
  ): Promise<Note | null> {
    const normalizedSubtopic = subtopic || '';

    const stmt = this.db.prepare(`
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

    return this.getNoteById(noteId);
  }

  async deleteNote(
    workspace: string,
    project: string,
    topic: string,
    subtopic?: string | null
  ): Promise<boolean> {
    const note = await this.getNote(workspace, project, topic, subtopic);
    if (!note) {
      return false;
    }

    const intNoteId = Math.floor(Number(note.note_id));

    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM note_links WHERE note_id = ?').run(intNoteId);
      this.db.prepare('DELETE FROM note_vectors WHERE note_id = ?').run(intNoteId);
      this.db.prepare('DELETE FROM notes WHERE note_id = ?').run(intNoteId);
    });

    transaction();
    return true;
  }

  async listTopics(
    workspace: string,
    project: string
  ): Promise<Array<{ topic: string; subtopic: string | null }>> {
    const stmt = this.db.prepare(`
      SELECT DISTINCT topic, subtopic
      FROM notes
      WHERE workspace=:ws AND project=:project
      ORDER BY topic, subtopic
    `);

    const results = stmt.all({ ws: workspace, project }) as Array<{ topic: string; subtopic: string | null }>;
    
    return results.map((r) => ({
      topic: r.topic,
      subtopic: r.subtopic === '' ? null : r.subtopic,
    }));
  }

  async upsertNoteLinks(
    noteId: number,
    links: Array<Partial<NoteLink>>
  ): Promise<void> {
    this.db.prepare('DELETE FROM note_links WHERE note_id = ?').run(noteId);

    if (links.length > 0) {
      const stmt = this.db.prepare(`
        INSERT INTO note_links (note_id, repo, path, symbol, commit_sha, line_start, line_end, markdown_context, markdown_line)
        VALUES (:note_id, :repo, :path, :symbol, :commit_sha, :line_start, :line_end, :markdown_context, :markdown_line)
      `);

      const insertMany = this.db.transaction((linksToInsert: Array<Partial<NoteLink>>) => {
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

  async getNoteLinks(noteId: number): Promise<NoteLink[]> {
    const stmt = this.db.prepare(`
      SELECT *
      FROM note_links
      WHERE note_id = ?
      ORDER BY markdown_line, line_start
    `);
    return stmt.all(noteId) as NoteLink[];
  }

  async upsertRepoPath(
    repoFingerprint: string,
    localPath: string
  ): Promise<void> {
    const stmt = this.db.prepare(`
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
   * Get underlying database instance (for combined adapter use)
   */
  getDatabase(): Database.Database {
    return this.db;
  }
}

/**
 * SQLite Vector Adapter (using sqlite-vec extension)
 */
export class SQLiteVectorAdapter implements VectorAdapter {
  readonly type = 'sqlite-vec' as const;
  private db: Database.Database;
  private schemaPath: string;

  constructor(db: Database.Database) {
    this.db = db;
    this.schemaPath = join(__dirname, '..', '..', '..', 'sql', 'sqlite', 'schema.sql');
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Try to use vec0 module to verify it's loaded
      this.db.exec('SELECT 1 FROM (SELECT vec_version()) LIMIT 1');
      return true;
    } catch {
      // Fallback: check if note_vectors table exists and is accessible
      try {
        const tableCheck = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='note_vectors'").get();
        if (tableCheck) {
          this.db.prepare('SELECT COUNT(*) FROM note_vectors LIMIT 1').get();
          return true;
        }
      } catch {
        return false;
      }
      return false;
    }
  }

  async initSchema(): Promise<void> {
    // Create vec0 virtual table if it doesn't exist
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS note_vectors USING vec0(
          note_id   INTEGER PRIMARY KEY,
          embedding FLOAT[384]
        )
      `);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (errorMsg.includes('no such module') && (errorMsg.includes('vec0') || errorMsg.includes('cev0'))) {
        throw new Error('vec0 module is required but not available. Vector search is essential for RAG.');
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    // Database is shared with relational adapter, don't close here
  }

  async upsertVector(noteId: number, embedding: Float32Array): Promise<void> {
    const numNoteId = typeof noteId === 'bigint' ? Number(noteId) : noteId;
    let intNoteId: number;
    
    if (Number.isInteger(numNoteId)) {
      intNoteId = numNoteId;
    } else if (Number.isFinite(numNoteId)) {
      intNoteId = Math.floor(numNoteId);
    } else {
      throw new Error(`Invalid note_id: ${noteId}. Must be a finite number.`);
    }
    
    if (!Number.isSafeInteger(intNoteId) || intNoteId <= 0 || intNoteId > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Invalid note_id: ${intNoteId}. Must be a safe positive integer.`);
    }
    
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    // vec0 doesn't support ON CONFLICT, so DELETE then INSERT
    const deleteStmt = this.db.prepare('DELETE FROM note_vectors WHERE note_id = ?');
    deleteStmt.run(intNoteId);
    
    const finalNoteId = intNoteId | 0;
    
    if (!Number.isInteger(finalNoteId) || finalNoteId <= 0) {
      throw new Error(`Failed to ensure integer type: ${intNoteId} -> ${finalNoteId}`);
    }
    
    // Convert buffer to hex blob literal for SQL
    const hexBlob = buffer.toString('hex');
    
    // Use db.exec with raw SQL containing integer literal and hex blob
    const insertSql = `INSERT INTO note_vectors(note_id, embedding) VALUES (${finalNoteId}, x'${hexBlob}')`;
    
    this.db.exec(insertSql);
  }

  async deleteVector(noteId: number): Promise<void> {
    const intNoteId = Math.floor(Number(noteId));
    this.db.prepare('DELETE FROM note_vectors WHERE note_id = ?').run(intNoteId);
  }

  async searchVectors(
    queryVector: Float32Array,
    topK: number,
    filter?: { noteIds?: number[] }
  ): Promise<Array<{ noteId: number; distance: number }>> {
    const buffer = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);

    // sqlite-vec KNN query: must have 'k = ?' constraint
    let query = `
      SELECT note_id, distance
      FROM note_vectors
      WHERE embedding MATCH ? AND k = ?
    `;

    const stmt = this.db.prepare(query);
    const results = stmt.all(buffer, topK) as Array<{ note_id: number; distance: number }>;

    // Apply noteIds filter if provided (for post-filtering after relational query)
    let filteredResults = results;
    if (filter?.noteIds && filter.noteIds.length > 0) {
      const noteIdSet = new Set(filter.noteIds);
      filteredResults = results.filter(r => noteIdSet.has(r.note_id));
    }

    return filteredResults.map(r => ({
      noteId: r.note_id,
      distance: r.distance,
    }));
  }
}

/**
 * Combined SQLite Database Adapter
 */
export class SQLiteDatabaseAdapter implements DatabaseAdapter {
  readonly relational: SQLiteRelationalAdapter;
  readonly vector: SQLiteVectorAdapter;
  readonly environmentName: string;
  private db: Database.Database;

  constructor(db: Database.Database, environmentName: string = 'default') {
    this.db = db;
    this.environmentName = environmentName;
    this.relational = new SQLiteRelationalAdapter(db);
    this.vector = new SQLiteVectorAdapter(db);
  }

  async isHealthy(): Promise<{ relational: boolean; vector: boolean }> {
    return {
      relational: await this.relational.isHealthy(),
      vector: await this.vector.isHealthy(),
    };
  }

  async initSchema(): Promise<void> {
    await this.relational.initSchema();
    await this.vector.initSchema();
  }

  async close(): Promise<void> {
    await this.relational.close();
  }

  async searchNotes(
    queryVector: Float32Array,
    options: {
      workspace?: string | null;
      project?: string | null;
      topK?: number;
      tags?: string[] | null;
      reviewStatus?: string | null;
      repoFingerprint?: string | null;
      repoUrl?: string | null;
    }
  ): Promise<SearchResult[]> {
    const buffer = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
    const topK = options.topK || 5;

    // Build WHERE conditions for notes table
    const noteConditions: string[] = [];
    const params: any[] = [];

    if (options.repoFingerprint) {
      noteConditions.push('n.repo_fingerprint = ?');
      params.push(options.repoFingerprint);
    } else if (options.repoUrl) {
      noteConditions.push('n.repo_url = ?');
      params.push(options.repoUrl);
    }

    if (options.workspace) {
      noteConditions.push('n.workspace = ?');
      params.push(options.workspace);
    }

    if (options.project) {
      noteConditions.push('n.project = ?');
      params.push(options.project);
    }

    if (options.tags && options.tags.length > 0) {
      const tagConditions: string[] = [];
      options.tags.forEach((tag) => {
        tagConditions.push(`json_extract(n.tags_json, '$') LIKE ?`);
        params.push(`%"${tag}"%`);
      });
      noteConditions.push(`(${tagConditions.join(' OR ')})`);
    }

    if (options.reviewStatus) {
      noteConditions.push('n.review_status = ?');
      params.push(options.reviewStatus);
    }

    const whereClause = noteConditions.length > 0 ? `WHERE ${noteConditions.join(' AND ')}` : '';

    // Combined query with vector search subquery
    const query = `
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

    const finalParams: any[] = [buffer, topK, ...params];

    const stmt = this.db.prepare(query);
    const results = stmt.all(...finalParams) as SearchResult[];

    return results;
  }
}

/**
 * Open SQLite database and load sqlite-vec extension
 */
export function openSQLiteDatabase(
  config: SQLiteConfig,
  environmentName: string = 'default'
): { db: Database.Database; adapter: SQLiteDatabaseAdapter } {
  const db = new Database(config.path);
  
  // Configure SQLite pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  
  // Load sqlite-vec extension
  if (!config.vecLibPath) {
    throw new Error('sqlite-vec extension not found. Vector search is REQUIRED for RAG.');
  }

  try {
    db.loadExtension(config.vecLibPath);
    // Verify extension is loaded
    try {
      db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _vec_init_test USING vec0(id INTEGER PRIMARY KEY, embedding FLOAT[384])');
      db.exec('DROP TABLE IF EXISTS _vec_init_test');
    } catch (verifyError) {
      const verifyMsg = verifyError instanceof Error ? verifyError.message : String(verifyError);
      if (verifyMsg.includes('no such module') && (verifyMsg.includes('vec0') || verifyMsg.includes('cev0'))) {
        throw new Error(`sqlite-vec extension loaded but vec0 module not available. Path: ${config.vecLibPath}`);
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`[context-whisper] ERROR: Failed to load sqlite-vec extension from ${config.vecLibPath}:`, errorMsg);
    throw error;
  }

  const adapter = new SQLiteDatabaseAdapter(db, environmentName);
  return { db, adapter };
}
