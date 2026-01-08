import { homedir } from 'os';
import { join, dirname } from 'path';
import { env, cwd as processCwd } from 'process';
import { platform } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import type { EnvironmentConfig } from './db/factory.js';
import {
  parseAllEnvironmentConfigs,
  parseEnvironmentConfig,
  createDefaultSQLiteConfig,
} from './db/factory.js';

export interface Config {
  dbPath: string;
  vecLibPath: string | undefined;
  /** All configured environments */
  environments: Map<string, EnvironmentConfig>;
  /** Default environment name */
  defaultEnvironment: string;
}

/**
 * Resolve default database path based on OS
 */
function getDefaultDbPath(): string {
  const home = homedir();
  
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'context-whisper', 'meta.sqlite');
  } else if (platform() === 'win32') {
    // Windows: %AppData%\context-whisper\meta.sqlite
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'context-whisper', 'meta.sqlite');
  } else {
    // Linux and other Unix-like
    return join(home, '.local', 'share', 'context-whisper', 'meta.sqlite');
  }
}

/**
 * Common paths where sqlite-vec might be installed
 */
const COMMON_VEC_PATHS = [
  '/usr/local/lib/sqlite3/vector0',
  '/usr/lib/x86_64-linux-gnu/sqlite3/vector0',
  '/usr/lib/sqlite3/vector0',
  '/opt/homebrew/lib/sqlite3/vector0',
  '/usr/local/lib/vector0',
];

/**
 * Try to find sqlite-vec extension in common locations
 * Also checks node_modules if sqlite-vec npm package is installed
 */
function findVecLib(): string | undefined {
  // Try environment variable first
  const envPath = env.CONTEXT_WHISPER_VEC_LIB;
  if (envPath) {
    return envPath;
  }

  // Try node_modules (if sqlite-vec npm package is installed)
  try {
    // Try multiple strategies to find node_modules:
    // 1. Current working directory (when run directly)
    // 2. Directory where the module is located (when run via tsx/npx)
    const cwd = processCwd();
    let searchDirs: string[] = [cwd];
    
    try {
      // If running from a compiled module, use __dirname equivalent
      const currentFileUrl = import.meta.url;
      const currentFilePath = fileURLToPath(currentFileUrl);
      const moduleDir = dirname(currentFilePath);
      
      // Go up to find package root (look for package.json or node_modules)
      let checkDir = moduleDir;
      for (let i = 0; i < 10; i++) {
        const hasPackageJson = existsSync(join(checkDir, 'package.json'));
        const hasNodeModules = existsSync(join(checkDir, 'node_modules'));
        
        if (hasPackageJson || hasNodeModules) {
          // Make sure it's not already in searchDirs
          if (checkDir !== cwd) {
            searchDirs.push(checkDir);
          }
          break;
        }
        const parent = dirname(checkDir);
        if (parent === checkDir) break; // Reached root
        checkDir = parent;
      }
    } catch (err) {
      // If import.meta.url is not available, just use cwd
      // This can happen in some environments
    }
    
    // Look for platform-specific binaries
    const platformMap: Record<string, string> = {
      'linux': 'linux',
      'darwin': 'darwin',
      'win32': 'windows',
    };
    const archMap: Record<string, string> = {
      'x64': 'x64',
      'arm64': 'arm64',
    };
    
    const platformName = platformMap[platform()] || 'linux';
    const archName = archMap[process.arch] || 'x64';
    const packageName = `sqlite-vec-${platformName}-${archName}`;
    
    // Determine extension file name based on platform
    const extensionFiles: Record<string, string> = {
      'linux': 'vec0.so',
      'darwin': 'vec0.dylib',
      'windows': 'vec0.dll',
    };
    const extName = extensionFiles[platformName] || 'vec0.so';
    
    // Search in each potential directory
    for (const searchDir of searchDirs) {
      const possiblePaths = [
        join(searchDir, 'node_modules', packageName, extName),
        join(searchDir, 'node_modules', packageName, 'lib', extName),
        join(searchDir, 'node_modules', 'sqlite-vec', 'lib', extName),
        join(searchDir, 'node_modules', 'sqlite-vec', extName),
      ];
      
      for (const path of possiblePaths) {
        if (existsSync(path)) {
          return path;
        }
      }
    }
  } catch {
    // Continue searching
  }

  // Try common system paths (looking for vec0.so, vec0.dylib, vec0.dll)
  try {
    const platformName = platform();
    const extensionFiles: Record<string, string> = {
      'linux': 'vec0.so',
      'darwin': 'vec0.dylib',
      'win32': 'vec0.dll',
    };
    const extName = extensionFiles[platformName] || 'vec0.so';
    
    for (const basePath of COMMON_VEC_PATHS) {
      try {
        const vecPath = join(dirname(basePath), extName);
        if (existsSync(vecPath)) {
          return vecPath;
        }
        // Also try the original path (vector0)
        if (existsSync(basePath)) {
          return basePath;
        }
      } catch {
        // Continue searching
      }
    }
  } catch {
    // Continue
  }
  
  return undefined;
}

