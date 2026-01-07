/**
 * Database Adapter Factory
 * Creates appropriate database adapters based on environment configuration
 */

import type {
  DatabaseAdapter,
  EnvironmentConfig,
  SQLiteConfig,
  PostgresConfig,
  MySQLConfig,
  QdrantConfig,
} from './adapters/interface.js';

import {
  openSQLiteDatabase,
  createPostgresAdapter,
  createMySQLAdapter,
  createQdrantCombinedAdapter,
} from './adapters/index.js';

import type {
  SQLiteRelationalAdapter,
  PostgresRelationalAdapter,
  MySQLRelationalAdapter,
} from './adapters/index.js';

// Re-export types for convenience
export type { EnvironmentConfig, DatabaseAdapter, SQLiteConfig, PostgresConfig, MySQLConfig, QdrantConfig };

/**
 * Create a database adapter based on environment configuration
 */
export async function createDatabaseAdapter(
  config: EnvironmentConfig
): Promise<DatabaseAdapter> {
  const { relational, vector, name } = config;

  // Case 1: SQLite + sqlite-vec (default, all-in-one)
  if (relational.type === 'sqlite' && vector.type === 'sqlite-vec') {
    const sqliteConfig = relational as SQLiteConfig;
    const { adapter } = openSQLiteDatabase(sqliteConfig, name);
    await adapter.initSchema();
    return adapter;
  }

  // Case 2: PostgreSQL + pgvector (all-in-one)
  if (relational.type === 'postgres' && vector.type === 'pgvector') {
    const pgConfig = relational as PostgresConfig;
    const adapter = await createPostgresAdapter(pgConfig, name);
    await adapter.initSchema();
    return adapter;
  }

  // Case 3: Any relational + Qdrant (split storage)
  if (vector.type === 'qdrant') {
    const qdrantConfig = vector.config as QdrantConfig;
    
    let relationalAdapter: SQLiteRelationalAdapter | PostgresRelationalAdapter | MySQLRelationalAdapter;

    switch (relational.type) {
      case 'sqlite': {
        const sqliteConfig = relational as SQLiteConfig;
        const { adapter: sqliteAdapter } = openSQLiteDatabase(sqliteConfig, name);
        relationalAdapter = sqliteAdapter.relational;
        break;
      }
      case 'postgres': {
        const pgConfig = relational as PostgresConfig;
        const pgAdapter = await createPostgresAdapter(pgConfig, name);
        relationalAdapter = pgAdapter.relational;
        break;
      }
      case 'mysql': {
        const mysqlConfig = relational as MySQLConfig;
        relationalAdapter = await createMySQLAdapter(mysqlConfig);
        break;
      }
      default:
        throw new Error(`Unsupported relational database type: ${(relational as any).type}`);
    }

    // Initialize relational schema
    await relationalAdapter.initSchema();

    // Create combined adapter with Qdrant
    const combinedAdapter = createQdrantCombinedAdapter(
      relationalAdapter,
      qdrantConfig,
      name
    );

    // Initialize Qdrant schema
    await combinedAdapter.vector.initSchema();

    return combinedAdapter;
  }

  throw new Error(
    `Unsupported database configuration: relational=${relational.type}, vector=${vector.type}`
  );
}

/**
 * Parse environment name prefix from key
 * Example: PROD_MYSQL_HOST -> PROD
 */
export function parseEnvironmentPrefix(key: string): string | null {
  const match = key.match(/^([A-Z0-9]+)_(SQLITE|PG|MYSQL|QDRANT)_/);
  return match ? match[1] : null;
}

/**
 * Get all unique environment names from env vars
 */
export function getEnvironmentNames(envVars: Record<string, string | undefined>): string[] {
  const names = new Set<string>();
  
  for (const key of Object.keys(envVars)) {
    const prefix = parseEnvironmentPrefix(key);
    if (prefix) {
      names.add(prefix);
    }
  }

  return Array.from(names);
}

/**
 * Parse environment configuration from env vars
 * 
 * Supported patterns:
 * - {ENV}_SQLITE_PATH - SQLite database path
 * - {ENV}_PG_HOST, {ENV}_PG_PORT, {ENV}_PG_USER, {ENV}_PG_PASSWORD, {ENV}_PG_DATABASE
 * - {ENV}_MYSQL_HOST, {ENV}_MYSQL_PORT, {ENV}_MYSQL_USER, {ENV}_MYSQL_PASSWORD, {ENV}_MYSQL_DATABASE
 * - {ENV}_QDRANT_HOST, {ENV}_QDRANT_PORT, {ENV}_QDRANT_API_KEY, {ENV}_QDRANT_COLLECTION
 * - {ENV}_VECTOR_STORE - "sqlite-vec" | "pgvector" | "qdrant" (default: auto-detect)
 */
