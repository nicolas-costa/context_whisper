import { homedir } from 'os';
import { join, dirname } from 'path';
import { env, cwd as processCwd } from 'process';
import { platform } from 'os';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

export interface Config {
  dbPath: string;
  vecLibPath: string | undefined;
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
 */
export function resolveConfig(
  dbPath?: string,
  vecLibPath?: string
): Config {
  const config: Config = {
    dbPath: dbPath || env.CONTEXT_WHISPER_DB_PATH || getDefaultDbPath(),
    vecLibPath: vecLibPath || findVecLib(),
  };

  // Ensure parent directory exists for database
  const dir = dirname(config.dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return config;
}

