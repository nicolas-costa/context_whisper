/**
 * MySQL Adapter for context-whisper
 * Uses mysql2 for relational data
 * Note: MySQL requires external vector store (Qdrant) for vector operations
 */

import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  RelationalAdapter,
  Note,
  NoteLink,
  MySQLConfig,
} from './interface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * MySQL Relational Adapter
 */
export class MySQLRelationalAdapter implements RelationalAdapter {
  readonly type = 'mysql' as const;
  private pool: mysql.Pool;
  private schemaPath: string;

  constructor(pool: mysql.Pool) {
    this.pool = pool;
    this.schemaPath = join(__dirname, '..', '..', '..', 'sql', 'mysql', 'schema.sql');
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
    
    // Split by semicolons and execute each statement
    const statements = schema
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));
    
    for (const statement of statements) {
      try {
        await this.pool.query(statement);
      } catch (error: any) {
        // Ignore "already exists" errors
        if (error.code === 'ER_TABLE_EXISTS_ERROR' ||
            error.code === 'ER_DUP_KEYNAME' ||
            error.code === 'ER_DUP_KEY' ||
            error.message?.includes('already exists') ||
            error.message?.includes('Duplicate')) {
          continue;
        }
        throw error;
      }
    }
  }

  async getSchemaVersion(): Promise<number> {
    try {
      const [rows] = await this.pool.query('SELECT MAX(version) as version FROM schema_version') as any;
      return rows[0]?.version || 1;
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
    
    // MySQL uses INSERT ... ON DUPLICATE KEY UPDATE
    const [result] = await this.pool.query(`
      INSERT INTO notes (workspace, project, topic, subtopic, tags_json, body_md, created_by, review_status,
                         repo_url, repo_fingerprint, repo_provider, repo_owner, repo_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'DRAFT'), ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        tags_json = VALUES(tags_json),
        body_md = VALUES(body_md),
        created_by = VALUES(created_by),
        review_status = VALUES(review_status),
        repo_url = VALUES(repo_url),
        repo_fingerprint = VALUES(repo_fingerprint),
        repo_provider = VALUES(repo_provider),
        repo_owner = VALUES(repo_owner),
        repo_name = VALUES(repo_name)
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
    ]) as any;

    // If it was an update (affected rows = 2 in MySQL ON DUPLICATE KEY UPDATE)
    if (result.insertId === 0) {
      const note = await this.getNote(params.workspace, params.project, params.topic, params.subtopic);
      return note?.note_id ?? 0;
    }

    return result.insertId;
  }

  async getNote(
    workspace: string,
    project: string,
    topic: string,
    subtopic?: string | null
  ): Promise<Note | null> {
    const normalizedSubtopic = subtopic || '';
    
    const [rows] = await this.pool.query(`
      SELECT *
      FROM notes
      WHERE workspace = ? AND project = ? AND topic = ? AND subtopic = ?
      LIMIT 1
    `, [workspace, project, topic, normalizedSubtopic]) as any;

    if (rows.length === 0) return null;

    return this.mapRowToNote(rows[0]);
  }

  async getNoteById(noteId: number): Promise<Note | null> {
    const [rows] = await this.pool.query(`
      SELECT *
      FROM notes
      WHERE note_id = ?
      LIMIT 1
    `, [noteId]) as any;

    if (rows.length === 0) return null;

    return this.mapRowToNote(rows[0]);
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

    const [result] = await this.pool.query(`
      UPDATE notes
      SET topic = ?,
          subtopic = ?,
          review_status = ?
      WHERE note_id = ?
    `, [topic, normalizedSubtopic, reviewStatus, noteId]) as any;

    if (result.affectedRows === 0) return null;

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

    // Foreign keys with ON DELETE CASCADE handle note_links
    const [result] = await this.pool.query(
      'DELETE FROM notes WHERE note_id = ?',
      [note.note_id]
    ) as any;

    return result.affectedRows > 0;
  }

  async listTopics(
    workspace: string,
    project: string
  ): Promise<Array<{ topic: string; subtopic: string | null }>> {
    const [rows] = await this.pool.query(`
      SELECT DISTINCT topic, subtopic
      FROM notes
      WHERE workspace = ? AND project = ?
      ORDER BY topic, subtopic
    `, [workspace, project]) as any;

    return rows.map((r: any) => ({
      topic: r.topic,
      subtopic: r.subtopic === '' ? null : r.subtopic,
    }));
  }

  async upsertNoteLinks(
    noteId: number,
    links: Array<Partial<NoteLink>>
  ): Promise<void> {
    await this.pool.query('DELETE FROM note_links WHERE note_id = ?', [noteId]);

    if (links.length > 0) {
      for (const link of links) {
        await this.pool.query(`
          INSERT INTO note_links (note_id, repo, path, symbol, commit_sha, line_start, line_end, markdown_context, markdown_line)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const [rows] = await this.pool.query(`
      SELECT *
      FROM note_links
      WHERE note_id = ?
      ORDER BY markdown_line, line_start
    `, [noteId]) as any;

    return rows.map((r: any) => ({
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
      INSERT INTO repo_paths (repo_fingerprint, local_path)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE last_seen_at = CURRENT_TIMESTAMP
    `, [repoFingerprint, localPath]);
  }

  /**
   * Get underlying pool (for combined adapter use)
   */
  getPool(): mysql.Pool {
    return this.pool;
  }

  /**
   * Get notes by IDs (for use with external vector search)
   */
  async getNotesByIds(noteIds: number[]): Promise<Note[]> {
    if (noteIds.length === 0) return [];

    const placeholders = noteIds.map(() => '?').join(',');
    const [rows] = await this.pool.query(`
      SELECT *
      FROM notes
      WHERE note_id IN (${placeholders})
    `, noteIds) as any;

    return rows.map((r: any) => this.mapRowToNote(r));
  }

  /**
   * Get all note IDs matching filters (for use with external vector search)
   */
  async getFilteredNoteIds(options: {
    workspace?: string | null;
    project?: string | null;
    tags?: string[] | null;
    reviewStatus?: string | null;
    repoFingerprint?: string | null;
    repoUrl?: string | null;
  }): Promise<number[]> {
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.repoFingerprint) {
      conditions.push('repo_fingerprint = ?');
      params.push(options.repoFingerprint);
    } else if (options.repoUrl) {
      conditions.push('repo_url = ?');
      params.push(options.repoUrl);
    }

    if (options.workspace) {
      conditions.push('workspace = ?');
      params.push(options.workspace);
    }

    if (options.project) {
      conditions.push('project = ?');
      params.push(options.project);
    }

    if (options.tags && options.tags.length > 0) {
      const tagConditions: string[] = [];
      options.tags.forEach((tag) => {
        tagConditions.push('tags_json LIKE ?');
        params.push(`%"${tag}"%`);
      });
      conditions.push(`(${tagConditions.join(' OR ')})`);
    }

    if (options.reviewStatus) {
      conditions.push('review_status = ?');
      params.push(options.reviewStatus);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await this.pool.query(`
      SELECT note_id FROM notes ${whereClause}
    `, params) as any;

    return rows.map((r: any) => r.note_id);
  }
}

/**
 * Create MySQL pool
 */
export async function createMySQLPool(
  config: MySQLConfig
): Promise<mysql.Pool> {
  const pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: config.ssl ? {} : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  });

  // Test connection
  try {
    await pool.query('SELECT 1');
  } catch (error) {
    await pool.end();
    throw new Error(`Failed to connect to MySQL: ${error instanceof Error ? error.message : error}`);
  }

  return pool;
}

/**
 * Create MySQL relational adapter
 */
export async function createMySQLAdapter(
  config: MySQLConfig
): Promise<MySQLRelationalAdapter> {
  const pool = await createMySQLPool(config);
  return new MySQLRelationalAdapter(pool);
}