export function parseEnvironmentConfig(
  envName: string,
  envVars: Record<string, string | undefined>,
  defaults: { dbPath: string; vecLibPath?: string }
): EnvironmentConfig | null {
  const prefix = `${envName}_`;
  
  // Check for SQLite config
  const sqlitePath = envVars[`${prefix}SQLITE_PATH`];
  
  // Check for PostgreSQL config
  const pgHost = envVars[`${prefix}PG_HOST`];
  const pgPort = envVars[`${prefix}PG_PORT`];
  const pgUser = envVars[`${prefix}PG_USER`];
  const pgPassword = envVars[`${prefix}PG_PASSWORD`];
  const pgDatabase = envVars[`${prefix}PG_DATABASE`];
  const hasPgConfig = pgHost && pgUser && pgDatabase;

  // Check for MySQL config
  const mysqlHost = envVars[`${prefix}MYSQL_HOST`];
  const mysqlPort = envVars[`${prefix}MYSQL_PORT`];
  const mysqlUser = envVars[`${prefix}MYSQL_USER`];
  const mysqlPassword = envVars[`${prefix}MYSQL_PASSWORD`];
  const mysqlDatabase = envVars[`${prefix}MYSQL_DATABASE`];
  const hasMysqlConfig = mysqlHost && mysqlUser && mysqlDatabase;

  // Check for Qdrant config
  const qdrantHost = envVars[`${prefix}QDRANT_HOST`];
  const qdrantPort = envVars[`${prefix}QDRANT_PORT`];
  const qdrantApiKey = envVars[`${prefix}QDRANT_API_KEY`];
  const qdrantCollection = envVars[`${prefix}QDRANT_COLLECTION`];
  const qdrantHttps = envVars[`${prefix}QDRANT_HTTPS`];
  const hasQdrantConfig = qdrantHost;

  // Explicit vector store selection
  const vectorStore = envVars[`${prefix}VECTOR_STORE`] as 'sqlite-vec' | 'pgvector' | 'qdrant' | undefined;

  // Determine relational database
  let relationalConfig: SQLiteConfig | PostgresConfig | MySQLConfig;

  if (hasPgConfig) {
    relationalConfig = {
      type: 'postgres',
      host: pgHost!,
      port: parseInt(pgPort || '5432', 10),
      user: pgUser!,
      password: pgPassword || '',
      database: pgDatabase!,
      ssl: envVars[`${prefix}PG_SSL`] === 'true',
    };
  } else if (hasMysqlConfig) {
    relationalConfig = {
      type: 'mysql',
      host: mysqlHost!,
      port: parseInt(mysqlPort || '3306', 10),
      user: mysqlUser!,
      password: mysqlPassword || '',
      database: mysqlDatabase!,
      ssl: envVars[`${prefix}MYSQL_SSL`] === 'true',
    };
  } else if (sqlitePath) {
    relationalConfig = {
      type: 'sqlite',
      path: sqlitePath,
      vecLibPath: defaults.vecLibPath,
    };
  } else {
    // No explicit config for this environment
    return null;
  }

  // Determine vector store
  let vectorConfig: EnvironmentConfig['vector'];

  if (vectorStore === 'qdrant' || (hasQdrantConfig && !vectorStore)) {
    // Use Qdrant
    if (!hasQdrantConfig) {
      throw new Error(`${envName}: QDRANT_HOST is required when VECTOR_STORE=qdrant`);
    }
    vectorConfig = {
      type: 'qdrant',
      config: {
        host: qdrantHost!,
        port: parseInt(qdrantPort || '6333', 10),
        apiKey: qdrantApiKey,
        collection: qdrantCollection,
        https: qdrantHttps === 'true',
      },
    };
  } else if (vectorStore === 'pgvector' || (relationalConfig.type === 'postgres' && !vectorStore)) {
    // Use pgvector (only valid with PostgreSQL)
    if (relationalConfig.type !== 'postgres') {
      throw new Error(`${envName}: pgvector requires PostgreSQL as the relational database`);
    }
    vectorConfig = {
      type: 'pgvector',
      config: relationalConfig,
    };
  } else {
    // Default to sqlite-vec (only valid with SQLite)
    if (relationalConfig.type !== 'sqlite') {
      throw new Error(`${envName}: sqlite-vec requires SQLite. Use VECTOR_STORE=qdrant for MySQL`);
    }
    vectorConfig = {
      type: 'sqlite-vec',
      config: relationalConfig,
    };
  }

  return {
    name: envName,
    relational: relationalConfig,
    vector: vectorConfig,
  };
}

/**
 * Parse all environment configurations from env vars
 * Returns a map of environment name -> config
 */
export function parseAllEnvironmentConfigs(
  envVars: Record<string, string | undefined>,
  defaults: { dbPath: string; vecLibPath?: string }
): Map<string, EnvironmentConfig> {
  const configs = new Map<string, EnvironmentConfig>();
  const envNames = getEnvironmentNames(envVars);

  for (const envName of envNames) {
    const config = parseEnvironmentConfig(envName, envVars, defaults);
    if (config) {
      configs.set(envName, config);
    }
  }

  return configs;
}

/**
 * Create default SQLite configuration (backward compatible)
 */
export function createDefaultSQLiteConfig(
  dbPath: string,
  vecLibPath?: string
): EnvironmentConfig {
  const sqliteConfig: SQLiteConfig = {
    type: 'sqlite',
    path: dbPath,
    vecLibPath,
  };

  return {
    name: 'default',
    relational: sqliteConfig,
    vector: {
      type: 'sqlite-vec',
      config: sqliteConfig,
    },
  };
}
