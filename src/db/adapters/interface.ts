/**
 * Database Adapter Interface
 * 
 * Defines the contract for all database adapters (SQLite, PostgreSQL, MySQL).
 * Supports both relational data and vector search capabilities.
 */

export interface Note {
  note_id: number;
  workspace: string;
  project: string;
  topic: string;
  subtopic: string | null;
  tags_json: string | null;
  body_md: string;
  created_by: string | null;
  review_status: string;
  repo_url: string | null;
  repo_fingerprint: string | null;
  repo_provider: string | null;
  repo_owner: string | null;
  repo_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteLink {
  note_id: number;
  repo: string | null;
  path: string | null;
  symbol: string | null;
  commit_sha: string | null;
  line_start: number | null;
  line_end: number | null;
  markdown_context: string | null;
  markdown_line: number | null;
}

export interface SearchResult extends Note {
  distance: number;
}

/**
 * Configuration for different database types
 */
export type DatabaseType = 'sqlite' | 'postgres' | 'mysql';
export type VectorStoreType = 'sqlite-vec' | 'pgvector' | 'qdrant';

export interface SQLiteConfig {
  type: 'sqlite';
  path: string;
  vecLibPath?: string;
}

export interface PostgresConfig {
  type: 'postgres';
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

export interface MySQLConfig {
  type: 'mysql';
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

export interface QdrantConfig {
  host: string;
  port: number;
  apiKey?: string;
  collection?: string;
  https?: boolean;
}

export interface EnvironmentConfig {
  name: string;
  relational: SQLiteConfig | PostgresConfig | MySQLConfig;
  vector: {
    type: VectorStoreType;
    config: SQLiteConfig | PostgresConfig | QdrantConfig;
  };
}

/**
 * Relational Database Adapter Interface
 * Handles all non-vector operations (notes, links, repo_paths)
 */
export interface RelationalAdapter {
  /** Database type identifier */
  readonly type: DatabaseType;
  
  /** Check if connection is healthy */
  isHealthy(): Promise<boolean>;
  
  /** Initialize database schema */
  initSchema(): Promise<void>;
  
  /** Get current schema version */
  getSchemaVersion(): Promise<number>;
  
  /** Close database connection */
  close(): Promise<void>;
  
  // Note operations
  upsertNote(params: {
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
  }): Promise<number>;
  
  getNote(
    workspace: string,
    project: string,
    topic: string,
    subtopic?: string | null
  ): Promise<Note | null>;
  
  getNoteById(noteId: number): Promise<Note | null>;
  
  updateNoteMeta(
    noteId: number,
    topic: string,
    subtopic: string | null,
    reviewStatus: 'DRAFT' | 'APPROVED'
  ): Promise<Note | null>;
  
  deleteNote(
    workspace: string,
    project: string,
    topic: string,
    subtopic?: string | null
  ): Promise<boolean>;
  
  listTopics(
    workspace: string,
    project: string
  ): Promise<Array<{ topic: string; subtopic: string | null }>>;
  
  // Link operations
  upsertNoteLinks(
    noteId: number,
    links: Array<Partial<NoteLink>>
  ): Promise<void>;
  
  getNoteLinks(noteId: number): Promise<NoteLink[]>;
  
  // Repo path operations
  upsertRepoPath(
    repoFingerprint: string,
    localPath: string
  ): Promise<void>;
}

/**
 * Vector Store Adapter Interface
 * Handles all vector/embedding operations
 */
export interface VectorAdapter {
  /** Vector store type identifier */
  readonly type: VectorStoreType;
  
  /** Check if connection is healthy */
  isHealthy(): Promise<boolean>;
  
  /** Initialize vector store (create collection/table if needed) */
  initSchema(): Promise<void>;
  
  /** Close connection */
  close(): Promise<void>;
  
  /** Upsert (insert or update) a vector for a note */
  upsertVector(noteId: number, embedding: Float32Array): Promise<void>;
  
  /** Delete vector for a note */
  deleteVector(noteId: number): Promise<void>;
  
  /** 
   * Search for similar vectors
   * Returns note_ids with distances, sorted by similarity (ascending distance)
   */
  searchVectors(
    queryVector: Float32Array,
    topK: number,
    filter?: {
      noteIds?: number[];
    }
  ): Promise<Array<{ noteId: number; distance: number }>>;
}

/**
 * Combined Database Adapter
 * Wraps both relational and vector adapters for unified access
 */
export interface DatabaseAdapter {
  readonly relational: RelationalAdapter;
  readonly vector: VectorAdapter;
  readonly environmentName: string;
  
  /** Check if all connections are healthy */
  isHealthy(): Promise<{ relational: boolean; vector: boolean }>;
  
  /** Initialize all schemas */
  initSchema(): Promise<void>;
  
  /** Close all connections */
  close(): Promise<void>;
  
  /**
   * Search notes using vector similarity with relational filtering
   * This combines vector search with relational filters
   */
  searchNotes(
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
  ): Promise<SearchResult[]>;
}

/**
 * Factory function type for creating adapters
 */
export type AdapterFactory = (config: EnvironmentConfig) => Promise<DatabaseAdapter>;
