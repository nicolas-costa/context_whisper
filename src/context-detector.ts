import { existsSync, readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { env } from 'process';

export interface DetectedContext {
  workspace: string;              // = owner
  project: string;                // = repo
  repo_url?: string;              // URL canônica (https://...)
  repo_provider?: string;         // github|gitlab|bitbucket|other
  repo_owner?: string;
  repo_name?: string;
  repo_fingerprint?: string;      // SHA1 da URL
  confidence: number;              // 0.5..1.0
  inferred: boolean;
  source: 'payload' | 'env' | 'dotfile' | 'git' | 'monorepo' | 'path' | 'default';
}

// Cache sticky session por CWD
const contextCache = new Map<string, { context: DetectedContext; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

/**
 * Normalize repository URL to canonical HTTPS format
 */
export function normalizeRepoUrl(input?: string): {
  url: string;
  provider: string;
  owner: string;
  name: string;
} | null {
  if (!input) return null;

  let url = input.trim();

  // Remove trailing .git
  url = url.replace(/\.git$/, '');

  // Remove extra paths like /tree/master/, /blob/main/, etc.
  url = url.replace(/\/tree\/[^/]+.*$/, '');
  url = url.replace(/\/blob\/[^/]+.*$/, '');
  url = url.replace(/\/commits?\/.*$/, '');

  // Convert SSH to HTTPS
  // git@github.com:owner/repo -> https://github.com/owner/repo
  const sshMatch = url.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    const host = sshMatch[1].toLowerCase();
    const path = sshMatch[2];
    url = `https://${host}/${path}`;
  }

  // Normalize protocol
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (url.includes(':')) {
      // Assume SSH format without git@
      url = `https://${url.replace(':', '/')}`;
    } else {
      // Assume domain name, try https
      url = `https://${url}`;
    }
  }

  // Ensure HTTPS
  url = url.replace(/^http:\/\//, 'https://');

  // Lowercase host
  const urlObj = new URL(url);
  url = `${urlObj.protocol}//${urlObj.host.toLowerCase()}${urlObj.pathname}`;

  // Remove trailing slash
  url = url.replace(/\/$/, '');

  // Extract provider, owner, name
  const match = url.match(/https?:\/\/([^\/]+)\/(.+)/);
  if (!match) return null;

  const host = match[1].toLowerCase();
  const pathParts = match[2].split('/').filter(Boolean);

  let provider = 'other';
  if (host.includes('github.com')) provider = 'github';
  else if (host.includes('gitlab.com') || host.includes('gitlab')) provider = 'gitlab';
  else if (host.includes('bitbucket.org') || host.includes('bitbucket')) provider = 'bitbucket';

  if (pathParts.length < 2) return null;

  const owner = pathParts[0];
  const name = pathParts[pathParts.length - 1];

  return { url, provider, owner, name };
}

/**
 * Generate SHA1 fingerprint for repository URL
 */
export function fingerprintRepoUrl(url: string): string {
  return createHash('sha1').update(url).digest('hex');
}

/**
 * Detect context from git repository
 */
function detectFromGit(cwd: string): Partial<DetectedContext> | null {
  try {
    // Try to find .git directory up the tree
    let gitRoot = cwd;
    let found = false;
    const maxLevels = 20; // Increased from 10 to handle config dirs like ~/.cursor
    
    for (let i = 0; i < maxLevels; i++) {
      const gitDir = join(gitRoot, '.git');
      if (existsSync(gitDir)) {
        found = true;
        break;
      }
      const parent = dirname(gitRoot);
      if (parent === gitRoot) break; // Reached filesystem root
      gitRoot = parent;
    }

    // If not found going up, try searching in common project directories
    // This helps when started from config dirs like ~/.cursor
    if (!found) {
      const parts = cwd.split('/').filter(Boolean);
      // Look for home directory (usually contains projects)
      const homeIndex = parts.findIndex(p => ['home', 'Users', 'users'].includes(p));
      if (homeIndex >= 0 && homeIndex + 1 < parts.length) {
        const username = parts[homeIndex + 1];
        const homePath = join('/', ...parts.slice(0, homeIndex + 2));
        
        // Check common project directory names
        const commonProjectDirs = ['Development', 'dev', 'projects', 'code', 'Documents', 'Desktop'];
        for (const projectDirName of commonProjectDirs) {
          const projectBase = join(homePath, projectDirName);
          if (!existsSync(projectBase)) continue;
          
          // Try to find Git repos by searching subdirectories (limited depth)
          try {
            // Use find command to locate .git directories (max depth 3: Development/Web/repo)
            const findCmd = `find "${projectBase}" -maxdepth 3 -type d -name ".git" -print -quit 2>/dev/null`;
            const gitPath = execSync(findCmd, {
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            
            if (gitPath) {
              // Extract the repo root directory (parent of .git)
              const repoRoot = dirname(gitPath);
              if (existsSync(join(repoRoot, '.git'))) {
                gitRoot = repoRoot;
                found = true;
                break;
              }
            }
          } catch {
            // find command failed or no git repos found, continue
          }
        }
      }
    }

    if (!found) return null;

    // Get git remote URL
    try {
      const remoteUrl = execSync('git config --get remote.origin.url', {
        cwd: gitRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (!remoteUrl) return null;

      const normalized = normalizeRepoUrl(remoteUrl);
      if (!normalized) return null;

      return {
        workspace: normalized.owner,
        project: normalized.name,
        repo_url: normalized.url,
        repo_provider: normalized.provider,
        repo_owner: normalized.owner,
        repo_name: normalized.name,
        repo_fingerprint: fingerprintRepoUrl(normalized.url),
        confidence: 0.9,
        inferred: true,
        source: 'git',
      };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Detect from monorepo (package.json.name)
 */
function detectFromMonorepo(cwd: string): Partial<DetectedContext> | null {
  try {
    let current = cwd;
    for (let i = 0; i < 5; i++) {
      const pkgPath = join(current, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const content = readFileSync(pkgPath, 'utf-8');
          const pkg = JSON.parse(content);
          if (pkg.name) {
            return {
              project: pkg.name.split('/').pop() || pkg.name,
              confidence: 0.7,
              inferred: true,
              source: 'monorepo',
            };
          }
        } catch {
          // Continue
        }
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Detect from path structure
 * Tries to find meaningful workspace/project by skipping common system/config directories
 * Also tries to find a project directory by looking for Git repos or project indicators
 */
function detectFromPath(cwd: string): Partial<DetectedContext> {
  // Common directories to skip when inferring workspace (system dirs)
  const skipDirs = new Set(['home', 'users', 'user', 'usr', 'var', 'tmp', 'opt', 'root']);
  
  // Config directories that indicate we're in a config location, not a project
  const configDirs = new Set(['.cursor', '.vscode', '.config', '.local', 'appdata', 'roaming']);
  
  // Common directories that are just containers, not meaningful workspaces
  const containerDirs = new Set(['development', 'dev', 'projects', 'code', 'workspace', 'workspaces']);
  
  // Normalize directory names
  const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9-_]/g, '-');

  const parts = cwd.split('/').filter(Boolean);
  const lastPart = parts.length > 0 ? parts[parts.length - 1].toLowerCase() : '';
  
  // If we're in a config directory (like ~/.cursor), detection from path is unreliable
  // We should rely on Git detection or other methods first, but still provide a fallback
  let projectDir: string | null = null;
  const isConfigDir = configDirs.has(lastPart) || (parts.length > 0 && parts[parts.length - 1].startsWith('.'));
  
  if (isConfigDir) {
    // We're in a config directory - try to find actual project by looking for Git repos
    // This is a heuristic that might not always work, but better than using config dir
    let current = dirname(cwd); // Start from parent of config dir
    const maxLevels = 5;
    for (let i = 0; i < maxLevels; i++) {
      // Look for any Git repo in subdirectories nearby, or check common project locations
      const devPaths = [
        join(current, 'Development'),
        join(current, 'dev'),
        join(current, 'projects'),
        join(current, 'code'),
      ];
      
      for (const devPath of devPaths) {
        // Simple heuristic: if Development/ exists, maybe use the most recent modified dir?
        // Actually, this is getting too complex. Let's just use a simple fallback.
      }
      
      // Check if current directory itself is a project
      if (existsSync(join(current, '.git'))) {
        projectDir = current;
        break;
      }
      
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    
    // If we're in a config dir and didn't find a project, return low confidence
    // The Git detection (which runs earlier) should catch this, but if not, path detection won't help
    if (!projectDir) {
      // Return something generic but don't use config dir itself
      return {
        workspace: 'default',
        project: 'unknown',
        confidence: 0.3, // Very low confidence - should rely on Git or explicit config
        inferred: true,
        source: 'path',
      };
    }
  }
  
  // Use found project directory or current directory
  const effectiveCwd = projectDir || cwd;
  const effectiveParts = effectiveCwd.split('/').filter(Boolean);
  const currentDir = effectiveParts[effectiveParts.length - 1]; // Last part = project
  
  // Find workspace: go up the path, skip system/config/container directories
  let workspaceDir: string | null = null;
  for (let i = effectiveParts.length - 2; i >= 0; i--) {
    const dir = effectiveParts[i].toLowerCase();
    if (!skipDirs.has(dir) && 
        !configDirs.has(dir) && 
        !containerDirs.has(dir)) {
      workspaceDir = effectiveParts[i];
      break;
    }
  }
  
  // If we didn't find a meaningful workspace, try the parent of current dir
  // but skip if it's a common directory
  if (!workspaceDir && effectiveParts.length > 1) {
    const parentDir = effectiveParts[effectiveParts.length - 2];
    const parentDirLower = parentDir.toLowerCase();
    if (!skipDirs.has(parentDirLower) && 
        !configDirs.has(parentDirLower) && 
        !containerDirs.has(parentDirLower)) {
      workspaceDir = parentDir;
    }
  }
  
  // Fallback: use parent dir even if it's a skip dir (but warn with low confidence)
  let confidence = 0.6;
  if (!workspaceDir && effectiveParts.length > 1) {
    workspaceDir = effectiveParts[effectiveParts.length - 2];
    confidence = 0.5; // Lower confidence for fallback
  }

  return {
    // We no longer treat workspace as a meaningful global config; it should come from repo_url when available.
    // When we cannot infer it, keep an explicit placeholder instead of silently defaulting to "default".
    workspace: workspaceDir ? normalize(workspaceDir) : 'unknown',
    project: normalize(currentDir),
    confidence: projectDir ? 0.75 : confidence, // Higher confidence if we found actual project
    inferred: true,
    source: 'path',
  };
}

/**
 * Read project configuration from .context-whisper.json
 */
function readProjectConfig(cwd: string): Partial<DetectedContext> | null {
  let current = cwd;
  for (let i = 0; i < 10; i++) {
    const configPath = join(current, '.context-whisper.json');
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content) as Partial<DetectedContext>;
        
        if (config.repo_url && !config.repo_fingerprint) {
          config.repo_fingerprint = fingerprintRepoUrl(config.repo_url);
        }
        
        if (config.repo_url && !config.repo_provider && !config.repo_owner && !config.repo_name) {
          const normalized = normalizeRepoUrl(config.repo_url);
          if (normalized) {
            config.repo_provider = normalized.provider;
            config.repo_owner = normalized.owner;
            config.repo_name = normalized.name;
            config.repo_fingerprint = fingerprintRepoUrl(normalized.url);
          }
        }

        return {
          ...config,
          confidence: config.confidence || 0.8,
          inferred: config.inferred !== false,
          source: 'dotfile',
        };
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Detect context with full precedence hierarchy
 * Returns context with confidence, source, and inferred flags
 */
export function detectContext(
  payload?: Partial<DetectedContext>,
  cwd: string = process.cwd()
): DetectedContext {
  // Check cache first
  const cacheKey = cwd;
  const cached = contextCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL && !payload) {
    return cached.context;
  }

  let context: Partial<DetectedContext> = {};

  // 1. Payload explícito (maior prioridade)
  if (payload) {
    context = { ...payload };
    
    // Normalize repo_url if provided - this is the PRIMARY source
    if (payload.repo_url && !payload.repo_fingerprint) {
      const normalized = normalizeRepoUrl(payload.repo_url);
      if (normalized) {
        context.repo_url = normalized.url;
        context.repo_provider = normalized.provider;
        context.repo_owner = normalized.owner;
        context.repo_name = normalized.name;
        context.repo_fingerprint = fingerprintRepoUrl(normalized.url);
        
        // If repo_url is provided, derive workspace/project from it if not explicitly provided
        if (!payload.workspace && normalized.owner) {
          context.workspace = normalized.owner;
        }
        if (!payload.project && normalized.name) {
          context.project = normalized.name;
        }
      }
    }

    // If we have repo_url + workspace + project (even if derived), return immediately
    if (context.repo_url && context.workspace && context.project) {
      return {
        workspace: context.workspace,
        project: context.project,
        repo_url: context.repo_url,
        repo_provider: context.repo_provider,
        repo_owner: context.repo_owner,
        repo_name: context.repo_name,
        repo_fingerprint: context.repo_fingerprint,
        confidence: 1.0,
        inferred: payload.workspace && payload.project ? false : true, // Only if workspace/project were explicitly provided
        source: 'payload',
      } as DetectedContext;
    }
  }

  // 2. ENV variables
  if (env.CONTEXT_WHISPER_PROJECT) {
    context.project = env.CONTEXT_WHISPER_PROJECT;
    context.confidence = 0.85;
    context.source = 'env';
  }

  // 3. Dotfile (.context-whisper.json)
  const dotfileConfig = readProjectConfig(cwd);
  if (dotfileConfig) {
    if (!context.workspace && dotfileConfig.workspace) {
      context.workspace = dotfileConfig.workspace;
      context.confidence = Math.max(context.confidence || 0, dotfileConfig.confidence || 0.8);
      context.source = 'dotfile';
    }
    if (!context.project && dotfileConfig.project) {
      context.project = dotfileConfig.project;
      context.confidence = Math.max(context.confidence || 0, dotfileConfig.confidence || 0.8);
      context.source = 'dotfile';
    }
    if (!context.repo_url && dotfileConfig.repo_url) {
      context.repo_url = dotfileConfig.repo_url;
      context.repo_provider = dotfileConfig.repo_provider;
      context.repo_owner = dotfileConfig.repo_owner;
      context.repo_name = dotfileConfig.repo_name;
      context.repo_fingerprint = dotfileConfig.repo_fingerprint;
    }
  }

  // 4. Monorepo detection (package.json.name) - only for project, not workspace
  if (!context.project) {
    const monorepoConfig = detectFromMonorepo(cwd);
    if (monorepoConfig && monorepoConfig.project) {
      context.project = monorepoConfig.project;
      context.confidence = Math.max(context.confidence || 0, monorepoConfig.confidence || 0.7);
      context.source = 'monorepo';
    }
  }
  
  // Note: We don't use Git detection or Path detection as fallbacks since:
  // - Git detection requires server to be in project context (not the case)
  // - Path detection is unreliable and doesn't provide repo_url
  // - repo_url is REQUIRED and should come from agent who has access to project Git

  // Ensure confidence is set
  if (!context.confidence) {
    context.confidence = 0.5;
  }
  if (context.inferred === undefined) {
    context.inferred = context.source !== 'payload';
  }

  const finalContext: DetectedContext = {
    workspace: context.workspace!,
    project: context.project!,
    repo_url: context.repo_url,
    repo_provider: context.repo_provider,
    repo_owner: context.repo_owner,
    repo_name: context.repo_name,
    repo_fingerprint: context.repo_fingerprint,
    confidence: context.confidence,
    inferred: context.inferred ?? true,
    source: context.source || 'default',
  };

  // Cache the result
  contextCache.set(cacheKey, { context: finalContext, timestamp: Date.now() });

  return finalContext;
}

