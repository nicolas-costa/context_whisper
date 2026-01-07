/**
 * PostgreSQL Adapter for context-whisper
 * Uses pg for relational data and pgvector for vector search
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  RelationalAdapter,
  VectorAdapter,
  DatabaseAdapter,
  Note,
  NoteLink,
  SearchResult,
  PostgresConfig,
} from './interface.js';

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * PostgreSQL Relational Adapter
 */
export class PostgresRelationalAdapter implements RelationalAdapter {
  readonly type = 'postgres' as const;
  private pool: pg.Pool;
  private schemaPath: string;

  constructor(pool: pg.Pool) {
    this.pool = pool;
    this.schemaPath = join(__dirname, '..', '..', '..', 'sql', 'postgres', 'schema.sql');
  }

  async isHealthy(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async initSchema(): Promise<void> {
    const schema = readFileSync(this.schemaPath, 'utf-8');
    
    // PostgreSQL can execute multiple statements at once, but we handle errors
    // Split by semicolons but be careful with functions/triggers
    const statements = this.splitPostgresStatements(schema);
    
    for (const statement of statements) {
      const trimmed = statement.trim();
      if (!trimmed || trimmed.startsWith('--')) continue;
      
      // Skip vector table - handled by vector adapter
      if (trimmed.includes('CREATE TABLE') && trimmed.includes('note_vectors')) {
        continue;
      }
      if (trimmed.includes('CREATE INDEX') && trimmed.includes('note_vectors')) {
        continue;
      }
      
      try {
        await this.pool.query(trimmed);
      } catch (error: any) {
        // Ignore "already exists" errors
        if (error.code === '42P07' || // duplicate_table
            error.code === '42710' || // duplicate_object
            error.code === '42P16' || // invalid_table_definition (for triggers)
            error.message?.includes('already exists')) {
          continue;
        }
        throw error;
      }
    }
  }

  private splitPostgresStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let inFunction = false;
    
    const lines = sql.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      
      // Track function/trigger blocks
      if (trimmedLine.includes('$$')) {
        inFunction = !inFunction;
      }
      
      current += line + '\n';
      
      // End of statement (semicolon outside function block)
      if (trimmedLine.endsWith(';') && !inFunction) {
        statements.push(current.trim());
        current = '';
      }
    }
    
    if (current.trim()) {
      statements.push(current.trim());
    }
    