/**
 * Resolve configuration from CLI args, ENV vars, and defaults
 * Precedence: CLI > ENV > default
 * 
 * Environment variables for multi-database support:
 * - {ENV}_SQLITE_PATH - SQLite database path
 * - {ENV}_PG_HOST, {ENV}_PG_PORT, {ENV}_PG_USER, {ENV}_PG_PASSWORD, {ENV}_PG_DATABASE, {ENV}_PG_SSL
 * - {ENV}_MYSQL_HOST, {ENV}_MYSQL_PORT, {ENV}_MYSQL_USER, {ENV}_MYSQL_PASSWORD, {ENV}_MYSQL_DATABASE, {ENV}_MYSQL_SSL
 * - {ENV}_QDRANT_HOST, {ENV}_QDRANT_PORT, {ENV}_QDRANT_API_KEY, {ENV}_QDRANT_COLLECTION, {ENV}_QDRANT_HTTPS
 * - {ENV}_VECTOR_STORE - "sqlite-vec" | "pgvector" | "qdrant"
 * 
 * Examples:
 * - PROD_PG_HOST=prod.db.com + PROD_PG_USER=... -> PostgreSQL + pgvector for PROD
 * - DEV_MYSQL_HOST=dev.db.com + DEV_QDRANT_HOST=qdrant.dev.com -> MySQL + Qdrant for DEV
 * - (no prefix) -> Default SQLite + sqlite-vec (backward compatible)
 */
export function resolveConfig(
  dbPath?: string,
  vecLibPath?: string
): Config {
  // Base config (backward compatible defaults)
  const baseDbPath = dbPath || env.CONTEXT_WHISPER_DB_PATH || getDefaultDbPath();
  const baseVecLibPath = vecLibPath || findVecLib();

  // Ensure parent directory exists for default database
  const dir = dirname(baseDbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Parse multi-environment configurations from env vars
  const defaults = { dbPath: baseDbPath, vecLibPath: baseVecLibPath };
  const environmentConfigs = parseAllEnvironmentConfigs(env as Record<string, string | undefined>, defaults);

  // If no environments configured, use default SQLite
  if (environmentConfigs.size === 0) {
    const defaultConfig = createDefaultSQLiteConfig(baseDbPath, baseVecLibPath);
    environmentConfigs.set('default', defaultConfig);
  }

  // Determine default environment
  // Priority: CONTEXT_WHISPER_ENV > first environment > 'default'
  let defaultEnvironment = env.CONTEXT_WHISPER_ENV || 'default';
  if (!environmentConfigs.has(defaultEnvironment)) {
    defaultEnvironment = environmentConfigs.keys().next().value || 'default';
  }

  return {
    dbPath: baseDbPath,
    vecLibPath: baseVecLibPath,
    environments: environmentConfigs,
    defaultEnvironment,
  };
}

/**
 * Get environment configuration by name
 */
export function getEnvironmentConfig(
  config: Config,
  envName?: string
): EnvironmentConfig | null {
  const name = envName || config.defaultEnvironment;
  return config.environments.get(name) || null;
}

/**
 * List all available environments
 */
export function listEnvironments(config: Config): string[] {
  return Array.from(config.environments.keys());
}

/**
 * Check if an environment exists
 */
export function hasEnvironment(config: Config, envName: string): boolean {
  return config.environments.has(envName);
}

/**
 * Get database type description for logging
 */
export function getDbTypeDescription(envConfig: EnvironmentConfig): string {
  const relType = envConfig.relational.type;
  const vecType = envConfig.vector.type;
  
  if (relType === vecType.replace('-vec', '').replace('pg', 'postgres')) {
    // All-in-one (SQLite + sqlite-vec or PostgreSQL + pgvector)
    return `${relType.toUpperCase()} + ${vecType}`;
  }
  
  // Split storage
  return `${relType.toUpperCase()} (relational) + ${vecType} (vectors)`;
}
