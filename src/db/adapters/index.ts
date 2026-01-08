/**
 * Database Adapters - Export all adapters and types
 */

// Types and interfaces
export * from './interface.js';

// SQLite adapter (default)
export {
  SQLiteRelationalAdapter,
  SQLiteVectorAdapter,
  SQLiteDatabaseAdapter,
  openSQLiteDatabase,
} from './sqlite.js';

// PostgreSQL adapter
export {
  PostgresRelationalAdapter,
  PostgresVectorAdapter,
  PostgresDatabaseAdapter,
  createPostgresAdapter,
} from './postgres.js';

// MySQL adapter
export {
  MySQLRelationalAdapter,
  createMySQLAdapter,
  createMySQLPool,
} from './mysql.js';

// Qdrant adapter
export {
  QdrantVectorAdapter,
  QdrantCombinedAdapter,
  createQdrantAdapter,
  createQdrantCombinedAdapter,
} from './qdrant.js';
