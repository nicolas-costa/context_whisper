/**
 * Database Adapter Manager
 * Manages multiple database adapters for different environments
 */

import type { DatabaseAdapter, EnvironmentConfig } from './adapters/interface.js';
import { createDatabaseAdapter } from './factory.js';

/**
 * Manages multiple database adapters for different environments
 */
export class DatabaseManager {
  private adapters: Map<string, DatabaseAdapter> = new Map();
  private configs: Map<string, EnvironmentConfig>;
  private defaultEnvironment: string;
  private initPromises: Map<string, Promise<DatabaseAdapter>> = new Map();
  private allowedEnvironments: Set<string> | null;

  constructor(
    configs: Map<string, EnvironmentConfig>,
    defaultEnvironment: string
  ) {
    this.configs = configs;
    this.defaultEnvironment = defaultEnvironment;

    // Security controls (opt-in via env vars).
    //
    // IMPORTANT: in this project, "environment" is a *connection profile* (which DB/credentials to use),
    // while workspace/owner comes from repo_url (validated against git remote of `cwd`) and is constrained
    // by per-environment WORKSPACE_WHITELIST.
    //
    // These flags are an extra coarse-grained guardrail on top of workspace whitelisting:
    // they reduce blast radius when running multiple environments side-by-side.
    //
    // - CONTEXT_WHISPER_ALLOWED_ENVIRONMENTS="ACME_CORP,COMPANY_B"
    //   Allow only these environments to be selected (allowlist).
    const allowListRaw = process.env.CONTEXT_WHISPER_ALLOWED_ENVIRONMENTS;
    if (allowListRaw && allowListRaw.trim().length > 0) {
      const items = allowListRaw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      this.allowedEnvironments = new Set(items);
    } else {
      this.allowedEnvironments = null;
    }
  }

  /**
   * Get adapter for a specific environment (lazy initialization)
   */
  async getAdapter(environmentName?: string): Promise<DatabaseAdapter> {
    const requested = environmentName || this.defaultEnvironment;
    const envName = requested;

    if (this.allowedEnvironments && !this.allowedEnvironments.has(envName)) {
      throw new Error(
        `Environment '${envName}' is not allowed by allowlist. ` +
        `Set CONTEXT_WHISPER_ALLOWED_ENVIRONMENTS to include it, or unset the allowlist.`
      );
    }

    // Return cached adapter if exists
    if (this.adapters.has(envName)) {
      return this.adapters.get(envName)!;
    }

    // Check if already initializing (prevent race conditions)
    if (this.initPromises.has(envName)) {
      return this.initPromises.get(envName)!;
    }

    // Get config
    const config = this.configs.get(envName);
    if (!config) {
      const available = Array.from(this.configs.keys()).join(', ');
      throw new Error(
        `Environment '${envName}' not configured. Available: ${available || 'none (using default SQLite)'}`
      );
    }

    // Initialize adapter
    const initPromise = this.initializeAdapter(envName, config);
    this.initPromises.set(envName, initPromise);

    try {
      const adapter = await initPromise;
      this.adapters.set(envName, adapter);
      return adapter;
    } finally {
      this.initPromises.delete(envName);
    }
  }

  private async initializeAdapter(
    envName: string,
    config: EnvironmentConfig
  ): Promise<DatabaseAdapter> {
    console.error(`[context-whisper] Initializing environment: ${envName}`);
    const adapter = await createDatabaseAdapter(config);
    console.error(`[context-whisper] Environment '${envName}' ready`);
    return adapter;
  }

  /**
   * Get the default adapter
   */
  async getDefaultAdapter(): Promise<DatabaseAdapter> {
    return this.getAdapter(this.defaultEnvironment);
  }

  /**
   * List all configured environments
   */
  listEnvironments(): string[] {
    return Array.from(this.configs.keys());
  }

  /**
   * Get default environment name
   */
  getDefaultEnvironmentName(): string {
    return this.defaultEnvironment;
  }

  /**
   * Check if environment exists
   */
  hasEnvironment(name: string): boolean {
    return this.configs.has(name);
  }

  /**
   * Get environment config (for display purposes)
   */
  getEnvironmentConfig(name: string): EnvironmentConfig | undefined {
    return this.configs.get(name);
  }

  /**
   * Close all adapters
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.adapters.values()).map(adapter =>
      adapter.close().catch(err => {
        console.error('[context-whisper] Error closing adapter:', err);
      })
    );
    await Promise.all(closePromises);
    this.adapters.clear();
  }

  /**
   * Health check for all initialized adapters
   */
  async healthCheck(): Promise<Map<string, { relational: boolean; vector: boolean }>> {
    const results = new Map<string, { relational: boolean; vector: boolean }>();

    for (const [name, adapter] of this.adapters) {
      try {
        results.set(name, await adapter.isHealthy());
      } catch {
        results.set(name, { relational: false, vector: false });
      }
    }

    return results;
  }
}

/**
 * Create a database manager from config
 */
export function createDatabaseManager(
  configs: Map<string, EnvironmentConfig>,
  defaultEnvironment: string
): DatabaseManager {
  return new DatabaseManager(configs, defaultEnvironment);
}