    return statements;
  }

  async getSchemaVersion(): Promise<number> {
    try {
      const result = await this.pool.query('SELECT MAX(version) as version FROM schema_version');
      return result.rows[0]?.version || 1;
    } catch {
      return 1;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
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
    
    const result = await this.pool.query(`
      INSERT INTO notes (workspace, project, topic, subtopic, tags_json, body_md, created_by, review_status,
                         repo_url, repo_fingerprint, repo_provider, repo_owner, repo_name)
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'DRAFT'), $9, $10, $11, $12, $13)
      ON CONFLICT(workspace, project, topic, subtopic)
      DO UPDATE SET
        tags_json=EXCLUDED.tags_json,
        body_md=EXCLUDED.body_md,
        created_by=EXCLUDED.created_by,
        review_status=EXCLUDED.review_status,
        repo_url=EXCLUDED.repo_url,
        repo_fingerprint=EXCLUDED.repo_fingerprint,
        repo_provider=EXCLUDED.repo_provider,
        repo_owner=EXCLUDED.repo_owner,
        repo_name=EXCLUDED.repo_name,
        updated_at=CURRENT_TIMESTAMP
      RETURNING note_id
    `, [
      params.workspace,
      params.project,
      params.topic,
      normalizedSubtopic,
      params.tagsJson,
      params.bodyMd,
      params.createdBy || null,
      params.reviewStatus,
      params.repoUrl || null,
      params.repoFingerprint || null,
      params.repoProvider || null,
      params.repoOwner || null,
      params.repoName || null,
    ]);

    return result.rows[0].note_id;
  }

  async getNote(
    workspace: string,
    project: string,
    topic: string,
    subtopic?: string | null
  ): Promise<Note | null> {
    const normalizedSubtopic = subtopic || '';
    
    const result = await this.pool.query(`
      SELECT *
      FROM notes
      WHERE workspace = $1 AND project = $2 AND topic = $3 AND subtopic = $4
      LIMIT 1
    `, [workspace, project, topic, normalizedSubtopic]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return this.mapRowToNote(row);
  }

  async getNoteById(noteId: number): Promise<Note | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM notes
      WHERE note_id = $1
      LIMIT 1
    `, [noteId]);

    if (result.rows.length === 0) return null;

    return this.mapRowToNote(result.rows[0]);
  }

  private mapRowToNote(row: any): Note {
    return {
      note_id: row.note_id,
      workspace: row.workspace,
      project: row.project,
      topic: row.topic,
      subtopic: row.subtopic === '' ? null : row.subtopic,
      tags_json: row.tags_json,
      body_md: row.body_md,
      created_by: row.created_by,
      review_status: row.review_status,
      repo_url: row.repo_url,
      repo_fingerprint: row.repo_fingerprint,
      repo_provider: row.repo_provider,
      repo_owner: row.repo_owner,
      repo_name: row.repo_name,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }

  async updateNoteMeta(
    noteId: number,
    topic: string,
    subtopic: string | null,
    reviewStatus: 'DRAFT' | 'APPROVED'
  ): Promise<Note | null> {
    const normalizedSubtopic = subtopic || '';

    const result = await this.pool.query(`
      UPDATE notes
      SET topic = $1,
          subtopic = $2,
          review_status = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE note_id = $4
      RETURNING *
    `, [topic, normalizedSubtopic, reviewStatus, noteId]);

    if (result.rows.length === 0) return null;

    return this.mapRowToNote(result.rows[0]);
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

    // Delete cascade handles note_links and note_vectors
    const result = await this.pool.query(
      'DELETE FROM notes WHERE note_id = $1',
      [note.note_id]
    );

    return result.rowCount !== null && result.rowCount > 0;
  }

  async listTopics(
    workspace: string,
    project: string
  ): Promise<Array<{ topic: string; subtopic: string | null }>> {
    const result = await this.pool.query(`
      SELECT DISTINCT topic, subtopic
      FROM notes
      WHERE workspace = $1 AND project = $2
      ORDER BY topic, subtopic
    `, [workspace, project]);

    return result.rows.map((r: any) => ({
      topic: r.topic,
      subtopic: r.subtopic === '' ? null : r.subtopic,
    }));
  }

  async upsertNoteLinks(
    noteId: number,
    links: Array<Partial<NoteLink>>
  ): Promise<void> {
    await this.pool.query('DELETE FROM note_links WHERE note_id = $1', [noteId]);

    if (links.length > 0) {
      for (const link of links) {
        await this.pool.query(`
          INSERT INTO note_links (note_id, repo, path, symbol, commit_sha, line_start, line_end, markdown_context, markdown_line)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
          noteId,
          link.repo || null,
          link.path || null,
          link.symbol || null,
          link.commit_sha || null,
          link.line_start || null,
          link.line_end || null,
          link.markdown_context || null,
          link.markdown_line || null,
        ]);
      }
    }
  }

  async getNoteLinks(noteId: number): Promise<NoteLink[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM note_links
      WHERE note_id = $1
      ORDER BY markdown_line, line_start
    `, [noteId]);

    return result.rows.map((r: any) => ({
      note_id: r.note_id,
      repo: r.repo,
      path: r.path,
      symbol: r.symbol,
      commit_sha: r.commit_sha,
      line_start: r.line_start,
      line_end: r.line_end,
      markdown_context: r.markdown_context,
      markdown_line: r.markdown_line,
    }));
  }

  async upsertRepoPath(
    repoFingerprint: string,
    localPath: string
  ): Promise<void> {
    await this.pool.query(`
      INSERT INTO repo_paths (repo_fingerprint, local_path, last_seen_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT(repo_fingerprint, local_path)
      DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP
    `, [repoFingerprint, localPath]);
  }

  /**
   * Get underlying pool (for combined adapter use)
   */
  getPool(): pg.Pool {
    return this.pool;
  }
}

/**
 * PostgreSQL Vector Adapter (using pgvector extension)
 */
export class PostgresVectorAdapter implements VectorAdapter {
  readonly type = 'pgvector' as const;
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Check if pgvector extension is available
      await this.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
      return true;
    } catch {
      return false;
    }
  }

  async initSchema(): Promise<void> {
    // Ensure pgvector extension is enabled
    try {
      await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (error: any) {
      if (!error.message?.includes('already exists')) {
        throw new Error(`Failed to create pgvector extension: ${error.message}`);
      }
    }

    // Create vector table
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS note_vectors (
          note_id    INTEGER PRIMARY KEY REFERENCES notes(note_id) ON DELETE CASCADE,
          embedding  vector(384)
        )
      `);
    } catch (error: any) {
      if (!error.message?.includes('already exists')) {
        throw error;
      }
    }

    // Create vector index
    try {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_note_vectors_embedding 
        ON note_vectors USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
      `);
    } catch (error: any) {
      // Ignore index errors - might already exist or need more data
      if (!error.message?.includes('already exists') && 
          !error.message?.includes('does not have enough rows')) {
        console.warn(`[context-whisper] Warning creating vector index: ${error.message}`);
      }
    }
  }

  async close(): Promise<void> {
    // Pool is shared with relational adapter
  }

  async upsertVector(noteId: number, embedding: Float32Array): Promise<void> {
    // Convert Float32Array to PostgreSQL vector format: [0.1, 0.2, ...]
    const vectorStr = '[' + Array.from(embedding).join(',') + ']';

    await this.pool.query(`
      INSERT INTO note_vectors (note_id, embedding)
      VALUES ($1, $2::vector)
      ON CONFLICT (note_id)
      DO UPDATE SET embedding = EXCLUDED.embedding
    `, [noteId, vectorStr]);
  }

  async deleteVector(noteId: number): Promise<void> {
    await this.pool.query('DELETE FROM note_vectors WHERE note_id = $1', [noteId]);
  }

  async searchVectors(
    queryVector: Float32Array,
    topK: number,
    filter?: { noteIds?: number[] }
  ): Promise<Array<{ noteId: number; distance: number }>> {
    const vectorStr = '[' + Array.from(queryVector).join(',') + ']';

    let query: string;
    let params: any[];

    if (filter?.noteIds && filter.noteIds.length > 0) {
      // With filter
      query = `
        SELECT note_id, embedding <=> $1::vector AS distance
        FROM note_vectors
        WHERE note_id = ANY($2)
        ORDER BY distance
        LIMIT $3
      `;
      params = [vectorStr, filter.noteIds, topK];
    } else {
      // Without filter
      query = `
        SELECT note_id, embedding <=> $1::vector AS distance
        FROM note_vectors
        ORDER BY distance
        LIMIT $2
      `;
      params = [vectorStr, topK];
    }

    const result = await this.pool.query(query, params);

    return result.rows.map((r: any) => ({
      noteId: r.note_id,
      distance: parseFloat(r.distance),
    }));
  }
}

/**
 * Combined PostgreSQL Database Adapter
 */
export class PostgresDatabaseAdapter implements DatabaseAdapter {
  readonly relational: PostgresRelationalAdapter;
  readonly vector: PostgresVectorAdapter;
  readonly environmentName: string;
  private pool: pg.Pool;

  constructor(pool: pg.Pool, environmentName: string = 'default') {
    this.pool = pool;
    this.environmentName = environmentName;
    this.relational = new PostgresRelationalAdapter(pool);
    this.vector = new PostgresVectorAdapter(pool);
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
    const vectorStr = '[' + Array.from(queryVector).join(',') + ']';
    const topK = options.topK || 5;

    // Build WHERE conditions
    const conditions: string[] = [];
    const params: any[] = [vectorStr];
    let paramIndex = 2;

    if (options.repoFingerprint) {
      conditions.push(`n.repo_fingerprint = $${paramIndex++}`);
      params.push(options.repoFingerprint);
    } else if (options.repoUrl) {
      conditions.push(`n.repo_url = $${paramIndex++}`);
      params.push(options.repoUrl);
    }

    if (options.workspace) {
      conditions.push(`n.workspace = $${paramIndex++}`);
      params.push(options.workspace);
    }

    if (options.project) {
      conditions.push(`n.project = $${paramIndex++}`);
      params.push(options.project);
    }

    if (options.tags && options.tags.length > 0) {
      const tagConditions: string[] = [];
      options.tags.forEach((tag) => {
        tagConditions.push(`n.tags_json LIKE $${paramIndex++}`);
        params.push(`%"${tag}"%`);
      });
      conditions.push(`(${tagConditions.join(' OR ')})`);
    }

    if (options.reviewStatus) {
      conditions.push(`n.review_status = $${paramIndex++}`);
      params.push(options.reviewStatus);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(topK);

    const query = `
      SELECT
        n.note_id, n.workspace, n.project, n.topic, n.subtopic,
        n.tags_json, n.body_md, n.created_by, n.review_status,
        n.repo_url, n.repo_fingerprint, n.repo_provider, n.repo_owner, n.repo_name,
        n.created_at, n.updated_at,
        v.embedding <=> $1::vector AS distance
      FROM notes n
      JOIN note_vectors v ON n.note_id = v.note_id
      ${whereClause}
      ORDER BY distance
      LIMIT $${paramIndex}
    `;

    const result = await this.pool.query(query, params);

    return result.rows.map((row: any) => ({
      note_id: row.note_id,
      workspace: row.workspace,
      project: row.project,
      topic: row.topic,
      subtopic: row.subtopic === '' ? null : row.subtopic,
      tags_json: row.tags_json,
      body_md: row.body_md,
      created_by: row.created_by,
      review_status: row.review_status,
      repo_url: row.repo_url,
      repo_fingerprint: row.repo_fingerprint,
      repo_provider: row.repo_provider,
      repo_owner: row.repo_owner,
      repo_name: row.repo_name,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      distance: parseFloat(row.distance),
    }));
  }
}

/**
 * Create PostgreSQL database adapter
 */
export async function createPostgresAdapter(
  config: PostgresConfig,
  environmentName: string = 'default'
): Promise<PostgresDatabaseAdapter> {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  });

  // Test connection
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    throw new Error(`Failed to connect to PostgreSQL: ${error instanceof Error ? error.message : error}`);
  }

  return new PostgresDatabaseAdapter(pool, environmentName);
}
