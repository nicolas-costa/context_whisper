/**
 * Database Module - Re-exports from adapter system
 * 
 * This module provides convenient access to database types and the manager.
 * All actual implementation is in ./db/adapters/
 */

// Re-export types
export type {
  Note,
  NoteLink,
  SearchResult,
  DatabaseAdapter,
  RelationalAdapter,
  VectorAdapter,
  EnvironmentConfig,
  SQLiteConfig,
  PostgresConfig,
  MySQLConfig,
  QdrantConfig,
} from './db/adapters/interface.js';

// Re-export manager
export { DatabaseManager, createDatabaseManager } from './db/manager.js';

// Re-export factory functions
export { createDatabaseAdapter, createDefaultSQLiteConfig } from './db/factory.js';

// Re-export specific adapters for direct use if needed
export { openSQLiteDatabase, SQLiteDatabaseAdapter } from './db/adapters/sqlite.js';
export { createPostgresAdapter, PostgresDatabaseAdapter } from './db/adapters/postgres.js';
export { createMySQLAdapter, MySQLRelationalAdapter } from './db/adapters/mysql.js';
export { createQdrantAdapter, createQdrantCombinedAdapter, QdrantVectorAdapter } from './db/adapters/qdrant.js';
